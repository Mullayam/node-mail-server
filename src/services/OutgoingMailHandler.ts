import { MiscellaneousHelper } from "../lib/helpers";
import { Logging } from "../lib/logs";
import { MailConfig } from "../server/config/MailConfig";
import {
	SMTPServerAddress,
	SMTPServerAuthentication,
	SMTPServerAuthenticationResponse,
	SMTPServerDataStream,
	SMTPServerSession,
} from "smtp-server";
import { AddressObject } from "mailparser";
import { NodeMailerMTA } from "@/server/mta/node-mta";

// Shared MTA instance so the MX cache persists across requests
const mta = new NodeMailerMTA();

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
				return callback(
					new Error(
						"XOAUTH2 method is not allowed,Expecting LOGIN authentication",
					),
				);
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
				callback(new Error("Invalid username or password"));
			}
		} catch (error) {
			return callback(new Error("Invalid username or password"));
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

		return callback(null); // Accept the connection
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
		} catch (error: any) {
			if (error instanceof Error) {
				return callback(new Error(error.message));
			}
			return callback(null);
		}
	}
	async HandleRcptTo(
		address: SMTPServerAddress,
		session: SMTPServerSession,
		callback: (err?: Error | null | undefined) => void,
	): Promise<void> {
		try {
			Logging.dev("Sending Mail To " + address.address);

			if (session.envelope && session.envelope.mailFrom) {
				const recipientMail =
					MiscellaneousHelper.extractEmail(address.address) || address.address;

				const mailFrom =
					MiscellaneousHelper.extractEmail(session.envelope.mailFrom.address) ||
					session.envelope.mailFrom.address;

				Logging.dev(`Outgoing mail localPort = ${session.localPort}, remoteIp = ${session.remoteAddress}, remotePort = ${session.remotePort}, from = ${mailFrom} to ${recipientMail}`);
				// use MAX_EMAILS_PER_MINUTE , prevent Spam Protection ,using of bulk mails can down your server and IP Reputation
				return callback();
			}

			return callback();
		} catch (error) {
			if (error instanceof Error) {
				return callback(new Error(error.message));
			}
			return callback(null);
		}
	}
	async HandleNewMail(
		stream: SMTPServerDataStream,
		session: SMTPServerSession,
		callback: (err?: Error | null | undefined, message?: string) => void,
	): Promise<void> {
		let mailchunks = "";
		stream.on("data", (chunk) => (mailchunks += chunk.toString()));
		stream.on("end", async () => {
			try {
				const parsedEmailData = await MailConfig.ParseEmail(mailchunks);

				const MAIL_FROM = (session.envelope.mailFrom &&
					session.envelope.mailFrom.address) as string;
				const RCPT_TO = session.envelope.rcptTo.map((v) => v.address);

				// Collect all recipients (to + cc + bcc), deduplicate
				const extractAddresses = (field: AddressObject | AddressObject[] | undefined): string[] => {
					if (!field) return [];
					const objects = Array.isArray(field) ? field : [field];
					return objects.flatMap((obj) => obj.value.map((v) => v.address).filter(Boolean) as string[]);
				};
				const toAddresses = extractAddresses(parsedEmailData.to);
				const ccAddresses = extractAddresses(parsedEmailData.cc);
				const bccAddresses = extractAddresses(parsedEmailData.bcc);

				let totalRecipients = [...toAddresses, ...ccAddresses, ...bccAddresses];
				// Fall back to envelope RCPT TO if parsed headers yield nothing
				if (totalRecipients.length === 0) {
					totalRecipients = RCPT_TO;
				}
				totalRecipients = [...new Set(totalRecipients)];

				const deliveryResults = await mta.sendMail({
					from: MAIL_FROM,
					to: totalRecipients,
					subject: parsedEmailData.subject || "(no subject)",
					text: parsedEmailData.text || undefined,
					html: parsedEmailData.html || undefined,
					attachments: parsedEmailData.attachments?.map((att) => ({
						filename: att.filename || undefined,
						content: att.content,
						contentType: att.contentType,
					})),
					dkim: process.env.DKIM_PRIVATE_KEY
						? {
							domainName: MAIL_FROM.split("@")[1],
							keySelector: process.env.DKIM_SELECTOR || "default",
							privateKey: process.env.DKIM_PRIVATE_KEY,
						}
						: undefined,
					dsn: {
						notify: ["FAILURE", "DELAY"],
						returnHeaders: true,
					},
				});

				const failed = deliveryResults.filter((r) => !r.success);
				if (failed.length > 0) {
					Logging.dev(`Partial delivery failure: ${failed.map((f) => `${f.recipient}: ${f.error || f.dsn?.diagnosticCode}`).join(", ")}`);
				}

				const successMessage = `Outgoing mail delivered localPort = ${session.localPort}, remoteIp = ${session.remoteAddress}, remotePort = ${session.remotePort}, from = ${MAIL_FROM} to ${totalRecipients.join(",")}`;
				Logging.dev(successMessage);

				return callback(null, "250 Message accepted for delivery");
			} catch (error: any) {
				return callback(new Error(error.message));
			}
		});
	}

}
export const NewOutgoingMailHandler = new OutgoingMailHandler();
