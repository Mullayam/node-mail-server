import type { Request, Response } from "express";
import { API_ERROR, HEADER, HEADER_NAME_PATTERN } from "../config/constants";
import { mailConfig } from "../config/mailConfig";
import { isSmtpError } from "../lib/helpers/smtpErrors";
import { Logging } from "../lib/logs";
import { mailWorkers } from "../lib/workers";
import type {
	ComposeAttachment,
	ComposeMimeTask,
} from "../lib/workers/mailTasks";
import { SpamFilteration } from "../server/config/SpamFilteration";
import { env } from "../config/env";
import { submitOutgoing } from "./OutgoingPipeline";

const addressparser = require("nodemailer/lib/addressparser") as (
	value: string,
	options?: { flatten?: boolean },
) => { name: string; address?: string }[];

interface ParsedAddress {
	header: string;
	address: string;
}

class ApiInputError extends Error {}

const EMAIL =
	/^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
const BASE64 = /^[A-Za-z0-9+/\r\n]*={0,2}$/;
const PROTECTED_HEADERS = new Set([
	"from",
	"to",
	"cc",
	"bcc",
	"subject",
	"content-type",
	"content-transfer-encoding",
	"mime-version",
	"dkim-signature",
	HEADER.QUEUE_ID.toLowerCase(),
]);

const fail = (message: string): never => {
	throw new ApiInputError(message);
};

const optionalText = (value: unknown, field: string): string | undefined => {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") fail(API_ERROR.WRONG_TYPE(field, "a string"));
	return value as string;
};

const singleLine = (
	value: string | undefined,
	field: string,
): string | undefined => {
	if (value !== undefined && /[\r\n]/.test(value))
		fail(API_ERROR.WRONG_TYPE(field, "a single line"));
	return value;
};

function parseAddresses(value: unknown, field: string): ParsedAddress[] {
	if (value === undefined || value === null) return [];
	const items = Array.isArray(value) ? value : [value];
	const parsed: ParsedAddress[] = [];
	for (const item of items) {
		const entries =
			typeof item === "string"
				? addressparser(item, { flatten: true })
				: typeof item === "object" &&
						item !== null &&
						typeof (item as { address?: unknown }).address === "string"
					? [
							{
								name: String((item as { name?: unknown }).name ?? ""),
								address: (item as { address: string }).address,
							},
						]
					: fail(
							API_ERROR.WRONG_TYPE(
								field,
								"an address string, { name, address } or a list of them",
							),
						);
		for (const entry of entries) {
			const address = entry.address?.trim() ?? "";
			if (!EMAIL.test(address))
				fail(API_ERROR.INVALID_ADDRESS(field, address || JSON.stringify(item)));
			const name = entry.name.replace(/[\r\n"]+/g, " ").trim();
			parsed.push({
				address,
				header: name ? `"${name}" <${address}>` : address,
			});
		}
	}
	return parsed;
}

function parseHeaders(value: unknown): Record<string, string> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value))
		fail(API_ERROR.INVALID_HEADERS);
	const headers: Record<string, string> = {};
	for (const [name, headerValue] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (
			!HEADER_NAME_PATTERN.test(name) ||
			PROTECTED_HEADERS.has(name.toLowerCase()) ||
			typeof headerValue !== "string" ||
			/[\r\n]/.test(headerValue)
		) {
			fail(API_ERROR.INVALID_HEADERS);
		}
		headers[name] = headerValue as string;
	}
	return headers;
}

