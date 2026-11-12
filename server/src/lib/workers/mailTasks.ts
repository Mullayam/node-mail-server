import { createHash } from "crypto";
import { readFile } from "fs/promises";
import nodemailer from "nodemailer";
import { env } from "../../config/env";
import {
	loadOpenPgp,
	type OpenPgpPrivateKey,
	type OpenPgpPublicKey,
} from "../../server/config/encryption/openpgp";

export interface AuthenticateTask {
	raw: Uint8Array;
	ip: string;
	helo?: string;
	mta: string;
	sender: string;
	seal: boolean;
}

export interface AuthSummary {
	headers: string;
	dmarc: {
		result: string;
		domain: string;
		policy?: string;
		pct: number;
	} | null;
	spf: string | null;
	spfDomain: string | null;
	dkim: string[];
	arc: string | null;
	sealError?: string;
}

export interface DkimSignTask {
	raw: Uint8Array;
	dkim: { domainName: string; keySelector: string; privateKey: string };
	envelope: { from: string; to: string[] };
}

export interface PgpEncryptTask {
	text: string;
	publicKey: string;
	privateKey: string;
	passphrase: string;
}

export interface ParseDsnTask {
	raw: Uint8Array;
	maxHeaderBytes: number;
}

export interface DsnRecipient {
	recipient: string;
	action: string;
	status: string;
	diagnostic?: string;
	remoteMta?: string;
}

export interface ParsedDsn {
	kind: "dsn" | "feedback" | "auto-reply" | "unknown";
	reportingMta?: string;
	recipients: DsnRecipient[];
	queueId?: string;
	messageId?: string;
	originalHeaders?: string;
	subject?: string;
}

interface ArcSealConfig {
	signingDomain: string;
	selector: string;
	privateKey: string;
}

const toBuffer = (data: Uint8Array): Buffer =>
	Buffer.isBuffer(data)
		? data
		: Buffer.from(data.buffer, data.byteOffset, data.byteLength);

let arcSeal:
	| Promise<{ config: ArcSealConfig | null; error?: string }>
	| undefined;

const loadArcSealConfig = () =>
	(arcSeal ??= (async () => {
		const { privateKeyPath: keyPath, signingDomain, selector } = env.arc;
		if (!keyPath || !signingDomain) return { config: null };
		try {
			const privateKey = await readFile(keyPath, "utf8");
			return { config: { signingDomain, selector, privateKey } };
		} catch (error) {
			return {
				config: null,
				error: `ARC sealing disabled, cannot read ${keyPath}: ${(error as Error).message}`,
			};
		}
	})());

async function authenticate(task: AuthenticateTask): Promise<AuthSummary> {
	const { authenticate: run } = require("mailauth");
	const arc = task.seal ? await loadArcSealConfig() : { config: null };
	const result = await run(toBuffer(task.raw), {
		ip: task.ip,
		helo: task.helo,
		mta: task.mta,
		sender: task.sender,
		disableBimi: true,
		...(arc.config ? { seal: arc.config } : {}),
	});
	return {
		headers: result.headers,
		dmarc: result.dmarc
			? {
					result: result.dmarc.status?.result,
					domain: result.dmarc.domain,
					policy: result.dmarc.policy,
					pct: Number(result.dmarc.pct ?? 100),
				}
			: null,
		spf: result.spf?.status?.result ?? null,
		spfDomain: result.spf?.domain ?? null,
		dkim: (result.dkim?.results ?? []).map(
			(r: { status?: { result?: string } }) => r.status?.result ?? "none",
		),
		arc: result.arc?.status?.result ?? null,
		sealError: "error" in arc ? arc.error : undefined,
	};
}

async function dkimSign(task: DkimSignTask): Promise<Uint8Array> {
	const transporter = nodemailer.createTransport({
		streamTransport: true,
		buffer: true,
	});
	try {
		const info = await transporter.sendMail({
			raw: toBuffer(task.raw),
			envelope: task.envelope,
			dkim: task.dkim,
		});
		return info.message as Buffer;
	} finally {
		transporter.close();
	}
}

