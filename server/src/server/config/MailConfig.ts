import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import Mail from "nodemailer/lib/mailer";
import {
	MailParserOptions,
	ParsedMail,
	simpleParser,
	Source,
	MailParser,
} from "mailparser";
import { DNSChecker } from "./DnsChecker";
import { Logging } from "../../lib/logs";

export let parser = new MailParser();

export class MailConfig {
	static composeNewMail = (options: Mail.Options): MailComposer => {
		const mail = new MailComposer({});
		const stream = mail.compile().createReadStream();
		return mail;
	};
	static async ParseEmail(
		source: Source,
		options?: MailParserOptions | undefined,
	): Promise<ParsedMail> {
		return simpleParser(source, options);
	}
	static createtransporter(host: string, port: number = 25) {
		return nodemailer.createTransport({
			host,
			port,
			secure: false,
		});
	}
	static async checkConnections(
		host: string,
	): Promise<{ host: string; port: number } | null> {
		for (const port of [25, 587, 465]) {
			try {
				const exchange = await DNSChecker.getMXRecords(host);
				if (!exchange) {
					return null;
				}
				return { host: exchange, port };
			} catch (error) {
				Logging.dev(`❌ Failed to connect to ${host}:${port}`, "error");
			}
		}
		return null;
	}
	static groupRecipientsByDomain(
		recipients: string[],
	): Record<string, string[]> {
		const domainGroups: Record<string, string[]> = {};
		recipients.forEach((email) => {
			const domain = email.split("@")[1];
			if (!domainGroups[domain]) {
				domainGroups[domain] = [];
			}
			domainGroups[domain].push(email);
		});

		return domainGroups;
	}
}
