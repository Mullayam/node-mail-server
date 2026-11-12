import dns from "dns/promises";
import { isIP } from "net";
import type { SMTPServerAddress, SMTPServerSession } from "smtp-server";
import {
	CACHE,
	HEADER,
	POLICY_ACTION,
	POLICY_FLAG,
	type PolicyAction,
	type SmtpMessageKey,
} from "../config/constants";
import { mailConfig } from "../config/mailConfig";
import {
	type SmtpError,
	type SmtpMessageParams,
	smtpReply,
} from "../config/smtpMessages";
import { normalizeIp } from "../lib/helpers/RawMessage";
import { TtlCache } from "../lib/helpers/TtlCache";
import type { AuthSummary } from "../lib/workers/mailTasks";
import { DNSChecker } from "../server/config/DnsChecker";

type ReverseDnsResult = "pass" | "fail" | "temperror";

interface SessionFlags {
	connection: string[];
	transaction: string[];
}

interface Outcome {
	error?: SmtpError;
	flag?: string;
}

export interface AuthenticationVerdict {
	error?: SmtpError;
	flags: string[];
}

const DISPOSABLE_SENDER = /^[^\s@]+\.temp@[^\s@]+\.[^\s@]+$/;
const NOT_FOUND_CODES = new Set(["ENODATA", "ENOTFOUND"]);
const MAX_PTR_NAMES = 5;

const sessionFlags = new WeakMap<SMTPServerSession, SessionFlags>();
const reverseDnsCache = new TtlCache<string, ReverseDnsResult>(
	CACHE.MAX_ENTRIES,
	CACHE.REVERSE_DNS_TTL_MS,
);

const flagsOf = (session: SMTPServerSession): SessionFlags => {
	let flags = sessionFlags.get(session);
	if (!flags) {
		flags = { connection: [], transaction: [] };
		sessionFlags.set(session, flags);
	}
	return flags;
};

const decide = (
	action: PolicyAction,
	flag: string,
	reject: SmtpMessageKey,
	tempfail: SmtpMessageKey,
	params?: SmtpMessageParams,
): Outcome => {
	switch (action) {
		case POLICY_ACTION.REJECT:
			return { error: smtpReply(reject, params).toError(), flag };
		case POLICY_ACTION.TEMPFAIL:
			return { error: smtpReply(tempfail, params).toError(), flag };
		case POLICY_ACTION.TAG:
			return { flag };
		case POLICY_ACTION.ACCEPT:
			return {};
	}
};

const softenTransient = (action: PolicyAction): PolicyAction =>
	action === POLICY_ACTION.REJECT ? POLICY_ACTION.TEMPFAIL : action;

async function lookupReverseDns(
	ip: string,
	requireForwardConfirmed: boolean,
): Promise<ReverseDnsResult> {
	const key = `${ip}|${requireForwardConfirmed}`;
	const cached = reverseDnsCache.get(key);
	if (cached) return cached;

	let result: ReverseDnsResult;
	try {
		const names = await dns.reverse(ip);
		if (!names.length) result = "fail";
		else if (!requireForwardConfirmed) result = "pass";
		else {
			const resolve = isIP(ip) === 6 ? dns.resolve6 : dns.resolve4;
			const addresses = await Promise.all(
				names
					.slice(0, MAX_PTR_NAMES)
					.map((name) => resolve(name).catch(() => [] as string[])),
			);
			result = addresses.some((list) => list.includes(ip)) ? "pass" : "fail";
		}
	} catch (error) {
		result = NOT_FOUND_CODES.has((error as NodeJS.ErrnoException).code ?? "")
			? "fail"
			: "temperror";
	}
	if (result !== "temperror") reverseDnsCache.set(key, result);
	return result;
}

const isTrusted = (session: SMTPServerSession) =>
	mailConfig.isTrustedAddress(normalizeIp(session.remoteAddress));

