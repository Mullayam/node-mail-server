import { readFileSync } from "fs"
 
import { join } from "path"
 
import { DNSChecker } from "@/server/config/DnsChecker"
import { RFC5322MailComposer } from "./mail.composer"
type ARC_OPTIONS = {
    headers: Record<string, string>,

} & ({
    change_subject?: false

} | {
    change_subject?: true,
    subject: string
})
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
    "v": string,
    "p": "none" | "reject" | "quarantine",
    "pct"?: number,
    "rua": string,
    "sp"?: string,
    "aspf"?: string
    "rr"?: string,
    "isOrgRecord": boolean,
    [key: string]: any
}
interface DkimResults {
    headers: string[],
    envelopeFrom: boolean,
    results: [
        {
            status: { result: string, comment: string },
            info: string
        }
    ],

}

export class MailAuth {

    constructor(private readonly mailchunks: string | Buffer, private readonly fromMail: string, private readonly domain: string) {
        this.mailchunks = mailchunks
        this.fromMail = fromMail
        this.domain = domain
    }
    async getPureObject() {
        const { authenticate, } = require('mailauth');

        return authenticate(this.mailchunks, {})
    }
    async getSpfCheckAll(): Promise<any[]> {
        try {

            const results = [];
            const result = await DNSChecker.getMXRecords(this.domain);
            if (!result) {
                return []
            }
            for (const mx of result.records) {
                const ipAddresses = await DNSChecker.resolveIP(mx.exchange);
                const r = await this.getSpfCheck(ipAddresses[0], mx.exchange)
                results.push({ info: r.info, header: r.header });
            }
            return results
        } catch (error) {
            return []
        }
    }
    async mtaValidation(mx: string) {
        const { validateMx } = require('mailauth/lib/mta-sts');
        const { getPolicy } = require('mailauth/lib/mta-sts');

        const validation = validateMx(mx) as { valid: boolean, mode: string, match: string, testing: boolean }

        const { policy } = await getPolicy(this.domain);

        const policyMatch = validateMx(mx, policy) as {
            id: string,
            mode: string,
            version: string,
            mx: string,
            maxAge: number,
            expires: string
        }

        return { validation, policyMatch }
    }
    async getDmarcRecord(): Promise<DmarcRecord> {
        const getDmarcRecord = require('mailauth/lib/dmarc/get-dmarc-record');
        return getDmarcRecord(this.domain);

    }
    async dkimCheck() {
        const { dkimVerify } = require('mailauth/lib/dkim/verify');
        return dkimVerify(this.mailchunks) as Promise<DkimResults>
    }

    async getPolicy() {
        const { getPolicy } = require('mailauth/lib/mta-sts');
        return getPolicy(this.domain) as Promise<{
            policy: { id: false, mode: string },
            status: "not_found" | "errored" | "cached" | "found" | "renew"
        }>
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
        const { spf } = require('mailauth/lib/spf');


        return spf({ sender: this.fromMail, ip, mta }) as {
            domain: string,
            'client-ip': string,
            'envelope-from': string,
            rr: string,
            status: {
                result: string,
                comment: string,
                smtp: { mailfrom: string, helo: 'foo' }
            },
            header: string,
            info: string,
            lookups: { limit: number, count: number, void: number, subqueries: {} }
        }
    }
    async validateArcSeal() {
        const { authenticate } = require('mailauth');
        const { arc } = await authenticate(this.mailchunks, {
            trustReceived: true,
        })
        return arc as {
            "status": {
                "result": string,
                "comment": string
            },
            [key: string]: any
        }
    }
    async sealMessage(sealDuringAuthentication: boolean = true, options: Partial<ARC_OPTIONS> = {}) {
        const result = await DNSChecker.getMXRecords(this.domain);
        if (!result) return

        // Read the private key and prepare for signing the ARC-Seal header
        // Replace with the path to your private key
        const privateKey = readFileSync(join(process.cwd(), "./keys/airsend_arc1._domainkey.airsend.rsa.rsa.private.key"), "utf-8");
        const { authenticate, sealMessage } = require('mailauth');
        const ipAddresses = await DNSChecker.resolveIP(result?.exchange as string);
        let { arc, headers } = await authenticate(this.mailchunks, {
            sender: this.fromMail,
            ip: ipAddresses[0],
            disableBimi: true,
            mta: result?.exchange,
            seal: {
                signingDomain: "airsend.in",
                selector: 'airsend_arc1',
                privateKey,
            },
        });
        headers = options?.headers ? headers + RFC5322MailComposer.createRfc822Headers(options.headers) : headers

        if (sealDuringAuthentication) {
            return { arc, headers }
        }

        const sealHeaders = await sealMessage(this.mailchunks, {
            signingDomain: "airsend.in",
            selector: 'airsend_arc1', // Replace with your DKIM selector
            privateKey,
            authResults: arc.authResults,
            cv: arc.status.result,
        });
        const modifiedHeaders = options?.headers ? sealHeaders.toString() + RFC5322MailComposer.createRfc822Headers(options.headers) : headers

        return { arc, headers: modifiedHeaders }


    }
}