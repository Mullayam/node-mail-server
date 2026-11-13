import SMTPConnection from "nodemailer/lib/smtp-connection";
import { env } from "../config/env";

/**
 * Hands accepted incoming mail to the IMAP server over LMTP (RFC 2033).
 *
 * The IMAP server stores the message (Pebble) and pushes it to Gluon, so it
 * shows up in connected mail clients at once. LMTP answers once per
 * recipient, so each recipient gets its own result.
 *
 * Off unless IMAP_LMTP_HOST is set.
 */

export interface ImapDeliveryFailure {
	recipient: string;
	code: number;
	/** true for 5xx (do not retry), false for 4xx (try again later) */
	permanent: boolean;
	message: string;
}

export interface ImapDeliveryResult {
	delivered: string[];
	failed: ImapDeliveryFailure[];
}

type RejectedError = Error & { recipient?: string; responseCode?: number };

function toFailures(
	errors: RejectedError[] | undefined,
): ImapDeliveryFailure[] {
	return (errors ?? []).map((e) => {
		const code = e.responseCode ?? 451;
		return {
			recipient: e.recipient ?? "",
			code,
			permanent: code >= 500,
			message: e.message,
		};
	});
}

export class ImapDelivery {
	static get enabled(): boolean {
		return Boolean(env.imap.lmtpHost);
	}

	/**
	 * Delivers one message to several local recipients.
	 * Rejects only when the IMAP server cannot be reached at all; per-recipient
	 * refusals come back in `failed`.
	 */
	static deliver(
		raw: Buffer,
		sender: string,
		recipients: string[],
	): Promise<ImapDeliveryResult> {
		return new Promise((resolve, reject) => {
			const conn = new SMTPConnection({
				host: env.imap.lmtpHost,
				port: env.imap.lmtpPort,
				lmtp: true,
				secure: false,
				ignoreTLS: true,
				name: env.server.incomingHost,
				connectionTimeout: env.imap.timeoutMs,
				greetingTimeout: env.imap.timeoutMs,
				socketTimeout: env.imap.timeoutMs,
			});

			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				conn.quit();
				fn();
			};

			conn.once("error", (err) => finish(() => reject(err)));
			conn.connect(() => {
				conn.send({ from: sender, to: recipients }, raw, (err, info) => {
					if (err) {
						const e = err as RejectedError & {
							rejectedErrors?: RejectedError[];
						};
						if (e.rejectedErrors?.length) {
							// Every recipient was refused at RCPT TO.
							return finish(() =>
								resolve({
									delivered: [],
									failed: toFailures(e.rejectedErrors),
								}),
							);
						}
						return finish(() => reject(err));
					}
					finish(() =>
						resolve({
							delivered: (info.accepted ?? []).map(String),
							failed: toFailures(
								(info as { rejectedErrors?: RejectedError[] }).rejectedErrors,
							),
						}),
					);
				});
			});
		});
	}
}