export const IncomingPolicy = {
	isTrusted,

	async checkConnection(
		session: SMTPServerSession,
	): Promise<SmtpError | undefined> {
		const flags = flagsOf(session);
		flags.connection = [];
		const check = mailConfig.get().incoming.checks.reverseDns;
		if (!check.enabled || isTrusted(session)) return undefined;

		const ip = normalizeIp(session.remoteAddress);
		const result = await lookupReverseDns(ip, check.requireForwardConfirmed);
		if (result === "pass") return undefined;

		const action =
			result === "temperror" ? softenTransient(check.onFail) : check.onFail;
		const outcome = decide(
			action,
			`${POLICY_FLAG.REVERSE_DNS}=${result}`,
			"REVERSE_DNS_FAILED",
			"REVERSE_DNS_TEMPFAIL",
			{
				ip,
			},
		);
		if (outcome.flag) flags.connection.push(outcome.flag);
		return outcome.error;
	},

	async checkSender(
		address: SMTPServerAddress,
		session: SMTPServerSession,
	): Promise<SmtpError | undefined> {
		const flags = flagsOf(session);
		flags.transaction = [];
		const { checks } = mailConfig.get().incoming;
		const sender = address.address;

		if (checks.disposableSender.enabled && DISPOSABLE_SENDER.test(sender)) {
			return smtpReply("DISPOSABLE_SENDER").toError();
		}
		if (!sender || isTrusted(session) || !checks.senderDomain.enabled)
			return undefined;

		const domain = (sender.split("@")[1] ?? "").toLowerCase();
		if (!domain) return smtpReply("INVALID_SENDER").toError();

		const records = await DNSChecker.resolveRecords(domain);
		const canReceive =
			records.mxRecords.length > 0 ||
			records.aRecords.length > 0 ||
			records.aaaaRecords.length > 0;
		if (canReceive) return undefined;

		const action = records.temporaryFailure
			? softenTransient(checks.senderDomain.onUnroutable)
			: checks.senderDomain.onUnroutable;
		const tempfailKey: SmtpMessageKey = records.temporaryFailure
			? "DNS_TEMPORARY_FAILURE"
			: "SENDER_DOMAIN_TEMPFAIL";
		const outcome = decide(
			action,
			`${POLICY_FLAG.SENDER_DOMAIN}=${records.temporaryFailure ? "temperror" : "unroutable"}`,
			"SENDER_DOMAIN_UNROUTABLE",
			tempfailKey,
			{ domain },
		);
		if (outcome.flag) flags.transaction.push(outcome.flag);
		return outcome.error;
	},

	checkRecipient(
		address: SMTPServerAddress,
		session: SMTPServerSession,
		isBounceAddress: boolean,
	): SmtpError | undefined {
		const { maxRecipients, recipients } = mailConfig.get().incoming;
		if (session.envelope.rcptTo.length >= maxRecipients) {
			return smtpReply("TOO_MANY_RECIPIENTS", { max: maxRecipients }).toError();
		}
		if (isBounceAddress) return undefined;

		const recipient = address.address;
		const lower = recipient.toLowerCase();
		const domain = lower.split("@")[1] ?? "";
		if (
			recipients.acceptedDomains.length &&
			!recipients.acceptedDomains.some((d) => d.toLowerCase() === domain)
		) {
			return smtpReply("RELAY_DENIED", { recipient }).toError();
		}
		if (
			recipients.knownRecipients.length &&
			!recipients.knownRecipients.some((r) => r.toLowerCase() === lower)
		) {
			return smtpReply("USER_NOT_FOUND", { recipient }).toError();
		}
		return undefined;
	},

	evaluateAuthentication(
		auth: AuthSummary,
		session: SMTPServerSession,
		senderDomain: string,
	): AuthenticationVerdict {
		const flags = flagsOf(session);
		const collected = [...flags.connection, ...flags.transaction];
		if (isTrusted(session)) return { flags: collected };

		const { checks } = mailConfig.get().incoming;
		const outcomes: Outcome[] = [];

		const dmarc = auth.dmarc;
		if (dmarc?.result === "fail") {
			const applies =
				!checks.dmarc.honorPercentage || Math.random() * 100 < dmarc.pct;
			const action =
				dmarc.policy === "reject"
					? checks.dmarc.onReject
					: dmarc.policy === "quarantine"
						? checks.dmarc.onQuarantine
						: null;
			if (action && applies) {
				outcomes.push(
					decide(
						action,
						`${POLICY_FLAG.DMARC}=fail`,
						"DMARC_REJECT",
						"DMARC_TEMPFAIL",
						{ domain: dmarc.domain },
					),
				);
			}
		} else if (dmarc?.result === "temperror") {
			outcomes.push(
				decide(
					softenTransient(checks.dmarc.onReject),
					`${POLICY_FLAG.DMARC}=temperror`,
					"DMARC_REJECT",
					"DMARC_TEMPFAIL",
					{
						domain: dmarc.domain,
					},
				),
			);
		}

		const spf = auth.spf ?? "none";
		const spfAction =
			spf === "fail" || spf === "permerror"
				? checks.spf.onFail
				: spf === "softfail"
					? checks.spf.onSoftFail
					: spf === "none"
						? checks.spf.onNone
						: spf === "temperror"
							? checks.spf.onTempError
							: POLICY_ACTION.ACCEPT;
		outcomes.push(
			decide(
				spfAction,
				`${POLICY_FLAG.SPF}=${spf}`,
				"SPF_FAILED",
				"SPF_TEMPFAIL",
				{
					domain: auth.spfDomain ?? senderDomain,
				},
			),
		);

		if (!auth.dkim.includes("pass")) {
			const none =
				auth.dkim.length === 0 ||
				auth.dkim.every((result) => result === "none");
			outcomes.push(
				decide(
					none ? checks.dkim.onNone : checks.dkim.onFail,
					`${POLICY_FLAG.DKIM}=${none ? "none" : "fail"}`,
					"DKIM_FAILED",
					"DKIM_TEMPFAIL",
				),
			);
		}

		const error = outcomes
			.map((outcome) => outcome.error)
			.filter((e): e is SmtpError => Boolean(e))
			.sort((a, b) => b.responseCode - a.responseCode)[0];
		return {
			error,
			flags: [
				...collected,
				...outcomes.flatMap((o) => (o.flag ? [o.flag] : [])),
			],
		};
	},

	policyHeaders(flags: string[]): string {
		if (!flags.length) return "";
		return `${HEADER.SPAM_FLAG}: YES\r\n${HEADER.POLICY_FLAGS}: ${flags.join("; ")}\r\n`;
	},
};
