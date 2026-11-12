import type { MxRecord } from "dns";
import dns from "dns/promises";
import moment from "moment";
import net from "net";
import type {
	DNSRecordType,
	DNSResponse,
	SenderDomainRecords,
} from "../../interfaces/dns.interface";
import { TtlCache } from "../../lib/helpers/TtlCache";

const NOT_FOUND_CODES = new Set(["ENODATA", "ENOTFOUND"]);

export class DNSChecker {
	private static recordsCache = new TtlCache<string, SenderDomainRecords>(
		10_000,
		5 * 60 * 1000,
	);
	private domain: string;
	private dkimSelector: string;

	constructor(
		domain: string,
		dkimSelector: string = moment().format("YYYYMM"),
	) {
		this.domain = domain;
		this.dkimSelector = dkimSelector;
	}
	/**
	 * Resolves the DNS records for a given hostname using DNS over HTTPS.
	 * @param hostname - The hostname to resolve.
	 * @returns A promise that resolves to an array of IP addresses as strings.
	 */
	static async resolveIP(hostname: string): Promise<string[]> {
		try {
			return await dns.resolve4(hostname);
		} catch (error) {
			console.error(`❌ Failed to fetch IP addresses for ${hostname}:`, error);
			return [];
		}
	}
	static async getMXRecords(
		domain: string,
	): Promise<{ exchange: string; records: MxRecord[] } | null> {
		try {
			const records = await dns.resolveMx(domain);
			records.sort((a, b) => a.priority - b.priority); // Sort by priority
			return { exchange: records[0].exchange, records }; // Return primary mail server
		} catch (error) {
			console.error(`❌ Failed to fetch MX records for ${domain}:`, error);
			return null;
		}
	}

	/**
	 * Resolves the DNS records for a given hostname using DNS over HTTPS.
	 * @param hostname - The hostname to resolve.
	 * @returns A promise that resolves to an array of IP addresses as strings.
	 */
	static async resolveRecords(domain: string): Promise<SenderDomainRecords> {
		const key = domain.toLowerCase();
		const cached = DNSChecker.recordsCache.get(key);
		if (cached) return cached;

		let temporaryFailure = false;
		const recordsOf = <T>(result: PromiseSettledResult<T[]>): T[] => {
			if (result.status === "fulfilled") return result.value;
			if (!NOT_FOUND_CODES.has(result.reason?.code)) temporaryFailure = true;
			return [];
		};

		const [mx, txt, dmarc, ns] = await Promise.allSettled([
			dns.resolveMx(key),
			dns.resolveTxt(key),
			dns.resolveTxt(`_dmarc.${key}`),
			dns.resolveNs(key),
		]);
		const mxRecords = recordsOf(mx);
		const txtRecords = recordsOf(txt);
		const [a, aaaa] = mxRecords.length
			? []
			: await Promise.allSettled([dns.resolve4(key), dns.resolve6(key)]);

		const records: SenderDomainRecords = {
			mxRecords,
			txtRecords,
			spfRecords: txtRecords.filter((r) =>
				r.join("").toLowerCase().startsWith("v=spf1"),
			),
			dmarcRecords: recordsOf(dmarc),
			nsRecords: recordsOf(ns),
			aRecords: a ? recordsOf(a) : [],
			aaaaRecords: aaaa ? recordsOf(aaaa) : [],
			validDomain: /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(key),
			temporaryFailure,
		};
		if (!temporaryFailure) DNSChecker.recordsCache.set(key, records);
		return records;
	}
	static resolveDNS(
		hostname: string,
		type: DNSRecordType = "A",
	): Promise<DNSResponse> {
		return new Promise((resolve, reject) => {
			fetch(`https://dns.google/resolve?name=${hostname}&type=${type}`, {
				method: "GET",
				headers: {
					Accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
					"User-Agentr":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
				},
			})
				.then((res) => res.json())
				.then((result: any) => resolve(result))
				.catch((error) => reject(error));
		});
	}
	static checkRecordsExistOrNot(
		hostname: string,
		type: DNSRecordType = "A",
	): Promise<boolean> {
		return DNSChecker.resolveDNS(hostname, type).then(
			(result) => result.Answer.length > 0,
		);
	}
	static filterMXRecord(mxRecord: string): string {
		return mxRecord.replace(/^\d+\s*/, "").trim();
	}
	static tryConnect(host: string, port: number): Promise<boolean> {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection(port, host, () => {
				socket.destroy(); // Close the connection
				resolve(true);
			});
			socket.on("error", (err) => {
				socket.destroy();
				reject(false);
			});

			socket.setTimeout(5000, () => {
				socket.destroy();
				reject(false);
			});
		});
	}
	/**
	 * Check SPF record
	 */
	async checkSPF(expectedSPF: string): Promise<boolean> {
		try {
			const records = await dns.resolveTxt(this.domain);
			const spfRecord = records.flat().find((txt) => txt.startsWith("v=spf1"));
			return spfRecord === expectedSPF;
		} catch (error) {
			console.error("SPF check failed:", error);
			return false;
		}
	}

	/**
	 * Check DKIM record
	 */
	async checkDKIM(expectedDKIM: string): Promise<boolean> {
		try {
			const dkimRecordName = `${this.dkimSelector}._domainkey.${this.domain}`;
			const records = await dns.resolveTxt(dkimRecordName);
			const dkimRecord = records.flat().join("");
			return dkimRecord.includes(expectedDKIM);
		} catch (error) {
			console.error("DKIM check failed:", error);
			return false;
		}
	}

	/**
	 * Check DMARC record
	 */
	async checkDMARC(expectedDMARC: string): Promise<boolean> {
		try {
			const dmarcRecordName = `_dmarc.${this.domain}`;
			const records = await dns.resolveTxt(dmarcRecordName);
			const dmarcRecord = records.flat().join("");
			return dmarcRecord === expectedDMARC;
		} catch (error) {
			console.error("DMARC check failed:", error);
			return false;
		}
	}

	/**
	 * Check MX records
	 */
	async checkMX(expectedMX: string): Promise<boolean> {
		try {
			const mxRecords = await dns.resolveMx(this.domain);
			return mxRecords.some((record) => record.exchange === expectedMX);
		} catch (error) {
			console.error("MX check failed:", error);
			return false;
		}
	}

	/**
	 * Check custom TXT record
	 */
	async checkTXT(name: string, expectedValue: string): Promise<boolean> {
		try {
			const records = await dns.resolveTxt(`${name}.${this.domain}`);
			const txtRecord = records.flat().join("");
			return txtRecord.includes(expectedValue);
		} catch (error) {
			console.error("TXT check failed:", error);
			return false;
		}
	}

	/**
	 * Run all checks and return results
	 */
	async checkAllRecords(
		expectedRecords: Record<string, string>,
	): Promise<Record<string, boolean>> {
		const results: Record<string, boolean> = {};

		results["SPF"] = await this.checkSPF(expectedRecords["SPF"]);
		results["DKIM"] = await this.checkDKIM(expectedRecords["DKIM"]);
		results["DMARC"] = await this.checkDMARC(expectedRecords["DMARC"]);
		results["MX"] = await this.checkMX(expectedRecords["MX"]);

		return results;
	}
}