function parseAttachments(value: unknown): ComposeAttachment[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value))
		fail(API_ERROR.WRONG_TYPE("attachments", "a list"));
	return (value as unknown[]).map((item, index) => {
		const attachment = item as Partial<ComposeAttachment> | null;
		if (
			!attachment ||
			typeof attachment.filename !== "string" ||
			!attachment.filename ||
			typeof attachment.content !== "string" ||
			!BASE64.test(attachment.content)
		) {
			fail(API_ERROR.INVALID_ATTACHMENT(index));
		}
		return {
			filename: (attachment as ComposeAttachment).filename,
			content: (attachment as ComposeAttachment).content,
			contentType: singleLine(
				optionalText(
					attachment?.contentType,
					`attachments[${index}].contentType`,
				),
				"contentType",
			),
			cid: singleLine(
				optionalText(attachment?.cid, `attachments[${index}].cid`),
				"cid",
			),
		};
	});
}

function buildTask(body: Record<string, unknown>): {
	task: ComposeMimeTask;
	sender: string;
	recipients: string[];
} {
	const from = parseAddresses(body.from, "from");
	if (from.length !== 1) fail(API_ERROR.MISSING_FROM);
	const to = parseAddresses(body.to, "to");
	const cc = parseAddresses(body.cc, "cc");
	const bcc = parseAddresses(body.bcc, "bcc");
	const recipients = [...new Set([...to, ...cc, ...bcc].map((a) => a.address))];
	if (!recipients.length) fail(API_ERROR.NO_RECIPIENTS);
	const { maxRecipients } = mailConfig.get().outgoing;
	if (recipients.length > maxRecipients)
		fail(API_ERROR.TOO_MANY_RECIPIENTS(maxRecipients));

	const text = optionalText(body.text, "text");
	const html = optionalText(body.html, "html");
	if (text === undefined && html === undefined) fail(API_ERROR.NO_CONTENT);

	return {
		sender: from[0].address,
		recipients,
		task: {
			from: from[0].header,
			to: to.map((a) => a.header),
			cc: cc.map((a) => a.header),
			bcc: bcc.map((a) => a.header),
			replyTo: parseAddresses(body.replyTo, "replyTo").map((a) => a.header),
			subject: singleLine(optionalText(body.subject, "subject"), "subject"),
			text,
			html,
			headers: parseHeaders(body.headers),
			inReplyTo: singleLine(
				optionalText(body.inReplyTo, "inReplyTo"),
				"inReplyTo",
			),
			references: singleLine(
				optionalText(body.references, "references"),
				"references",
			),
			attachments: parseAttachments(body.attachments),
		},
	};
}

class JsonMailHandler {
	async HandleSend(req: Request, res: Response): Promise<void> {
		try {
			const { rateLimit, maxMessageSizeBytes } = mailConfig.get().outgoing;
			if (rateLimit.enabled) {
				await SpamFilteration.checkBlackListIp(
					req.ip ?? "unknown",
					rateLimit.maxConnectionsPerMinute ?? env.server.maxEmailsPerMinute,
				);
			}
			if (
				!req.body ||
				typeof req.body !== "object" ||
				Array.isArray(req.body)
			) {
				fail(API_ERROR.INVALID_BODY);
			}
			const { task, sender, recipients } = buildTask(
				req.body as Record<string, unknown>,
			);
			const raw = await mailWorkers.composeMime(task);
			if (raw.length > maxMessageSizeBytes) {
				res
					.status(413)
					.json({ error: API_ERROR.TOO_LARGE(maxMessageSizeBytes) });
				return;
			}
			const id = await submitOutgoing({
				sender,
				recipients,
				raw,
				source: "api",
			});
			res.status(202).json({ id, from: sender, recipients });
		} catch (error) {
			if (error instanceof ApiInputError) {
				res.status(400).json({ error: error.message });
				return;
			}
			if (isSmtpError(error)) {
				res
					.status(error.responseCode === 421 ? 429 : 503)
					.json({ error: error.message });
				return;
			}
			Logging.dev(
				`JSON send API failed: ${error instanceof Error ? error.stack : String(error)}`,
				"error",
			);
			res.status(500).json({ error: API_ERROR.INTERNAL });
		}
	}
}
export const NewJsonMailHandler = new JsonMailHandler();
