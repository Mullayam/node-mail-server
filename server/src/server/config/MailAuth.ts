import { readFileSync } from "fs";
import { env } from "../../config/env";
import { Logging } from "../../lib/logs";
import { RFC5322MailComposer } from "./MailComposer";

type ARC_OPTIONS = {
	headers: Record<string, string>;
} & (
	| {
			change_subject?: false;
	  }
	| {
			change_subject?: true;
			subject: string;
	  }
);
interface DkimVerificationResult {
	id: string;
	signingDomain: string;
	selector: string;
	signature: string;
	algo: string;
	format: string;
	bodyHash: string;
	bodyHashExpecting: string;
	signingHeaders: {
		keys: string;
		headers: string[];
		canonicalizedHeader: string;
	};
	status: {
		result: string;
		comment: string;
		header: Record<string, any>;
		aligned: string;
	};
	sourceBodyLength: number;
	canonBodyLength: number;
	canonBodyLengthTotal: number;
	canonBodyLengthLimited: boolean;
	mimeStructureStart: number;
	publicKey: string;
	modulusLength: number;
	rr: string;
	info: string;
}

type DkimVerificationResults = DkimVerificationResult[];

interface DmarcRecord {
	v: string;
	p: "none" | "reject" | "quarantine";
	pct?: number;
	rua: string;
	sp?: string;
	aspf?: string;
	rr?: string;
	isOrgRecord: boolean;
	[key: string]: any;
}
interface DkimResults {
	headers: string[];
	envelopeFrom: boolean;
	results: [
		{
			status: { result: string; comment: string };
			info: string;
		},
	];
}
interface ArcSealConfig {
	signingDomain: string;
	selector: string;
	privateKey: string;
}
interface AuthenticateOptions {
	ip: string;
	helo?: string;
	mta: string;
	seal?: boolean;
}
export interface AuthenticationResult {
	dkim: { results?: DkimResults["results"] };
	spf: { status?: { result: string } } | false;
	dmarc:
		| {
				status: { result: string };
				domain: string;
				policy?: string;
				pct?: number | string;
		  }
		| false;
	arc: { status?: { result: string } } | false;
	headers: string;
}

let arcSealConfig: ArcSealConfig | null | undefined;

export class MailAuth {
	constructor(
		private readonly mailchunks: string | Buffer,
		private readonly fromMail: string,
		private readonly domain: string,
	) {
		this.mailchunks = mailchunks;
		this.fromMail = fromMail;
		this.domain = domain;
	}
	async getPureObject() {
		const { authenticate } = require("mailauth");

		return authenticate(this.mailchunks, {});
	}
	static getArcSealConfig(): ArcSealConfig | null {
		if (arcSealConfig !== undefined) return arcSealConfig;
		const { privateKeyPath: keyPath, signingDomain, selector } = env.arc;
		arcSealConfig = null;
		if (keyPath && signingDomain) {
			try {
				arcSealConfig = {
					signingDomain,
					selector,
					privateKey: readFileSync(keyPath, "utf-8"),
				};
			} catch (error) {
				Logging.dev(
					`ARC sealing disabled, cannot read ${keyPath}: ${error}`,
					"error",
				);
			}
		}
		return arcSealConfig;
	}
	async authenticateMessage({
		ip,
		helo,
		mta,
		seal = false,
	}: AuthenticateOptions): Promise<AuthenticationResult> {
		const { authenticate } = require("mailauth");
		const sealConfig = seal ? MailAuth.getArcSealConfig() : null;
		return authenticate(this.mailchunks, {
			ip,
			helo,
			mta,
			sender: this.fromMail,
			disableBimi: true,
			...(sealConfig ? { seal: sealConfig } : {}),
		});
	}
	async mtaValidation(mx: string) {
		const { validateMx } = require("mailauth/lib/mta-sts");
		const { getPolicy } = require("mailauth/lib/mta-sts");

		const validation = validateMx(mx) as {
			valid: boolean;
			mode: string;
			match: string;
			testing: boolean;
		};

		const { policy } = await getPolicy(this.domain);

		const policyMatch = validateMx(mx, policy) as {
			id: string;
			mode: string;
			version: string;
			mx: string;
			maxAge: number;
			expires: string;
		};

		return { validation, policyMatch };
	}
	async getDmarcRecord(): Promise<DmarcRecord> {
		const getDmarcRecord = require("mailauth/lib/dmarc/get-dmarc-record");
		return getDmarcRecord(this.domain);
	}
	async dkimCheck() {
		const { dkimVerify } = require("mailauth/lib/dkim/verify");
		return dkimVerify(this.mailchunks) as Promise<DkimResults>;
	}

	async getPolicy() {
		const { getPolicy } = require("mailauth/lib/mta-sts");
		return getPolicy(this.domain) as Promise<{
			policy: { id: false; mode: string };
			status: "not_found" | "errored" | "cached" | "found" | "renew";
		}>;
	}

	/**    
     * @example if (policy.id !== knownPolicy?.id) {
                // Update your cache with the new policy
                }

                if (policy.mode === 'enforce') {
                // TLS must be used when sending to this domain
                }
     */
	async getSpfCheck(ip: string, mta: string) {
		const { spf } = require("mailauth/lib/spf");

		return spf({ sender: this.fromMail, ip, mta }) as {
			domain: string;
			"client-ip": string;
			"envelope-from": string;
			rr: string;
			status: {
				result: string;
				comment: string;
				smtp: { mailfrom: string; helo: "foo" };
			};
			header: string;
			info: string;
			lookups: { limit: number; count: number; void: number; subqueries: {} };
		};
	}
	async validateArcSeal() {
		const { authenticate } = require("mailauth");
		const { arc } = await authenticate(this.mailchunks, {
			trustReceived: true,
		});
		return arc as {
			status: {
				result: string;
				comment: string;
			};
			[key: string]: any;
		};
	}
	async sealMessage(
		connection: Omit<AuthenticateOptions, "seal">,
		options: Partial<ARC_OPTIONS> = {},
	) {
		if (!MailAuth.getArcSealConfig()) return;
		const { arc, headers } = await this.authenticateMessage({
			...connection,
			seal: true,
		});
		return {
			arc,
			headers: options.headers
				? headers + RFC5322MailComposer.createRfc822Headers(options.headers)
				: headers,
		};
	}
}
