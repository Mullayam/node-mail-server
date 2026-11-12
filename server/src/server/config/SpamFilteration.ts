import crypto from "crypto";
import dns from "dns";
import forge from "node-forge";
import { RATE_LIMIT } from "../../config/constants";
import { smtpReply } from "../../config/smtpMessages";

interface IpState {
	count: number;
	windowStart: number;
	blockedUntil: number;
	strikes: number;
	lastSeen: number;
}

const { BASE_BLOCK_MS, MAX_BLOCK_MS, STRIKE_RESET_MS, SWEEP_INTERVAL_MS } =
	RATE_LIMIT;
const ipStates = new Map<string, IpState>();

setInterval(() => {
	const now = Date.now();
	for (const [ip, state] of ipStates) {
		if (state.blockedUntil <= now && now - state.lastSeen > STRIKE_RESET_MS)
			ipStates.delete(ip);
	}
}, SWEEP_INTERVAL_MS).unref();

export class SpamFilteration {
	static async checkBlackListIp(
		ip: string,
		threshold: number,
		windowMs: number = RATE_LIMIT.WINDOW_MS,
	) {
		const now = Date.now();
		let state = ipStates.get(ip);
		if (!state) {
			state = {
				count: 0,
				windowStart: now,
				blockedUntil: 0,
				strikes: 0,
				lastSeen: now,
			};
			ipStates.set(ip, state);
		}
		if (now - state.lastSeen > STRIKE_RESET_MS) state.strikes = 0;
		state.lastSeen = now;

		if (state.blockedUntil > now) {
			throw smtpReply("RATE_LIMITED", {
				ip,
				seconds: Math.ceil((state.blockedUntil - now) / 1000),
			}).toError();
		}

		if (now - state.windowStart >= windowMs) {
			state.windowStart = now;
			state.count = 0;
		}

		state.count++;
		if (state.count > threshold) {
			const blockMs = Math.min(
				BASE_BLOCK_MS * 2 ** state.strikes,
				MAX_BLOCK_MS,
			);
			state.blockedUntil = now + blockMs;
			state.strikes++;
			state.count = 0;
			throw smtpReply("RATE_LIMITED", {
				ip,
				seconds: Math.ceil(blockMs / 1000),
			}).toError();
		}
	}
	checkRBL(ip: string): Promise<boolean> {
		return new Promise((resolve) => {
			const reversedIP = ip.split(".").reverse().join(".");
			const rblDomain = `${reversedIP}.zen.spamhaus.org`;

			dns.resolve4(rblDomain, (err) => {
				if (err)
					resolve(false); // Not blacklisted
				else resolve(true); // Blacklisted
			});
		});
	}
	checkSPF(domain: string, senderIP: string): Promise<boolean> {
		return new Promise((resolve) => {
			dns.resolveTxt(domain, (err, records) => {
				if (err || !records.length) return resolve(false);
				const spfRecord = records.flat().find((r) => r.startsWith("v=spf1"));
				if (!spfRecord) return resolve(false);
				resolve(spfRecord.includes(`ip4:${senderIP}`));
			});
		});
	}

	detectSpam(content: string): boolean {
		const spamKeywords = [
			"viagra",
			"lottery",
			"free money",
			"million dollars",
			"crypto scam",
			"click here",
		];
		return spamKeywords.some((keyword) =>
			content.toLowerCase().includes(keyword),
		);
	}
	private parseDkimSignature(header: string) {
		const fields = Object.fromEntries(
			header
				.split(";")
				.map((field) => field.trim().split("="))
				.filter((kv) => kv.length === 2),
		);

		return {
			v: fields["v"], // DKIM version
			a: fields["a"], // Algorithm (e.g., rsa-sha256)
			d: fields["d"], // Domain (e.g., example.com)
			s: fields["s"], // Selector (e.g., default)
			bh: fields["bh"], // Body hash
			b: fields["b"], // Signature
			h: fields["h"].split(":").map((h: string) => h.trim()), // Signed headers
		};
	}
	/**
	 * Fetches the DKIM public key from DNS
	 */
	async fetchDkimPublicKey(domain: string, selector: string): Promise<string> {
		const dnsRecord = `${selector}._domainkey.${domain}`;
		return new Promise((resolve, reject) => {
			dns.resolveTxt(dnsRecord, (err, records) => {
				if (err) return reject(err);
				const keyRecord = records.flat().find((r) => r.startsWith("v=DKIM1;"));
				if (!keyRecord) return reject(new Error("DKIM record not found"));
				const match = keyRecord.match(/p=([^;]+)/);
				if (!match) return reject(new Error("Public key not found"));
				resolve(match[1]);
			});
		});
	}
	/**
	 * Recreate the canonicalized signed headers
	 */
	private reconstructSignedHeaders(
		emailHeaders: string,
		signedHeaderFields: string[],
	): string {
		const headerMap = Object.fromEntries(
			emailHeaders
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.includes(":"))
				.map((line) => {
					const [key, ...value] = line.split(":");
					return [key.toLowerCase(), value.join(":").trim()];
				}),
		);

		return signedHeaderFields
			.map((field) => `${field}:${headerMap[field.toLowerCase()]}`)
			.join("\r\n");
	}
	/**
	 * Verify DKIM Signature
	 */
	async verifyDkimSignature(emailHeaders: string, dkimHeader: string) {
		const dkim = this.parseDkimSignature(dkimHeader);
		const publicKey = await this.fetchDkimPublicKey(dkim.d, dkim.s);
		const signedHeaders = this.reconstructSignedHeaders(emailHeaders, dkim.h);
		const signedData = signedHeaders + "\r\n";
		const signatureBuffer = Buffer.from(dkim.b, "base64");
		const pemKey = `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`;

		const verifier = crypto.createVerify("RSA-SHA256");
		verifier.update(signedData);
		const isValid = verifier.verify(pemKey, signatureBuffer);

		return isValid;
	}
	/**
	 * Canonicalize email body and compute the SHA-256 hash
	 */
	private hashEmailBody(body: string): string {
		const canonicalBody = body.trim() + "\r\n"; // DKIM relaxed body canonicalization
		return crypto.createHash("sha256").update(canonicalBody).digest("base64");
	}
	/**
	 * Canonicalize headers based on DKIM rules
	 */
	canonicalizeHeaders(
		headers: Record<string, string>,
		signedHeaders: string[],
	): string {
		return signedHeaders
			.map((field) => `${field}:${headers[field.toLowerCase()].trim()}`)
			.join("\r\n");
	}
	/**
	 * Generate a DKIM signature
	 */
	signDkim(
		headers: Record<string, string>,
		body: string,
		domain: string,
		selector: string,
		privateKeyPem: string,
	): string {
		const signedHeadersList = [
			"from",
			"subject",
			"date",
			"message-id",
			"content-type",
			"content-transfer-encoding",
			"mime-version",
		]; // Fields to sign
		const bh = this.hashEmailBody(body);

		const dkimHeader =
			`v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain}; s=${selector}; ` +
			`h=${signedHeadersList.join(":")}; bh=${bh}; b=`;

		const canonicalHeaders =
			this.canonicalizeHeaders(headers, signedHeadersList) +
			"\r\n" +
			dkimHeader;

		const signer = crypto.createSign("RSA-SHA256");
		signer.update(canonicalHeaders);
		const signature = signer.sign(privateKeyPem, "base64");

		return `DKIM-Signature: ${dkimHeader}${signature}`;
	}
}
