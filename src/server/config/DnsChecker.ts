import { DNSRecordType, DNSResponse } from "../../interfaces/dns.interface";
import dns from "dns/promises";
import moment from "moment";
import net from 'net';



export class DNSChecker {
  private domain: string;
  private dkimSelector: string;


  constructor(domain: string, dkimSelector: string = moment().format('YYYYMM')) {
    this.domain = domain;
    this.dkimSelector = dkimSelector;
  }

  signEmail(privateKey: string, rawEmail?: string,): string {
    const DKIMSign = require("dkim-signer").DKIMSign;

    const rfc822message = "Subject: test\r\n\r\nHello world";

    const dkimOptions = {
      domainName: "cirrusmail.cloud",
      keySelector: "dkim",
      privateKey,
    };

    return DKIMSign(rfc822message, dkimOptions);

    // const DKIMSignature = require('dkim-signature');
    // const signature = new DKIMSignature({
    //     domain: 'example.test',
    //     selector: 'default',
    //     algorithm: 'rsa-sha256',
    //     headers: ['from', 'to', 'date', 'subject'],
    //     bodyHash: '2jmj7l5rSw0yVb/vlWAYkK/YBwk=',
    //     data: '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='
    // })
    // return signature.toString();

    // const privateKey = crypto.readFileSync('./keys/dkim_private.pem', 'utf8');
    // const signer = crypto.createSign('RSA-SHA256');
    // signer.update(rawEmail);
    // const signature = signer.sign(privateKey, 'base64');
    // return `${rawEmail}\nDKIM-Signature: ${signature}`;
  }


  /**
   * Resolves the DNS records for a given hostname using DNS over HTTPS.
   * @param hostname - The hostname to resolve.
   * @returns A promise that resolves to an array of IP addresses as strings.
   */
  static async resolveRecords(domain: string): Promise<any> {
    try {
      const mxRecords = await dns.resolveMx(domain);
      const spfRecords = await dns.resolveTxt(domain);
      const dmarcRecords = await dns.resolveTxt('_dmarc.' + domain);
      const txtRecords = await dns.resolveTxt(domain);
      const nsRecords = await dns.resolveNs(domain);
      // const srvRecords = await dns.resolveSrv(domain);
      const validDomain = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain);
      return { mxRecords, spfRecords, dmarcRecords, txtRecords, validDomain, nsRecords };
    } catch (error) {
      console.log(error)
    }

  }
  static resolveDNS(hostname: string, type: DNSRecordType = "A"): Promise<DNSResponse> {
    return new Promise((resolve, reject) => {
      fetch(`https://dns.google/resolve?name=${hostname}&type=${type}`, {
        method: 'GET',
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "User-Agentr": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        }
      })
        .then((res) => res.json()).then((result:any) => resolve(result)).catch((error) => reject(error));

    });
  }
  static checkRecordsExistOrNot(hostname: string, type: DNSRecordType = "A"): Promise<boolean> {
    return this.resolveDNS(hostname, type).then((result) => result.Answer.length > 0);
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
  async checkAllRecords(expectedRecords: Record<string, string>): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    results["SPF"] = await this.checkSPF(expectedRecords["SPF"]);
    results["DKIM"] = await this.checkDKIM(expectedRecords["DKIM"]);
    results["DMARC"] = await this.checkDMARC(expectedRecords["DMARC"]);
    results["MX"] = await this.checkMX(expectedRecords["MX"]);

    return results;
  }
}

