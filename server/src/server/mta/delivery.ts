import type Mail from "nodemailer/lib/mailer";
import { DELIVERY_ERROR, DSN_STATUS } from "../../config/constants";
import type { DeliveryResult, DsnOptions, RawMailOptions } from "./types";

export interface SmtpFailure {
	code?: string;
	responseCode?: number;
	response?: string;
	message?: string;
	recipient?: string;
	rejectedErrors?: SmtpFailure[];
}

export interface SmtpSendInfo {
	accepted: (string | Mail.Address)[];
	response: string;
}

export interface SmtpSender {
	sendMail(mail: Mail.Options): Promise<SmtpSendInfo>;
}

const ENHANCED_STATUS = /\b([245]\.\d{1,3}\.\d{1,3})\b/;

export const deliveryResult = {
	accepted(
		recipient: string,
		remoteMta: string,
		response: string,
		action: "delivered" | "relayed" = "delivered",
	): DeliveryResult {
		return {
			success: true,
			temporary: false,
			recipient,
			response,
			dsn: {
				status: DSN_STATUS.DELIVERED,
				action,
				remoteMta,
				finalRecipient: recipient,
				diagnosticCode: response,
			},
		};
	},

	failure(
		recipient: string,
		temporary: boolean,
		message: string,
		status: string,
		remoteMta?: string,
	): DeliveryResult {
		return {
			success: false,
			temporary,
			recipient,
			error: message,
			dsn: {
				status,
				action: temporary ? "delayed" : "failed",
				diagnosticCode: message,
				remoteMta,
				finalRecipient: recipient,
			},
		};
	},

	fromError(
		recipient: string,
		remoteMta: string,
		error: SmtpFailure,
	): DeliveryResult {
		const temporary =
			typeof error.responseCode === "number"
				? error.responseCode < 500
				: error.code !== "EENVELOPE";
		const text = error.response || error.message || DELIVERY_ERROR.UNKNOWN;
		const status =
			text.match(ENHANCED_STATUS)?.[1] ??
			(temporary ? DSN_STATUS.TEMPORARY : DSN_STATUS.PERMANENT);
		return deliveryResult.failure(
			recipient,
			temporary,
			text,
			status,
			remoteMta,
		);
	},

	failAll(
		recipients: string[],
		temporary: boolean,
		message: string,
		status: string,
		remoteMta?: string,
	): DeliveryResult[] {
		return recipients.map((recipient) =>
			deliveryResult.failure(recipient, temporary, message, status, remoteMta),
		);
	},
};

const dsnEnvelope = (recipients: string[], dsn?: DsnOptions) =>
	dsn
		? {
				ret: dsn.returnHeaders ? "HDRS" : "FULL",
				envid: dsn.envid || `${Date.now()}`,
				notify: dsn.notify || ["FAILURE", "DELAY"],
				orcpt: recipients.map((r) => `rfc822;${r}`),
			}
		: undefined;

const rejectedByRecipient = (
	errors?: SmtpFailure[],
): Map<string, SmtpFailure> =>
	new Map((errors ?? []).map((e) => [String(e.recipient).toLowerCase(), e]));

export async function sendThroughTransport(
	transporter: SmtpSender,
	remoteMta: string,
	{ from, to, raw, dsn }: RawMailOptions,
	action: "delivered" | "relayed" = "delivered",
): Promise<DeliveryResult[]> {
	const envelope = {
		from,
		to,
		dsn: dsnEnvelope(to, dsn),
	} as unknown as Mail.Options["envelope"];
	try {
		const info = await transporter.sendMail({ envelope, raw });
		const accepted = new Set(
			info.accepted.map((a) =>
				(typeof a === "string" ? a : a.address).toLowerCase(),
			),
		);
		const rejected = rejectedByRecipient((info as SmtpFailure).rejectedErrors);
		return to.map((recipient) => {
			const key = recipient.toLowerCase();
			if (accepted.has(key))
				return deliveryResult.accepted(
					recipient,
					remoteMta,
					info.response,
					action,
				);
			return deliveryResult.fromError(
				recipient,
				remoteMta,
				rejected.get(key) ?? { message: info.response },
			);
		});
	} catch (error) {
		const failure = (error ?? {}) as SmtpFailure;
		const rejected = rejectedByRecipient(failure.rejectedErrors);
		return to.map((recipient) =>
			deliveryResult.fromError(
				recipient,
				remoteMta,
				rejected.get(recipient.toLowerCase()) ?? failure,
			),
		);
	}
}
