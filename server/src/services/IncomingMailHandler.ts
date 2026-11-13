import type {
	SMTPServerAddress,
	SMTPServerDataStream,
	SMTPServerSession,
} from "smtp-server";
import { HEADER } from "../config/constants";
import { env } from "../config/env";
import { mailConfig } from "../config/mailConfig";
import { smtpReply } from "../config/smtpMessages";
import { MiscellaneousHelper } from "../lib/helpers";
import {
	collectMessage,
	normalizeIp,
	RawMessage,
} from "../lib/helpers/RawMessage";
import { toSmtpError } from "../lib/helpers/smtpErrors";
import { Logging } from "../lib/logs";
import { mailWorkers } from "../lib/workers";
import { RFC5322MailComposer } from "../server/config/MailComposer";
import { getMailRuntime } from "../server/mta/runtime";
import { DsnProcessor } from "./bounce/DsnProcessor";
import { ImapDelivery, type ImapDeliveryResult } from "./ImapDelivery";
import { IncomingPolicy } from "./IncomingPolicy";

let pgpWarningShown = false;
let arcWarningShown = false;

/**
 * Delivers to the IMAP server and decides the SMTP reply.
 * Returns null to accept the message, or the error to reply with:
 * - at least one mailbox got it: accept (other failures are logged)
 * - IMAP unreachable or a temporary refusal: 450, so the sender retries
 * - every recipient refused permanently: 552 (over quota) or 550 (no mailbox)
 */
async function storeInImap(
	raw: Buffer,
	sender: string,
	recipients: string[],
): Promise<Error | null> {
	let result: ImapDeliveryResult;
	try {
		result = await ImapDelivery.deliver(raw, sender, recipients);
	} catch (error) {
		Logging.dev(
			`IMAP delivery failed, asking the sender to retry: ${error}`,
			"error",
		);
		return smtpReply("MAILBOX_BUSY", { recipient: recipients[0] }).toError();
	}
	for (const f of result.failed) {
		Logging.dev(
			`IMAP delivery to ${f.recipient} failed (${f.code}): ${f.message}`,
			f.permanent ? "notice" : "error",
		);
	}
	if (result.delivered.length) {
		return null;
	}
	const temporary = result.failed.find((f) => !f.permanent);
	if (temporary) {
		return smtpReply("MAILBOX_BUSY", {
			recipient: temporary.recipient,
		}).toError();
	}
	const first = result.failed[0];
	const recipient = first?.recipient || recipients[0];
	return first?.code === 552
		? smtpReply("MAILBOX_FULL", { recipient }).toError()
		: smtpReply("USER_NOT_FOUND", { recipient }).toError();
}

