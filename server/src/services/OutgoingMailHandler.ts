import type {
	SMTPServerAddress,
	SMTPServerAuthentication,
	SMTPServerAuthenticationResponse,
	SMTPServerDataStream,
	SMTPServerSession,
} from "smtp-server";
import { mailConfig } from "../config/mailConfig";
import { smtpReply } from "../config/smtpMessages";
import { MiscellaneousHelper } from "../lib/helpers";
import { collectMessage } from "../lib/helpers/RawMessage";
import { toSmtpError } from "../lib/helpers/smtpErrors";
import { Logging } from "../lib/logs";
import { submitOutgoing } from "./OutgoingPipeline";

class OutgoingMailHandler {
	async HandleAuthenticate(
		auth: SMTPServerAuthentication,
		session: SMTPServerSession,
		callback: (
			err: Error | null | undefined,
			response?: SMTPServerAuthenticationResponse | undefined,
		) => void,
	): Promise<void> {
		try {
			if (auth.method === "XOAUTH2") {
				return callback(smtpReply("AUTH_METHOD_NOT_ALLOWED").toError());
			}

			// Note: You should check the username and password here before accepting the connection
			// This can be using Database and File system or any other method
			if (
				auth.username === "your_username" &&
				auth.password === "your_password"
			) {
				Logging.dev("Client Authenticated " + auth.username);
				callback(null, { user: auth.username });
			} else {
				callback(smtpReply("AUTH_FAILED").toError());
			}
		} catch (error) {
			return callback(smtpReply("AUTH_FAILED").toError());
		}
	}
	HandleConnection(
		session: SMTPServerSession,
		callback: (err?: Error | null | undefined) => void,
	): void {
		// Must be disbabled in Production, can be allowed in development for testing Purpose
		if (session.remoteAddress === "127.0.0.1") {
			callback(new Error("No connections from localhost allowed"));
			return;
		}

		Logging.dev("Client Connected " + session.id);

		callback(null); // Accept the connection
	}
	HandleConnectionClose(
		session: SMTPServerSession,
		callback: (err?: Error | null | undefined) => void,
	): void {
		// Must be disbabled in Production, can be allowed in development for testing Purpose
		if (session.remoteAddress === "127.0.0.1") {
			callback(new Error("No connections from localhost allowed"));
			return;
		}
		Logging.dev("Client Disonnected " + session.id);
	}

	async HandleMailFrom(
		address: SMTPServerAddress,
		session: SMTPServerSession,
		callback: (err?: Error | null | undefined) => void,
	): Promise<void> {
		try {
			Logging.dev("Sending Mail From " + address.address);

			const mailFrom =
				MiscellaneousHelper.extractEmail(address.address) || address.address;
			const mailFromDomain = mailFrom.split("@")[1];
			//  Check For Relay, Dont Allow Relay

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
			Logging.dev("Sending Mail To " + address.address);

			const { maxRecipients } = mailConfig.get().outgoing;
			if (session.envelope.rcptTo.length >= maxRecipients) {
				return callback(
					smtpReply("TOO_MANY_RECIPIENTS", { max: maxRecipients }).toError(),
				);
			}

			if (session.envelope && session.envelope.mailFrom) {
				const recipientMail =
					MiscellaneousHelper.extractEmail(address.address) || address.address;

				const mailFrom =
					MiscellaneousHelper.extractEmail(session.envelope.mailFrom.address) ||
					session.envelope.mailFrom.address;

				Logging.dev(
					`Outgoing mail localPort = ${session.localPort}, remoteIp = ${session.remoteAddress}, remotePort = ${session.remotePort}, from = ${mailFrom} to ${recipientMail}`,
				);
				// use MAX_EMAILS_PER_MINUTE , prevent Spam Protection ,using of bulk mails can down your server and IP Reputation
				return callback();
			}

			return callback();
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
			const config = mailConfig.get().outgoing;
			const message = await collectMessage(stream, config.maxMessageSizeBytes);
			if (!message) {
				return callback(
					smtpReply("MESSAGE_TOO_LARGE", {
						maxSize: config.maxMessageSizeBytes,
					}).toError(),
				);
			}

			const sender = session.envelope.mailFrom
				? session.envelope.mailFrom.address
				: "";
			const recipients = [
				...new Set(session.envelope.rcptTo.map((v) => v.address)),
			];
			if (!recipients.length) {
				return callback(smtpReply("NO_VALID_RECIPIENTS").toError());
			}

			const queueId = await submitOutgoing({
				sender,
				recipients,
				raw: message,
				source: `smtp ${session.remoteAddress}:${session.remotePort}`,
			});

			return callback(null, smtpReply("MESSAGE_QUEUED", { id: queueId }).text);
		} catch (error) {
			return callback(toSmtpError(error, "Outgoing message failed"));
		}
	}
}
export const NewOutgoingMailHandler = new OutgoingMailHandler();
