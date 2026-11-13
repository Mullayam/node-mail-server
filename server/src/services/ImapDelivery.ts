import SMTPConnection from "nodemailer/lib/smtp-connection";
import { env } from "../config/env";

export interface ImapDeliveryFailure {
	recipient: string;
	code: number;
	permanent: boolean;
	message: string;
}

export interface ImapDeliveryResult {
	delivered: string[];
	failed: ImapDeliveryFailure[];
}

type RejectedError = Error & { recipient?: string; responseCode?: number };

type WithRejections = { rejectedErrors?: RejectedError[] };

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
						const failed = toFailures((err as WithRejections).rejectedErrors);
						if (failed.length) {
							return finish(() => resolve({ delivered: [], failed }));
						}
						return finish(() => reject(err));
					}
					finish(() =>
						resolve({
							delivered: (info.accepted ?? []).map(String),
							failed: toFailures((info as WithRejections).rejectedErrors),
						}),
					);
				});
			});
		});
	}
}