const PGP_KEY_CACHE_SIZE = 8;
const pgpKeyCache = new Map<
	string,
	Promise<{ publicKey: OpenPgpPublicKey; privateKey: OpenPgpPrivateKey }>
>();

async function pgpEncrypt(task: PgpEncryptTask): Promise<string> {
	const openpgp = await loadOpenPgp();
	const cacheKey = createHash("sha256")
		.update(task.publicKey)
		.update("\0")
		.update(task.privateKey)
		.update("\0")
		.update(task.passphrase)
		.digest("hex");

	let keys = pgpKeyCache.get(cacheKey);
	if (!keys) {
		keys = (async () => ({
			publicKey: await openpgp.readKey({ armoredKey: task.publicKey }),
			privateKey: await openpgp.decryptKey({
				privateKey: await openpgp.readPrivateKey({
					armoredKey: task.privateKey,
				}),
				passphrase: task.passphrase,
			}),
		}))();
		keys.catch(() => pgpKeyCache.delete(cacheKey));
		if (pgpKeyCache.size >= PGP_KEY_CACHE_SIZE) {
			const oldest = pgpKeyCache.keys().next();
			if (!oldest.done) pgpKeyCache.delete(oldest.value);
		}
		pgpKeyCache.set(cacheKey, keys);
	}

	const { publicKey, privateKey } = await keys;
	return openpgp.encrypt({
		message: await openpgp.createMessage({ text: task.text }),
		encryptionKeys: publicKey,
		signingKeys: privateKey,
	}) as Promise<string>;
}

const parseFieldGroups = (text: string): Record<string, string>[] =>
	text
		.replace(/\r\n/g, "\n")
		.split(/\n[ \t]*\n/)
		.map((block) => {
			const fields: Record<string, string> = {};
			for (const line of block.replace(/\n[ \t]+/g, " ").split("\n")) {
				const colon = line.indexOf(":");
				if (colon > 0)
					fields[line.slice(0, colon).trim().toLowerCase()] = line
						.slice(colon + 1)
						.trim();
			}
			return fields;
		})
		.filter((fields) => Object.keys(fields).length > 0);

const addressOf = (value?: string): string =>
	(value ?? "")
		.replace(/^[^;]*;\s*/, "")
		.replace(/^<|>$/g, "")
		.trim();

const typedValue = (value?: string): string | undefined =>
	value ? value.replace(/^[^;]*;\s*/, "").trim() : undefined;

const escapeRegExp = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const decodeQuotedPrintable = (text: string): string =>
	Buffer.from(
		text
			.replace(/=\r?\n/g, "")
			.replace(/=([0-9A-F]{2})/gi, (_m, hex: string) =>
				String.fromCharCode(Number.parseInt(hex, 16)),
			),
		"latin1",
	).toString("utf8");

function findMimePart(raw: string, types: string[]): string | undefined {
	const header = new RegExp(
		`(?:^|\\n)Content-Type:[ \\t]*(?:${types.map(escapeRegExp).join("|")})(?=[\\s;]|$)`,
		"i",
	);
	const match = header.exec(raw);
	if (!match) return undefined;

	const headerStart = match.index;
	const separator = /\r?\n\r?\n/g;
	separator.lastIndex = headerStart + match[0].length;
	const blank = separator.exec(raw);
	if (!blank) return undefined;
	const partHeaders = raw.slice(headerStart, blank.index);
	const bodyStart = blank.index + blank[0].length;

	const boundaryLineStart = raw.lastIndexOf("\n--", headerStart);
	const boundary =
		boundaryLineStart === -1
			? undefined
			: raw
					.slice(boundaryLineStart + 3)
					.split(/\r?\n/, 1)[0]
					.trim();
	const bodyEnd = boundary ? raw.indexOf(`\n--${boundary}`, bodyStart) : -1;
	const body = raw
		.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd)
		.replace(/\r$/, "");

	const encoding = /Content-Transfer-Encoding:[ \t]*([\w-]+)/i
		.exec(partHeaders)?.[1]
		?.toLowerCase();
	if (encoding === "base64")
		return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
	if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
	return body;
}

