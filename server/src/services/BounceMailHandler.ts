import type {
	SMTPServerAddress,
	SMTPServerDataStream,
	SMTPServerSession,
} from "smtp-server";
import { mailConfig } from "../config/mailConfig";
import { smtpReply } from "../config/smtpMessages";
import { collectMessage } from "../lib/helpers/RawMessage";
import { toSmtpError } from "../lib/helpers/smtpErrors";
import { Logging } from "../lib/logs";
import { getMailRuntime } from "../server/mta/runtime";

class BounceMailHandler {
	async HandleRcptTo(
		address: SMTPServerAddress,
		session: SMTPServerSession,
		callback: (err?: Error | null | undefined) => void,
	): Promise<void> {
		try {
			const { bounces } = getMailRuntime();
			if (bounces.bounceDomain && !bounces.isBounceAddress(address.address)) {
				return callback(
					smtpReply("UNKNOWN_BOUNCE_ADDRESS", {
						recipient: address.address,
					}).toError(),
				);
			}
			Logging.dev(
				`Bounce accepted remoteIp = ${session.remoteAddress} to ${address.address}`,
			);
			return callback();
		} catch (error) {
			return callback(toSmtpError(error, "Bounce RCPT TO failed"));
		}
	}
	async HandleNewMail(
		stream: SMTPServerDataStream,
		session: SMTPServerSession,
		callback: (err?: Error | null | undefined, message?: string) => void,
	): Promise<void> {
		try {
			const maxSize = mailConfig.get().incoming.maxMessageSizeBytes;
			const raw = await collectMessage(stream, maxSize);
			if (!raw) {
				return callback(smtpReply("MESSAGE_TOO_LARGE", { maxSize }).toError());
			}
			await getMailRuntime().bounces.handleIncomingBounce(
				raw,
				session.envelope.rcptTo.map((r) => r.address),
			);
			return callback(null, smtpReply("BOUNCE_ACCEPTED").text);
		} catch (error) {
			return callback(toSmtpError(error, "Bounce processing failed"));
		}
	}
}
export const NewBounceMailHandler = new BounceMailHandler();
