import nodemailer from "nodemailer";
import MailComposer from 'nodemailer/lib/mail-composer'
import Mail from 'nodemailer/lib/mailer';
import { MailParserOptions, ParsedMail, simpleParser, Source, MailParser } from "mailparser"

export let parser = new MailParser();

export class MailConfig {
    static composeNewMail = (options: Mail.Options): MailComposer => {
        const mail = new MailComposer({

        });
        const stream = mail.compile().createReadStream();
        return mail
    }
    static async ParseEmail(source: Source, options?: MailParserOptions | undefined): Promise<ParsedMail> {

        return simpleParser(source, options);;
    }
    static async createTransporter(host: string, port: number = 25): Promise<nodemailer.Transporter> {
        return nodemailer.createTransport({
            host,
            port: port,
            secure: false,
        });
    }
    static async send(transporter: nodemailer.Transporter, emailData: string) {
        return transporter.sendMail({
            raw: emailData,
        }, (err, info) => {
            if (err) console.error("Error sending mail:", err);
            else console.log("Email sent successfully!", info);
        });
    }
}