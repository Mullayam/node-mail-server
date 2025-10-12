 import axios, { AxiosResponse } from "axios";
import { SendMailOptions } from 'nodemailer';
import { createMimeMessage } from "mimetext";
import MailComposer from "nodemailer/lib/mail-composer"

import path from 'path';
import { randomBytes } from 'crypto';

export interface Root {
    url: string
    host: string
    status: number
    statusText: string
    icons: Icon[]
    duration: string
}
export interface Icon {
    href: string
    sizes: string
}


export class RFC5322MailComposer {
    private createMimeMessage: typeof createMimeMessage
    constructor() {
        const mimetext = require('mimetext')
        this.createMimeMessage = mimetext.createMimeMessage

    }
    generateReceivedHeader(session: any, id: string, byHost: string): string {
        const fromHost = session.clientHostname || 'unknown';
        const fromIP = session.remoteAddress;

        const tlsInfo = session?.envelope?.tls || session?.tls || {};
        const tlsVersion = tlsInfo?.version || 'TLS1_2';
        const cipher = tlsInfo?.cipher || 'TLS_AES_256_GCM_SHA384';
        const bits = 256;

        const dateStr = new Date().toUTCString();

        return `Received: from ${fromHost} (${fromHost} [${fromIP}])\r\n` +
            `        by ${byHost} with ESMTPS id ${id}\r\n` +
            `        (version=${tlsVersion} cipher=${cipher} bits=${bits}/${bits});\r\n` +
            `        ${dateStr}`;
    }
 

    /**
     * Simple content type guesser based on file extension
     */
    guessContentType(filename: string) {
        const ext = path.extname(filename).toLowerCase();
        switch (ext) {
            case '.jpg': case '.jpeg': return 'image/jpeg';
            case '.png': return 'image/png';
            case '.pdf': return 'application/pdf';
            case '.txt': return 'text/plain';
            case '.html': return 'text/html';
            default: return 'application/octet-stream';
        }
    }
    createMimeStructuredHeaders(headersObj: Record<string, string>) {
        const mail = this.createMimeMessage();

        // Set each header on the mail object
        for (const [key, value] of Object.entries(headersObj)) {
            mail.setHeader(key, value);
        }

        // asRaw() gives full message including headers and blank line and empty body
        const raw = mail.asRaw();
        // Extract header section (up to the first blank line)
        const parts = raw.split('\r\n\r\n');
        const headerBlock = parts[0]

        return headerBlock;
    }

    static createRfc822Headers(headersObj: Record<string, string>) {
        return Object.entries(headersObj)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\r\n') + '\r\n';

    }

    static async fetchFavicons(domain: string) {
        try {
            const { data } = await axios.get("https://airsend.in/api/favicon/" + domain) as AxiosResponse<Root>;
            if (data.status !== 200) {
                throw new Error("Failed to fetch favicons")
            }
            return data.icons.length > 0 ? data.icons[0].href : null
        } catch (error) {
            return null
        }

    }
    generateAEHeaders(opts:  Record<string, string>): Record<string, string> {
        const now = new Date().toISOString();
        const messageId = randomBytes(32).toString('hex') + '@' + opts.orgId;
        const receiptId = randomBytes(32).toString('hex') + '@' + opts.orgId;

        const tags = opts.tags
            ? Object.entries(opts.tags).map(([k, v]) => `${k}=${v}`).join(',')
            : '';

        const headers: Record<string, string> = {
            'X-AE-Message-ID': messageId,
            'X-AE-Receipt-ID': receiptId,
            'X-AE-User-ID': opts.userId,
            'X-AE-User-Email': opts.userEmail,
            'X-AE-Org-ID': opts.orgId,
            'X-AE-Org-Name': opts.orgName,
            'X-AE-Receipt-Time': now,
            'X-AE-Origin': opts.source || 'api',
            'X-AE-Send-Type': opts.sendType || 'transactional',
            'X-AE-Platform': opts.platform || 'ae-mailer-v1',
            'X-AE-Mailer': opts.mailer || 'AE-Mail-Service',
            'X-AE-Message-Channel': 'email',
        };

        if (tags) headers['X-AE-Tags'] = tags;
        if (opts.region) headers['X-AE-Region'] = opts.region;
        if (opts.ip) headers['X-AE-IP'] = opts.ip;
        if (opts.sessionId) headers['X-AE-Session-ID'] = opts.sessionId;
        if (opts.campaignId) headers['X-AE-Campaign-ID'] = opts.campaignId;
        if (opts.originalSender) headers['X-AE-Original-Sender'] = opts.originalSender;
        if (opts.unsubscribeUrl) headers['X-AE-Unsubscribe-URL'] = opts.unsubscribeUrl;
        if (opts.abuseReportUrl) {
            headers['X-AE-Abuse-Report'] = 'abuse@airsend.in';
            headers['X-AE-Abuse-Report-URL'] = opts.abuseReportUrl;
        }
        if (opts.returnPath) headers['Return-Path'] = opts.returnPath;
        if (opts.replyTo) headers['Reply-To'] = opts.replyTo;

        return headers;
    }
    static createRawEmail(options: SendMailOptions): Promise<Buffer> {

        const mail = new MailComposer({ ...options, encoding: 'utf-8' });
        return new Promise((resolve, reject) => {
            return mail.compile().build((err, message) => {
                if (err) return reject(err);
                resolve(message); // Buffer (RFC 5322 formatted)
            });
        });
    }

}
