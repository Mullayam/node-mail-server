import { randomUUID } from "crypto";
import { MAIL_LIMITS } from "../../config/constants";

export interface DsnRecipientReport {
	recipient: string;
	action: "failed" | "delayed";
	status: string;
	diagnostic?: string;
	remoteMta?: string;
}

export interface DsnInput {
	reportingMta: string;
	originalSender: string;
	recipients: DsnRecipientReport[];
	queueId?: string;
	arrivalDate?: Date;
	originalHeaders?: string;
}

const DSN_TEXT = {
	FAILED_SUBJECT: "Undelivered Mail Returned to Sender",
	DELAYED_SUBJECT: "Delayed Mail (still being retried)",
	FAILED_INTRO:
		"Your message could not be delivered to one or more recipients. This is a permanent error.",
	DELAYED_INTRO:
		"Your message has not been delivered yet. The server will keep trying.",
} as const;

const oneLine = (
	value: string,
	max: number = MAIL_LIMITS.MAX_DIAGNOSTIC_LENGTH,
) =>
	value
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);

export function buildDsn(input: DsnInput): Buffer {
	const boundary = `dsn-${randomUUID()}`;
	const failed = input.recipients.some((r) => r.action === "failed");
	const host = oneLine(input.reportingMta, 255);

	const summary = input.recipients.map(
		(r) =>
			`  <${r.recipient}>: ${r.status}${r.diagnostic ? ` ${oneLine(r.diagnostic)}` : ""}`,
	);

	const perRecipient = input.recipients.flatMap((r) => [
		`Final-Recipient: rfc822; ${r.recipient}`,
		`Action: ${r.action}`,
		`Status: ${r.status}`,
		...(r.remoteMta ? [`Remote-MTA: dns; ${oneLine(r.remoteMta, 255)}`] : []),
		...(r.diagnostic
			? [`Diagnostic-Code: smtp; ${oneLine(r.diagnostic)}`]
			: []),
		"",
	]);

	const lines = [
		`From: Mail Delivery System <MAILER-DAEMON@${host}>`,
		`To: <${input.originalSender}>`,
		`Subject: ${failed ? DSN_TEXT.FAILED_SUBJECT : DSN_TEXT.DELAYED_SUBJECT}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: <${randomUUID()}@${host}>`,
		"Auto-Submitted: auto-replied",
		"MIME-Version: 1.0",
		`Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
		"",
		`--${boundary}`,
		"Content-Type: text/plain; charset=utf-8",
		"",
		failed ? DSN_TEXT.FAILED_INTRO : DSN_TEXT.DELAYED_INTRO,
		"",
		...summary,
		"",
		`--${boundary}`,
		"Content-Type: message/delivery-status",
		"",
		`Reporting-MTA: dns; ${host}`,
		...(input.queueId ? [`X-AE-Queue-Id: ${input.queueId}`] : []),
		...(input.arrivalDate
			? [`Arrival-Date: ${input.arrivalDate.toUTCString()}`]
			: []),
		"",
		...perRecipient,
		...(input.originalHeaders
			? [
					`--${boundary}`,
					"Content-Type: text/rfc822-headers",
					"",
					input.originalHeaders.replace(/\r?\n/g, "\r\n").trimEnd(),
					"",
				]
			: []),
		`--${boundary}--`,
		"",
	];
	return Buffer.from(lines.join("\r\n"), "utf8");
}
