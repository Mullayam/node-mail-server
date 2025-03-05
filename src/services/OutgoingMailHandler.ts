import dns from "dns/promises";
import { DKIMSign } from "dkim-signer";
import { MiscellaneousHelper } from "../lib/helpers";
import { Logging } from "../lib/logs";
import { DNSChecker } from "../server/config/DnsChecker";
import { MailConfig } from "../server/config/MailConfig";
import { SpamFilteration } from "../server/config/SpamFilteration";
import {
	SMTPServerAddress,
	SMTPServerAuthentication,
	SMTPServerAuthenticationResponse,
	SMTPServerDataStream,
	SMTPServerSession,
} from "smtp-server";
import { NodeMailerMTA } from "@/server/mta/node-mta";
const spam = new SpamFilteration();

class OutgoingMailHandler {
	private readonly AVIALBLE_PORTS = [25, 465, 587];
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
			let message = "";
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
			let message = "";
			Logging.dev("Sending Mail To " + address.address);

			if (session.envelope && session.envelope.mailFrom) {
				const recipientMail =
					MiscellaneousHelper.extractEmail(address.address) || address.address;

				const mailFrom =
					MiscellaneousHelper.extractEmail(session.envelope.mailFrom.address) ||
					session.envelope.mailFrom.address;
				const mailFromDomain = mailFrom.split("@")[1];

				message = `Outgoing mail localPort = ${session.localPort}, remoteIp = ${session.remoteAddress}, remotePort = ${session.remotePort}, from = ${mailFrom} to ${recipientMail}`;
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
		callback: (err?: Error | null | undefined) => void,
	): Promise<void> {
		let mailchunks = "";
		stream.on("data", (chunk) => (mailchunks += chunk.toString()));
		stream.on("end", async () => {
			// Handle Incoming mail
			const parsedEmailData = await MailConfig.ParseEmail(mailchunks);

			const MAIL_FROM = (session.envelope.mailFrom &&
				session.envelope.mailFrom.address) as string;
			const RCPT_TO = session.envelope.rcptTo.map((v) => v.address);

			const successMessage = `Outgoing mail Added To Queue  localPort = ${session.localPort}, remoteIp = ${session.remoteAddress}, remotePort = ${session.remotePort}, from = ${MAIL_FROM} to ${session.envelope.rcptTo.map((v) => v.address).join(",")}`;

			// Send to Queue which processes the mail or You can Use Relay
			// Use processOutgoingWithQueueMailDirectDelivery or processOutgoingMailWithTransporterDirectDelivery function or use your own
			// use parsedEmailData as emailData and your required details to send the mail

			// EXAMPLE, filter all reciepeint and send the mail, remove duplicates

			// let totalRecipients = [...data.to, ...(data.cc || []), ...(data.bcc || [])];
			// totalRecipients = Array.from(new Set(totalRecipients));

			// const sentInfo = await new NodeMailerMTA().useTransport(totalRecipients)			 
			// return callback(null,sentInfo?.response); // Send the response back to the client (recommended)
			
			return callback(null); // if you don't want to send any response
		});
	}

	private async checkConnections(
		hosts: string[],
	): Promise<{ host: string; port: number } | null> {
		// You Can implement your own logic here for better Approach, It's just a simple example and It will work in most cases
		// I'm Noob 🙂 👉👈
		for (const host of hosts) {
			for (const port of this.AVIALBLE_PORTS) {
				try {
					const isConnected = await DNSChecker.tryConnect(host, port);
					if (isConnected) {
						Logging.dev(`✅ Connected to ${host}:${port}`);
						return { host, port };
					}
				} catch (error) {
					Logging.dev(`❌ Failed to connect to ${host}:${port}`, "error");
				}
			}
		}
		return null; // No connection was successful
	}

}
export const NewOutgoingMailHandler = new OutgoingMailHandler();
