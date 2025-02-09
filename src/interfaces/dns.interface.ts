export type DNSRecordType =
    | "A"      // IPv4 address
    | "AAAA"   // IPv6 address
    | "MX"     // Mail Exchange
    | "SPF"    // Sender Policy Framework
    | "DMARC"  // Domain-based Message Authentication, Reporting & Conformance
    | "TXT"    // Text Record
    | "CNAME"  // Canonical Name
    | "PTR"    // Pointer Record (reverse DNS)
    | "NS"     // Name Server
    | "SRV"    // Service Locator
    | "SOA"    // Start of Authority
    | "CAA"    // Certification Authority Authorization
    | "DNSSEC" // DNS Security Extensions
    | "TLSA"   // TLSA (DANE)
    | "DS"     // Delegation Signer
    | "HINFO"  // Host Information
    | "LOC";
export interface DNSResponse {
    Status: number;
    TC: boolean;
    RD: boolean;
    RA: boolean;
    AD: boolean;
    CD: boolean;
    Question: Question[];
    Answer: Answer[];
    Authority: Answer[];
    Comment: string;
}

export interface Answer {
    name: string;
    type: number;
    TTL: number;
    data: string;
}

export interface Question {
    name: string;
    type: number;
}
export type RecordTypeRespose = {
    type: number,
    name:string,
    ttl: number,
    data:string
  }