async function parseDsn(task: ParseDsnTask): Promise<ParsedDsn> {
	const raw = toBuffer(task.raw).toString("utf8");
	const topHeaders = headerBlock(raw, Number.MAX_SAFE_INTEGER).replace(
		/\r?\n[ \t]+/g,
		" ",
	);
	const topHeader = (name: string) =>
		new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(topHeaders)?.[1]?.trim();
	const reportType = /report-type\s*=\s*"?([\w-]+)/i
		.exec(topHeader("Content-Type") ?? "")?.[1]
		?.toLowerCase();

	const original = findMimePart(raw, [
		"text/rfc822-headers",
		"message/rfc822",
		"message/rfc822-headers",
		"message/global-headers",
	]);
	const originalHeaders = original
		? headerBlock(original, task.maxHeaderBytes)
		: undefined;
	const base = {
		queueId: originalHeaders
			? /^X-AE-Queue-Id:\s*(\S+)/im.exec(originalHeaders)?.[1]
			: undefined,
		messageId: originalHeaders
			? /^Message-ID:\s*(\S+)/im.exec(originalHeaders)?.[1]
			: undefined,
		originalHeaders,
		subject: topHeader("Subject"),
	};

	const feedbackPart = findMimePart(raw, ["message/feedback-report"]);
	if (reportType === "feedback-report" || feedbackPart) {
		const [fields = {}] = parseFieldGroups(feedbackPart ?? "");
		const recipient =
			addressOf(fields["original-rcpt-to"]) ||
			addressOf(/^To:\s*(.+)$/im.exec(originalHeaders ?? "")?.[1]);
		return {
			kind: "feedback",
			recipients: recipient
				? [
						{
							recipient,
							action: "complaint",
							status: "5.7.1",
							diagnostic: fields["feedback-type"],
						},
					]
				: [],
			...base,
		};
	}

	const statusPart = findMimePart(raw, [
		"message/delivery-status",
		"message/global-delivery-status",
	]);
	if (statusPart) {
		const [perMessage = {}, ...groups] = parseFieldGroups(statusPart);
		return {
			kind: "dsn",
			reportingMta: typedValue(perMessage["reporting-mta"]),
			recipients: groups
				.filter((g) => g["final-recipient"] || g["original-recipient"])
				.map((g) => ({
					recipient: addressOf(g["final-recipient"] || g["original-recipient"]),
					action: (g.action ?? "failed").toLowerCase(),
					status: (g.status ?? "5.0.0").split(/\s/)[0],
					diagnostic: typedValue(g["diagnostic-code"]),
					remoteMta: typedValue(g["remote-mta"]),
				})),
			...base,
		};
	}

	const autoSubmitted = (topHeader("Auto-Submitted") ?? "").toLowerCase();
	if (
		autoSubmitted.startsWith("auto-replied") ||
		topHeader("X-Autoreply") !== undefined
	) {
		return { kind: "auto-reply", recipients: [], ...base };
	}
	return { kind: "unknown", recipients: [], ...base };
}

function headerBlock(text: string, maxBytes: number): string {
	const end = text.search(/\r?\n\r?\n/);
	const headers = end === -1 ? text : text.slice(0, end);
	return headers.length > maxBytes ? headers.slice(0, maxBytes) : headers;
}

export const MAIL_TASKS = {
	authenticate,
	dkimSign,
	pgpEncrypt,
	parseDsn,
} as const;
export type MailTaskName = keyof typeof MAIL_TASKS;
export type MailTaskPayload<K extends MailTaskName> = Parameters<
	(typeof MAIL_TASKS)[K]
>[0];
export type MailTaskResult<K extends MailTaskName> = Awaited<
	ReturnType<(typeof MAIL_TASKS)[K]>
>;
