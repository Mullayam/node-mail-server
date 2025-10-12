import { MiscellaneousHelper } from "../lib/helpers";
import { DNSChecker } from "../server/config/DnsChecker";
import { MailConfig } from "../server/config/MailConfig";
import { SpamFilteration } from "../server/config/SpamFilteration";
import {
	SMTPServerAddress,
	SMTPServerDataStream,
	SMTPServerSession,
} from "smtp-server";
import { PGPService } from "./encryption/PGPService";

const regex = /^[^\s@]+\.temp@[^\s@]+\.[^\s@]+$/;

const pgp = new PGPService()

class IncomingMailHandler {
	async HandleMailFrom(
		address: SMTPServerAddress,
		session: SMTPServerSession,
		callback: (err?: Error | null | undefined) => void,
	): Promise<void> {
		try {
			const mailFrom =
				MiscellaneousHelper.extractEmail(address.address) || address.address;

			if (mailFrom.match(regex)) {
				return callback(new Error("The email address you used is invalid"));
			}
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
			/** NOTE :
			 * Check the RCPT TO address is exist or not in your System
			 * Check the DNS records like MX, SPF, DMARC, TXT of the Sender and validate them and based on them allow or reject the email
			 * Spam Detection
			 * Store All Logs in Database, Redis etc
			 */

			if (session.envelope && session.envelope.mailFrom) {
				const receiverMail =
					MiscellaneousHelper.extractEmail(address.address) || address.address;
				const receiverDomain = receiverMail.split("@")[1];
				const mailFrom =
					MiscellaneousHelper.extractEmail(session.envelope.mailFrom.address) ||
					session.envelope.mailFrom.address;
				const mailFromDomain = mailFrom.split("@")[1];

				const { mxRecords, spfRecords, dmarcRecords, txtRecords } =
					await DNSChecker.resolveRecords(mailFromDomain);

				// Check for MX record
				if (mxRecords.length === 0) {
					message = `No MX records found for domain ${mailFromDomain}. Rejecting the email.`;

					return callback(new Error(message));
				}
				message = `MX record check passed localPort = ${session.localPort}, remoteIp = ${session.remoteAddress}, remotePort = ${session.remotePort}, from = ${mailFrom} to ${receiverMail}`;

				// Check for SPF record
				const spfRecord = spfRecords.find((record: string[]) =>
					record.join(" ").toUpperCase().includes("SPF"),
				);
				if (!spfRecord) {
					message = `No SPF record found for domain ${mailFromDomain}.SPF record not passed,  Rejecting the email.`;

					return callback(new Error(message));
				}
				message = `SPF record passed ,localPort = ${session.localPort}, remoteIp = ${session.remoteAddress}, remotePort = ${session.remotePort}, from = ${mailFrom} to ${receiverMail}`;

				if (dmarcRecords.length === 0) {
					const message = `No DMARC record found for domain ${mailFromDomain}.DMARC record not passed, Forwarding to Spam Folder`;
				} else {
					message = `DMARC record passed, localPort = ${session.localPort}, remoteIp = ${session.remoteAddress}, remotePort = ${session.remotePort}, from = ${mailFrom} to ${receiverMail}, `;
				}

				// Check for TXT record

				if (txtRecords.length === 0) {
					const message = `No TXT records found for domain ${mailFromDomain}. Forwarding to Spam Folder`;
				} else {
					message = `TXT record passed, localPort = ${session.localPort}, remoteIp = ${session.remoteAddress}, remotePort = ${session.remotePort}, from = ${mailFrom} to ${receiverMail}`;
				}

				const successMessage = `Incoming mail accepted  localPort = ${session.localPort}, remoteIp = ${session.remoteAddress}, remotePort = ${session.remotePort},  from = ${mailFrom} to ${receiverMail}`;

				// Dont Forget to check the RCPT TO domain is exist or not in your System

				return callback(null);
			}

			return callback(null);
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
			try {
				const parsedEmailData = await MailConfig.ParseEmail(mailchunks);

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
				   // check forwariding and forward to
              
				await pgp.encryptMessage(mailchunks, {
					privateKey: process.env.PGP_PRIVATE_KEY || "",
					publicKey: process.env.PGP_PUBLIC_KEY || "",
					revocationCertificate: process.env.PGP_REVOCATION_CERTIFICATE || ""

				}, "password").then(async (encrypted) => {
					// Send the encrypted message via email or store it as needed
					console.log("Encrypted Message: ", encrypted);

				})


				stream.pipe(process.stdout);
				return callback(null);
			} catch (error: any) {
				return callback(new Error(error.message));
			}
		});
	}
}
export const NewMailHandler = new IncomingMailHandler();