class IncomingMailHandler {
	async HandleMailFrom(
		address: SMTPServerAddress,
		session: SMTPServerSession,
		callback: (err?: Error | null | undefined) => void,
	): Promise<void> {
		try {
			const rejection = await IncomingPolicy.checkSender(address, session);
			if (rejection) {
				return callback(rejection);
			}
			return callback(); // Accept the address
		} catch (error) {
			return callback(toSmtpError(error, "MAIL FROM failed"));
		}
	}
	async HandleRcptTo(
		address: SMTPServerAddress,
		session: SMTPServerSession,
		callback: (err?: Error | null | undefined) => void,
	): Promise<void> {
		try {
			/** NOTE :
			 * Check the RCPT TO address is exist or not in your System
			 * Check the DNS records like MX, SPF, DMARC, TXT of the Sender and validate them and based on them allow or reject the email
			 * Spam Detection
			 * Store All Logs in Database, Redis etc
			 */

			const isBounce = getMailRuntime().bounces.isBounceAddress(
				address.address,
			);
			const rejection = IncomingPolicy.checkRecipient(
				address,
				session,
				isBounce,
			);
			if (rejection) {
				return callback(rejection);
			}

			const mailFrom = session.envelope.mailFrom
				? session.envelope.mailFrom.address
				: "";
			const receiverMail =
				MiscellaneousHelper.extractEmail(address.address) || address.address;
			Logging.dev(
				`Incoming mail accepted localPort = ${session.localPort}, remoteIp = ${session.remoteAddress}, remotePort = ${session.remotePort}, from = ${mailFrom || "<>"} to ${receiverMail}`,
			);

			return callback(null);
		} catch (error) {
			return callback(toSmtpError(error, "RCPT TO failed"));
		}
	}
	async HandleNewMail(
		stream: SMTPServerDataStream,
		session: SMTPServerSession,
		callback: (err?: Error | null | undefined, message?: string) => void,
	): Promise<void> {
		try {
			const config = mailConfig.get().incoming;
			const original = await collectMessage(stream, config.maxMessageSizeBytes);
			if (!original) {
				return callback(
					smtpReply("MESSAGE_TOO_LARGE", {
						maxSize: config.maxMessageSizeBytes,
					}).toError(),
				);
			}

			const { bounces } = getMailRuntime();
			const recipients = session.envelope.rcptTo.map((r) => r.address);
			const bounceRecipients = recipients.filter((r) =>
				bounces.isBounceAddress(r),
			);
			if (bounceRecipients.length) {
				await bounces.handleIncomingBounce(original, bounceRecipients);
				if (bounceRecipients.length === recipients.length) {
					return callback(null, smtpReply("BOUNCE_ACCEPTED").text);
				}
			} else if (DsnProcessor.isDeliveryReport(original)) {
				await bounces
					.handleDeliveryReport(original)
					.catch((error) =>
						Logging.dev(`Delivery report processing failed: ${error}`, "error"),
					);
			}

			const sender = session.envelope.mailFrom
				? session.envelope.mailFrom.address
				: "";
			const receivingHost = env.server.incomingHost;
			const auth = await mailWorkers.authenticate({
				raw: original,
				ip: normalizeIp(session.remoteAddress),
				helo: session.hostNameAppearsAs,
				mta: receivingHost,
				sender,
				seal: config.arcSeal,
			});
			if (auth.sealError && !arcWarningShown) {
				arcWarningShown = true;
				Logging.dev(auth.sealError, "error");
			}

			const verdict = IncomingPolicy.evaluateAuthentication(
				auth,
				session,
				(sender.split("@")[1] || "").toLowerCase(),
			);
			if (verdict.error) {
				return callback(verdict.error);
			}

			const cleaned = RawMessage.stripHeaders(
				original,
				(name, value) =>
					/^x-ae-/i.test(name) ||
					(name.toLowerCase() === "authentication-results" &&
						value.trim().toLowerCase().startsWith(receivingHost.toLowerCase())),
			);
			const newHeaders = config.customHeaders.enabled
				? RFC5322MailComposer.createRfc822Headers({
						[HEADER.RECEIPT_TIME]: `${Date.now()}`,
						...config.customHeaders.headers,
					})
				: "";
			const rawEmail = RawMessage.prependHeaders(
				cleaned,
				auth.headers + IncomingPolicy.policyHeaders(verdict.flags) + newHeaders,
			);

			// Encrypt and store
			const { privateKey, publicKey, passphrase } = env.pgp;
			if (config.pgpEncryption && privateKey && publicKey) {
				const encrypted = await mailWorkers.pgpEncrypt({
					text: rawEmail.toString(),
					privateKey,
					publicKey,
					passphrase,
				});
				// Store the encrypted message in database or forward as needed
				Logging.dev(
					`Encrypted incoming message from ${sender || "<>"}: ${Buffer.byteLength(encrypted)} bytes`,
				);
			} else if (config.pgpEncryption && !pgpWarningShown) {
				pgpWarningShown = true;
				Logging.dev(
					"PGP keys are not configured, incoming mail is not encrypted at rest",
					"notice",
				);
			}
			// Store: hand the checked message to the IMAP server over LMTP, so it
			// shows up in the recipients' mailboxes at once (when IMAP_LMTP_HOST is set).
			const localRecipients = recipients.filter(
				(r) => !bounceRecipients.includes(r),
			);
			if (ImapDelivery.enabled && localRecipients.length) {
				const refused = await storeInImap(rawEmail, sender, localRecipients);
				if (refused) {
					return callback(refused);
				}
			}

			/** NOTE :
			 * CHECK FOR TXT RECORD i.e DKIM
			 *  Check for DKIM signature
			 *  Extract DKIM-Signature Header from the Email.
			 *  new SpamFilteration().verifyDkimSignature(parsedEmailData.headerLines, parsedEmailData.dkimSignature);
			 *  Map HeaderLines according to requirement of function
			 *  Verify the DKIM signature and reject the email if not valid, forward to spam folder
			 */

			// Do something with the parsed email data (e.g., save to database,  etc.)
			// Spam Filtering
			// Forwarding to Other Mail Servers
			// Auto-Responders
			// Webhooks
			// Real-time Notifications
			// Integration with Other Services
			// Archiving
			// Backup
			// Email Parsing and Extraction
			// Custom Business Logic
			// Email Categorization and Tagging
			// User Preferences and Settings
			// Throttling and Rate Limiting
			// Security Measures (e.g., Virus Scanning, Malware Detection)
			// Compliance (e.g., GDPR, HIPAA)
			// Multi-Tenancy Support
			// API Integration for Developers
			// UI for Managing Emails and Settings
			// Reporting and Analytics
			// Scheduling (e.g., Delayed Delivery)
			// Load Balancing and Scalability
			// Storing in Database
			// Storing Attachments in Cloud Storage or Local Storage
			// Notifications
			// Logging
			// Monitoring
			// Alerting
			// Testing and Debugging Tools
			// Documentation for Users and Developers
			// Custom Headers

			return callback(null, smtpReply("MESSAGE_ACCEPTED").text);
		} catch (error) {
			return callback(toSmtpError(error, "Incoming message failed"));
		}
	}
}
export const NewMailHandler = new IncomingMailHandler();
