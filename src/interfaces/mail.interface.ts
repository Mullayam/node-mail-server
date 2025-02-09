import { HeaderLines } from "mailparser";
import { TemplateOptions } from "nodemailer-express-handlebars";
export interface MailDataDto {
    message_id: string; // Unique identifier for each mail
    from: string; // Sender email
    receipients: string[] | [];
    to: string;
    subject: string | undefined; // Subject of the mail
    hasAttachment: any; // Attachment field, can be a boolean or an object with content and related flag
    isRead: boolean; // Whether the mail is read or not
    timestamp: string | undefined; // Timestamp of the mail
    title: string; // Title of the mail
    shortContent: string; // Preview content of the mail
    toWithName?: string | null | undefined; // Preview content of the mail
    headersLine?: { key: string; line: string } | HeaderLines; // Optional headers as key-value pairs
    headers?: object; // Optional additional headers as key-value pairs
    contents?: string;
    isStarred?: boolean;
    synced: boolean
}
export interface FileAttachmentInterface {
    type: string;
    content: Buffer;
    contentType: string;
    partId: string;
    release: string | null;
    contentDisposition: string;
    filename: string;
    headers: Map<string, any>;
    checksum: string;
    size: number;
}
export interface MailOptions {
    from?: string;
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject: string;
    text?: string;
    html: string;
}
export type MailOptionsWithTemplate = MailOptions & TemplateOptions