# This Project is Under Develepment

## [IMAP](./imap/readme.md)

[Setup Video](https://media.cm/u/H5U7)

This project started as a fun experiment but has grown into something more. Right now, it's a simple mail server for sending and receiving emails. Future updates will add:

-   **Mail Exchanger (IMAP)** – Use Gmail, Outlook, Yahoo, or Hotmail to send and receive emails.
-   **Extra Features** – SMTP relay, IP/domain whitelisting & blacklisting.
-   **AI Email Optimization** – Smart suggestions to improve email performance.
-   **Security & Anti-Spam** – AI-driven spam filtering and fraud detection.
-   **User Controls** – Rate limits, storage alerts, email forwarding, and aliases.
-   **Calendar Integration** – Works with Google Meet, Teams, and Cal.com.
-   **Developer API** – Easy-to-use API for automating emails in your apps.

---

## Architecture Overview

```
┌─────────────────────────────────────┐
│           Incoming (Port 25)        │
│  IncomingServer → IncomingHandler   │
│    ├─ DNS checks (MX, SPF, DMARC)  │
│    ├─ DKIM / SPF / DMARC auth      │
│    ├─ ARC seal (for forwarding)     │
│    ├─ Custom header injection       │
│    └─ PGP encryption → Store       │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│          Outgoing (Port 587)        │
│  OutgoingServer → OutgoingHandler   │
│    ├─ SMTP AUTH (LOGIN)             │
│    ├─ Parse email (mailparser)      │
│    ├─ Deduplicate recipients        │
│    └─ NodeMailerMTA.sendMail()      │
│         ├─ streamTransport (RFC5322)│
│         ├─ DKIM signing             │
│         ├─ DSN support              │
│         ├─ DNS-based MX delivery    │
│         └─ Parallel domain delivery │
└─────────────────────────────────────┘
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| **IncomingMailHandler** | `src/services/IncomingMailHandler.ts` | Handles MAIL FROM, RCPT TO, and DATA for inbound mail. Runs DKIM/SPF/DMARC checks in parallel, applies ARC sealing, and encrypts with PGP before storage. |
| **OutgoingMailHandler** | `src/services/OutgoingMailHandler.ts` | Handles authentication, parses outbound mail, extracts recipients from headers (To/Cc/Bcc), and delivers via the MTA with DKIM and DSN. |
| **NodeMailerMTA** | `src/server/mta/node-mta.ts` | Core mail transfer agent. Composes RFC5322 messages via `streamTransport`, signs with DKIM, resolves MX records, and delivers to all domains in parallel over single TCP connections per domain. |
| **MailAuth** | `src/server/config/mailauth.ts` | DKIM verification, SPF checks, DMARC policy evaluation, MTA-STS validation, and ARC message sealing. |
| **PGPService** | `src/server/config/encryption/PGPService.ts` | OpenPGP key generation, message encryption, and decryption for at-rest email storage. |
| **DNSChecker** | `src/server/config/DnsChecker.ts` | DNS record resolution (MX, SPF, DKIM, DMARC, TXT), IP resolution, and TCP port connectivity checks. |
| **RFC5322MailComposer** | `src/server/config/mail.composer.ts` | RFC5322-compliant header generation and MIME message composition. |

---

## Mail Transfer Agent (MTA)

The `NodeMailerMTA` class provides two delivery modes:

### Direct Delivery (DNS-based)

```ts
import { NodeMailerMTA } from "./server/mta/node-mta";

const mta = new NodeMailerMTA();

const results = await mta.sendMail({
  from: "sender@yourdomain.com",
  to: ["user@gmail.com", "user@yahoo.com", "other@gmail.com"],
  subject: "Hello",
  html: "<p>Hello World</p>",
  // DKIM signing (recommended, prevents rejection)
  dkim: {
    domainName: "yourdomain.com",
    keySelector: "default",
    privateKey: process.env.DKIM_PRIVATE_KEY,
  },
  // DSN (Delivery Status Notification)
  dsn: {
    notify: ["FAILURE", "DELAY"],
    returnHeaders: true,  // HDRS only (lighter than FULL)
  },
});

// results is DeliveryResult[] — one entry per recipient
for (const r of results) {
  console.log(`${r.recipient}: ${r.success ? "delivered" : r.error}`);
  // r.dsn.status, r.dsn.action, r.dsn.remoteMta, r.dsn.diagnosticCode
}
```

**How it works:**
1. Composes an RFC5322 message **once** using nodemailer's `streamTransport` with DKIM signing
2. Groups recipients by domain
3. Resolves MX records for all domains **in parallel** (with TTL-based caching)
4. Probes all ports (25, 587, 465) **in parallel** per MX host
5. Delivers to all domains **in parallel**, each using a single TCP connection

### Relay Delivery (Smarthost)

```ts
const results = await mta.sendViaRelay("smtp.relay.com", 587, {
  from: "sender@yourdomain.com",
  to: ["user@example.com"],
  subject: "Via relay",
  text: "Relayed message",
  auth: { user: "relay_user", pass: "relay_pass" },
  dkim: { domainName: "yourdomain.com", keySelector: "default", privateKey: "..." },
  dsn: { notify: ["SUCCESS", "FAILURE"] },
});
```

---

## Incoming Mail Pipeline

When an email arrives on port 25:

1. **MAIL FROM** — Validates sender address format, rejects `.temp@` addresses
2. **RCPT TO** — Resolves sender domain DNS (MX, SPF, DMARC, TXT), rejects if MX or SPF records missing
3. **DATA** — Full email processing:
   - Parses raw email with `mailparser`
   - Extracts sender from parsed headers (falls back to envelope)
   - Runs **DKIM, SPF, DMARC** checks **in parallel** on the original unmodified message
   - Rejects if DMARC policy is `reject` and authentication fails
   - Attaches custom `X-AE-*` headers **after** authentication (preserves DKIM signatures)
   - Seals with ARC headers (for forwarding scenarios)
   - Encrypts the final message with PGP for at-rest storage

---

## Outgoing Mail Pipeline

When a client submits mail on port 587:

1. **AUTH** — LOGIN authentication required (XOAUTH2 rejected)
2. **MAIL FROM** — Validates sender, checks for relay
3. **RCPT TO** — Logs recipient info
4. **DATA** — Full email processing:
   - Parses raw email to extract To/Cc/Bcc recipients
   - Deduplicates all recipients, falls back to envelope RCPT TO
   - Delivers via `NodeMailerMTA.sendMail()` with DKIM signing and DSN
   - Logs partial delivery failures

---

## Environment Variables

```env
# Server
INCOMING_MAIL_HOST=mx.yourdomain.com
OUTGOING_MAIL_HOST=smtp.yourdomain.com
MAIL_SERVER_IP=1.2.3.4
MAX_EMAILS_PER_MINUTE=5

# TLS
TLS_PRIVATE_KEY_PATH="/etc/letsencrypt/live/<OUTGOING_MAIL_HOST>/privkey.pem"
TLS_CERTFICATE_PATH="/etc/letsencrypt/live/<OUTGOING_MAIL_HOST>/fullchain.pem"

# DKIM (for outgoing mail signing)
DKIM_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
DKIM_SELECTOR="default"

# PGP (for incoming mail at-rest encryption)
PGP_PRIVATE_KEY="-----BEGIN PGP PRIVATE KEY BLOCK-----\n..."
PGP_PUBLIC_KEY="-----BEGIN PGP PUBLIC KEY BLOCK-----\n..."
PGP_REVOCATION_CERTIFICATE="-----BEGIN PGP PUBLIC KEY BLOCK-----\n..."
PGP_PASSPHRASE="your_secure_passphrase"
```

---
# SMTP Server Setup Guide

### Prerequisites

- A registered domain name

- A server with a static IP address

- SSL/TLS certificate for secure email transmission

### Basic Server Setup

- Configure your server with a static IP address

- Ensure your firewall allows SMTP traffic (ports 25, 465, and 587)

- Set up reverse DNS (PTR record) for your mail server IP (- Most Important)

#### Clone the Repository

Use Any Package Manager, I'm just using bun, to install check out `bun.sh`

1.  Install Dependencies First (Recommended) `bun install`

2.  Build the Applications `bun run build`, dont use `bun build`

3.  Start with command `bun run dev` (Development) and `bun run
start` with root permissions (Incase not able to start then use
    `sudo node ./build/main.js`)

## NOTE

You will find two server file config (Incoming and Outgoing) and 2 server listening at 25 and 587.
We can do it one, but we have to manage incoming and outgoing in same file, which is a mess, complicates the code. Moreover you have full controll to run multiple diffrente mail server like `mx.domain.com`, `mx2.domain.com` etc and for sending `{smtp,mail}.domain.com` (which ever is suitable).

# DNS Records Configuration
 Please Setup PTR(Reverse Lookup) and `MAIL_HOST`, `MAIL_SERVER_IP` first
### How to genrate DNS Records
1.
- ```bash chmod +x run.sh```
- ```bash ./run.sh```
2 .
- Go to src -> start.ts

- Open and replace `your_domain` with your domain name

```ts
const records = new DNSRecordGenerator("cirrusmail.cloud").generateAllRecords();
```

and Run this File, Records will create in `records.json` File in root directory.

### Essential DNS Records

![DNS Record Setup](image-1.png)

1. A Record

- Create mail.yourdomain.com pointing to your server IP
- Ensure the hostname matches SSL certificate

2 .PTR Record

- Contact your hosting provider to set up reverse DNS
- Should match your mail server's hostname

Share your Mailserver hostname, who ever wants to use your server and tell them to create MX Record pointing your server.

- Point to your mail server hostname
- Set priority (e.g., 10 mail.yourdomain.com)
  ![MX Record Setup](image.png)

# Anti-Spam DNS Records

![Anti-Spam DNS Records Setup](image-2.png)

1. SPF Record (TXT)

- Add record: v=spf1 ip4:YOUR_IP mx -all
- Prevents email spoofing
- Specifies authorized IPs/servers


2. DKIM Record

- Generate DKIM keys
- Add public key to DNS as TXT record
- Format: default._domainkey.yourdomain.com


3. DMARC Record

- Add TXT record: _dmarc.yourdomain.com
- Define policy for failed authentications
- Set up reporting (optional)


### Note: Required Ports => 25, 587

#### Port 25 is used for receiving mails and outbound traffice to send mail from your server to another mail server

#### Port 587 is used for to connection to your mail server and create transport which send mail and process the mail , how it is going to deliver via Direct or Relay

### Generate SSL Ceritificate for using STARTTLS to prevent spam. Dont use Self Signed Certificate

Mail Server SSL Certificate Setup

Simple guide to secure your mail server with Let's Encrypt/ZeroSSL certificates using Certbot. This setup enables encrypted SMTP connections and works with any transport method (relay or direct delivery).

### Prerequisites

Linux server with root access

Domain with DNS A record pointing to your server

Port 80 temporarily available for verification

### Installation Steps

Install Certbot:

```bash

sudo  apt  update

sudo  apt  install  certbot

```

Generate certificate:

```bash

sudo  certbot  certonly  --standalone  --preferred-challenges  http  -d  mail.domain.com

```

Certificate locations:

Certificate: /etc/letsencrypt/live/mail.domain.com/fullchain.pem

Private key: /etc/letsencrypt/live/mail.domain.com/privkey.pem

 

```env
# Server
INCOMING_MAIL_HOST=mx.yourdomain.com
OUTGOING_MAIL_HOST=smtp.yourdomain.com
MAIL_SERVER_IP=1.2.3.4
MAX_EMAILS_PER_MINUTE=5

# TLS
TLS_PRIVATE_KEY_PATH="/etc/letsencrypt/live/<OUTGOING_MAIL_HOST>/privkey.pem"
TLS_CERTFICATE_PATH="/etc/letsencrypt/live/<OUTGOING_MAIL_HOST>/fullchain.pem"

# DKIM (for outgoing mail signing)
DKIM_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
DKIM_SELECTOR="default"

# PGP (for incoming mail at-rest encryption)
PGP_PRIVATE_KEY="-----BEGIN PGP PRIVATE KEY BLOCK-----\n..."
PGP_PUBLIC_KEY="-----BEGIN PGP PUBLIC KEY BLOCK-----\n..."
PGP_REVOCATION_CERTIFICATE="-----BEGIN PGP PUBLIC KEY BLOCK-----\n..."
PGP_PASSPHRASE="your_secure_passphrase"
```
### Testing

- Run mail server tests:
- Verify all DNS records
- Test SMTP authentication
- Check TLS encryption
- Verify reverse DNS
- Test sending/receiving
### Use external tools:
Go and Test Your Mail Server  here , it should be like in given Image https://mxtoolbox.com/diagnostic.aspx
![See image](image-3.png)

 
# iCalendar event for Nodemailer - Resources
### Step 1: Enable Google Calendar API
 - Go to the Google Cloud Console.
 - Create a new project or select an existing one.
 - Enable the Google Calendar API for the project.
 - Create OAuth 2.0 credentials or a service account for authentication.
 - Download the credentials JSON file.

```bash
npm install googleapis nodemailer ics
```
## Integration
- [x]  Google Meet/Calender
- [ ]  Cal.com
- [ ]  Zoho Calender
- [ ]  Zoom Meetings


### Calender UI
- https://shadcn-cal-com.vercel.app/?date=2025-03-02
- https://github.com/Mina-Massoud/next-ui-full-calendar
- https://github.com/schedule-x/schedule-x
- https://synergy-platform.vercel.app/calendar
- https://github.com/charlietlamb/calendar
- https://github.com/list-jonas/shadcn-ui-big-calendar

---

## Project Structure

```
src/
├── main.ts                          # Entry point
├── start.ts                         # DNS record generation
├── interfaces/                      # TypeScript interfaces
│   ├── dns.interface.ts             # DNS record types
│   ├── domain.interface.ts          # Domain types
│   ├── mail.interface.ts            # Mail data DTOs
│   └── openpgp.interface.ts         # PGP key types
├── lib/
│   ├── helpers/index.ts             # Email extraction, utilities
│   ├── logs/index.ts                # Logging
│   └── types/index.d.ts            # SMTP server type extensions
├── server/
│   ├── IncomingServer.ts            # Port 25 SMTP server config
│   ├── OutgoingServer.ts            # Port 587 SMTP server config
│   ├── config/
│   │   ├── DnsChecker.ts            # DNS resolution & connectivity
│   │   ├── DnsRecordGenrator.ts     # DNS record generation
│   │   ├── mail.composer.ts         # RFC5322 header/MIME composition
│   │   ├── mailauth.ts             # DKIM/SPF/DMARC/ARC auth
│   │   ├── MailConfig.ts           # Email parsing & transport
│   │   ├── SpamFilteration.ts      # Spam filtering
│   │   └── encryption/
│   │       ├── PGPAdapter.ts        # OpenPGP encrypt/decrypt
│   │       ├── PGPFactory.ts        # Key generation
│   │       └── PGPService.ts        # PGP service facade
│   ├── mta/
│   │   └── node-mta.ts             # Mail Transfer Agent (DKIM + DSN)
│   └── plugins/
│       ├── FiltersEngine.ts         # Email filtering
│       ├── ImageProxyServer.ts      # Image proxy for tracking protection
│       ├── MailRateLimiter.ts       # Rate limiting
│       └── TrackingProtection.ts    # Tracking pixel removal
└── services/
    ├── IcsEvents.ts                 # iCalendar event handling
    ├── IncomingMailHandler.ts       # Inbound mail processing
    ├── MeetingService.ts            # Meeting integration
    └── OutgoingMailHandler.ts       # Outbound mail processing
```

---

## DeliveryResult Reference

Each call to `mta.sendMail()` or `mta.sendViaRelay()` returns `DeliveryResult[]`:

```ts
interface DeliveryResult {
  success: boolean;           // true if accepted by remote MX
  recipient: string;          // email address
  response?: string;          // SMTP response string
  error?: string;             // error message if failed
  dsn?: {
    status: string;           // e.g. "2.0.0", "5.1.2", "4.0.0"
    action: "delivered" | "failed" | "delayed" | "relayed" | "expanded";
    diagnosticCode?: string;  // remote server diagnostic
    remoteMta?: string;       // MX host that handled delivery
    finalRecipient: string;   // RFC5321 recipient
  };
}
```

### DSN Status Codes

| Code | Meaning |
|------|---------|
| `2.0.0` | Successfully delivered |
| `4.0.0` | Temporary failure (retry later) |
| `5.0.0` | Permanent failure (rejected) |
| `5.1.2` | No MX records / unreachable domain |

