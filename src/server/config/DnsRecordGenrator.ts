import {
	DNSRecordType,
	RecordTypeRespose,
} from "../../interfaces/dns.interface";
import crypto from "crypto";
import dns from "dns/promises";

export class DNSRecordGenerator {
	private domain: string;
	private dkimSelector: string;
	private mailServer: string;
	private dnsRecordsValue: { [key: number]: string } = {
		1: "A", // Address record
		2: "NS", // Name server
		5: "CNAME", // Canonical name
		6: "SOA", // Start of authority
		12: "PTR", // Pointer record
		15: "MX", // Mail exchange
		16: "TXT", // Text record
		28: "AAAA", // IPv6 address record
		33: "SRV", // Service locator
		41: "OPT", // Option (EDNS0)
		43: "DS", // Delegation signer
		46: "RRSIG", // DNSSEC signature
		47: "NSEC", // Next secure record
		48: "DNSKEY", // DNSSEC key
		257: "CAA", // Certification Authority Authorization
		52: "TLSA",
	};

	constructor(domain: string, dkimSelector: string = "default") {
		this.domain = domain;
		this.mailServer = process.env.MAIL_HOST;
		this.dkimSelector = dkimSelector;
	}
	private formatDkimPublicKey(publicKey: string): string {
		return publicKey
			.replace(/-----BEGIN PUBLIC KEY-----/g, "") // Remove header
			.replace(/-----END PUBLIC KEY-----/g, "") // Remove footer
			.replace(/\s+/g, "") // Remove spaces and newlines
			.trim(); // Trim any extra spaces
	}
	private getKeyFromValue(value: string) {
		let num: number;
		for (const key in this.dnsRecordsValue) {
			if (this.dnsRecordsValue[key as unknown as number] === value) {
				num = Number(key);
				return num;
			}
		}
	}
	private formatRecords(
		type: DNSRecordType,
		name: string,
		data: string,
	): RecordTypeRespose {
		return {
			type: this.getKeyFromValue(type) as number,
			name,
			ttl: 300,
			data,
		};
	}
	/**
	 * Generates an ARC-Seal header.
	 * @param domain - The signing domain.
	 * @param selector - The ARC selector.
	 * @param privateKey - The private key for signing.
	 * @param headerData - The data to sign.
	 * @returns The ARC-Seal header.
	 */
	generateARCSeal(privateKey: string, headerData: string): string {
		const sign = crypto.createSign("RSA-SHA256");
		sign.update(headerData);
		const signature = sign.sign(privateKey, "base64");

		return `ARC-Seal: a=rsa-sha256; d=${this.domain}; s=${this.dkimSelector}; b=${signature}`;
	}
	generateARCHeaders(headers: Record<string, string>): Record<string, string> {
		const timestamp = Math.floor(Date.now() / 1000);
		const arcSeal = `ARC-Seal: i=1; a=rsa-sha256; t=${timestamp}; cv=none;
              d=${this.domain}; s=arc-20240605;`;

		const messageHash = crypto
			.createHash("sha256")
			.update(arcSeal)
			.digest("base64");
		const arcMessageSignature = `ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=${this.domain}; s=arc-20240605;
              bh=${messageHash};`;

		return { arcSeal, arcMessageSignature };
	}
	private isIPAddress(value: string): boolean {
		return /^(\d{1,3}\.){3}\d{1,3}$/.test(value);
	}
	/**
	 * Generates SPF record allowing only the mail server to send emails.
	 */
	async generateSPF() {
		let spfRecord = "v=spf1";

		if (this.isIPAddress(this.mailServer)) {
			spfRecord += ` a mx ip4:${this.mailServer}`;
		}
		try {
			await dns.lookup(this.mailServer).then(({ address }) => {
				spfRecord += ` a mx ip4:${address}`;
			});
		} catch (error) {
			spfRecord += ` include:${this.mailServer}`;
		}

		spfRecord += " ~all";
		return this.formatRecords("TXT", this.domain, spfRecord);
	}

	/**
	 * Generates DKIM public/private key pair and returns the DKIM DNS record.
	 */
	generateDKIM(): { publicKey: string; privateKey: string; dkimRecord: any } {
		const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
			modulusLength: 2048,
			publicKeyEncoding: { type: "spki", format: "pem" },
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
		});

		const publicKeyFiltered = this.formatDkimPublicKey(publicKey);
		const string = `v=DKIM1; k=rsa; p=${publicKeyFiltered}`;
		const dkimRecord = this.formatRecords(
			"TXT",
			`${this.dkimSelector}._domainkey.${this.domain}`,
			string,
		);
		return { publicKey: publicKeyFiltered, privateKey, dkimRecord };
	}

	/**
	 * Generates DMARC record.
	 */
	generateDMARC() {
		const DMARCRecord = this.formatRecords(
			"TXT",
			`_dmarc.${this.domain}`,
			`v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc-reports@${this.domain}; ruf=mailto:dmarc-failures@${this.domain}`,
		);

		return DMARCRecord;
	}

	/**
	 * Generates an MX record pointing to the mail server.
	 */
	generateMX() {
		const mxRecord = this.formatRecords(
			"MX",
			`${this.domain}`,
			`10 ${this.mailServer}`,
		);

		return mxRecord;
	}

	/**
	 * Generates an SRV record (useful for mail services like IMAP/SMTP).
	 */
	generateSRV(): string {
		return `_submission._tcp.${this.domain} 10 10 587 ${this.mailServer}`;
	}

	/**
	 * Generates a custom TXT record.
	 */
	generateTXT(name: string, value: string): RecordTypeRespose {
		return this.formatRecords("TXT", name, value);
	}
	autodiscoverHandler = (domain: string): string => {
		return `
            <Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
                <Response>
                    <Account>
                        <AccountType>email</AccountType>
                        <Action>settings</Action>
                        <Protocol>
                            <Type>IMAP</Type>
                            <Server>${domain}</Server>
                            <Port>993</Port>
                            <SSL>true</SSL>
                        </Protocol>
                    </Account>
                </Response>
            </Autodiscover>
        `;
	};
	/**
	 * Generates all records for a domain.
	 */
	async generateAllRecords(): Promise<{
		SPF: RecordTypeRespose;
		DKIM: {
			privateKey: string;
			selector: string;
			dkimRecord: RecordTypeRespose;
		};
		DMARC: RecordTypeRespose;
		MX: RecordTypeRespose;
	}> {
		const { dkimRecord, privateKey } = this.generateDKIM();

		return {
			SPF: await this.generateSPF(),
			DKIM: {
				privateKey,
				selector: this.dkimSelector,
				dkimRecord,
			},
			DMARC: this.generateDMARC(),
			MX: this.generateMX(),
		};
	}
}
