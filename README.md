# This Project is Under Develepment

## [IMAP](./server/imap/readme.md)

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
| **IncomingMailHandler** | `server/src/services/IncomingMailHandler.ts` | Handles MAIL FROM, RCPT TO, and DATA for inbound mail. Runs DKIM/SPF/DMARC checks in parallel, applies ARC sealing, and encrypts with PGP before storage. |
| **OutgoingMailHandler** | `server/src/services/OutgoingMailHandler.ts` | Handles authentication, parses outbound mail, extracts recipients from headers (To/Cc/Bcc), and delivers via the MTA with DKIM and DSN. |
| **NodeMailerMTA** | `server/src/server/mta/node-mta.ts` | Core mail transfer agent. Composes RFC5322 messages via `streamTransport`, signs with DKIM, resolves MX records, and delivers to all domains in parallel over single TCP connections per domain. |
| **MailAuth** | `server/src/server/config/MailAuth.ts` | DKIM verification, SPF checks, DMARC policy evaluation, MTA-STS validation, and ARC message sealing. |
| **PGPService** | `server/src/server/config/encryption/PGPService.ts` | OpenPGP key generation, message encryption, and decryption for at-rest email storage. |
| **DNSChecker** | `server/src/server/config/DnsChecker.ts` | DNS record resolution (MX, SPF, DKIM, DMARC, TXT), IP resolution, and TCP port connectivity checks. |
| **RFC5322MailComposer** | `server/src/server/config/MailComposer.ts` | RFC5322-compliant header generation and MIME message composition. |

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

1. **Connect** — Optional reverse DNS check (`checks.reverseDns`)
2. **MAIL FROM** — Rate limit per IP (temporary `421` when exceeded), rejects `.temp@` addresses, checks the sender domain has an MX, A or AAAA record (`checks.senderDomain`). Bounces (`MAIL FROM:<>`) skip the domain check.
3. **RCPT TO** — Recipient limit, accepted domains and known recipients (`incoming.recipients`)
4. **DATA** — Full email processing:
   - Enforces `incoming.maxMessageSizeBytes`
   - Runs **DKIM, SPF and DMARC** with `mailauth` against the connecting client IP and HELO, on the original unmodified message
   - Applies the action configured for each result (`checks.spf`, `checks.dkim`, `checks.dmarc`)
   - Strips sender-supplied `X-AE-*` headers and forged `Authentication-Results`, then adds ours
   - Seals with ARC headers when enabled and `ARC_PRIVATE_KEY_PATH` and `ARC_SIGNING_DOMAIN` are set
   - Encrypts the final message with PGP for at-rest storage when enabled and PGP keys are set

AUTH is disabled on port 25. The `checks.*` and `incoming.*` names refer to `mail.config.json` (see [Configuration files](#configuration-files)).

---

## Outgoing Mail Pipeline

When a client submits mail on port 587:

1. **AUTH** — LOGIN authentication required (XOAUTH2 rejected)
2. **MAIL FROM** — Validates sender, checks for relay
3. **RCPT TO** — Logs recipient info
4. **DATA** — Full email processing:
   - Recipients come only from the SMTP envelope (RCPT TO), so Bcc works and is never exposed
   - Removes any `Bcc:` header and keeps the original message otherwise unchanged
   - Adds `X-AE-Queue-Id`, the bounce address header and any custom headers from `outgoing.customHeaders`
   - Signs with DKIM, writes the message to the outbound queue and replies `250 Message queued as <id>`

The JSON send API (below) uses the same steps after it builds the MIME message.

### Outgoing headers

| Header | When | Setting |
|--------|------|---------|
| `X-AE-Queue-Id: <id>` | Always | none |
| `X-AE-Bounce-Address: bounce+<id>@BOUNCE_DOMAIN` | When `BOUNCE_DOMAIN` is set | `outgoing.bounceHeader.enabled`, `outgoing.bounceHeader.name` |
| Your own headers | When `outgoing.customHeaders.enabled` is `true` | `outgoing.customHeaders.headers` |

Custom header values can use `{queueId}` and `{sender}`, for example:

```json
"customHeaders": {
	"enabled": true,
	"headers": { "X-Campaign": "spring-{queueId}", "List-Unsubscribe": "<mailto:unsubscribe@yourdomain.com?subject={queueId}>" }
}
```

A header set here replaces a header with the same name sent by the client.

### JSON send API

Send mail as JSON instead of SMTP. The server builds the MIME message (in a worker thread), then runs it through the same pipeline as port 587.
Turn it on with `MAIL_API_TOKEN` (and `api.enabled` in `mail.config.json`). It listens on `MAIL_API_PORT` (default `8080`).

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "Authorization: Bearer $MAIL_API_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "from": { "name": "Me", "address": "me@yourdomain.com" },
    "to": "user@example.com",
    "cc": ["Team <team@example.com>"],
    "bcc": "audit@yourdomain.com",
    "replyTo": "support@yourdomain.com",
    "subject": "Hello",
    "text": "Plain text body",
    "html": "<p>HTML body</p>",
    "headers": { "X-Order-Id": "1234" },
    "attachments": [{ "filename": "invoice.pdf", "content": "<base64>", "contentType": "application/pdf" }]
  }'
```

- Required: `from`, at least one of `to`, `cc` or `bcc`, and `text` or `html`
- Addresses can be `"a@b.com"`, `"Name <a@b.com>"`, `{ "name", "address" }`, or a list of these
- `bcc` addresses get the message but never appear in its headers
- `headers` can't set `From`, `To`, `Cc`, `Bcc`, `Subject`, `Content-Type` or other structural headers
- Answers `202 { id, from, recipients }`. Errors answer `400` with a message, `401` without the token, `413` when too large, and `429` when rate limited

### Outbound queue

Queued mail is stored in `MAIL_SPOOL_DIR` and survives restarts. Each recipient is tracked separately:

- Delivered: removed from the queue
- Permanent failure (`5xx`): removed and logged
- Temporary failure (`4xx`, timeout, connection refused): retried on the `queue.retryDelaysMinutes` schedule (1, 5, 15, 30, 60, 120, then every 240 minutes) until `queue.maxAgeHours`

Delivery goes straight to the recipient's MX, or to `OUTBOUND_RELAY_HOST` (for example KumoMTA) when set.
Direct delivery follows the recipient domain's MTA-STS policy: in `enforce` mode it requires TLS with a valid certificate and an allowed MX. Relay connections always verify the certificate, except on loopback.

### Outbound drivers

`OUTBOUND_DRIVER` decides what the queue does with each message. Retries, suppression and bounces work the same for every driver.

| Driver | What it does | Settings |
|--------|--------------|----------|
| `direct` (default) | Node MTA delivers straight to the recipient's MX | none |
| `go` | Go MTA service (`server/go-mta`) delivers to the MX | `GO_MTA_URL`, `GO_MTA_TOKEN` |
| `relay` | SMTP submission to another MTA, such as KumoMTA on the private network | `OUTBOUND_RELAY_*` |
| `kumo-http` | KumoMTA HTTP injection API (`/api/inject/v1`) | `KUMO_HTTP_URL`, `KUMO_HTTP_USER`, `KUMO_HTTP_PASS` |

With `relay` or `kumo-http`, KumoMTA doesn't need to be reachable from the internet. Only the Node app talks to it.
If KumoMTA signs DKIM, leave `DKIM_PRIVATE_KEY` empty so the message isn't signed twice.

**What KumoMTA needs from each driver**

| | `relay` (SMTP) | `kumo-http` |
|---|---|---|
| Message | The raw MIME message, unchanged | The raw MIME message as the `content` string |
| Sender | `MAIL FROM` | `envelope_sender` (required) |
| To, Cc, Bcc | One `RCPT TO` per address. To and Cc stay in the message headers | Every address in `recipients` (required). To and Cc stay in the message headers |
| Access | `relay_hosts` and SMTP AUTH on the listener | `trusted_hosts` on the HTTP listener, optional Basic auth |

- `kumo-http` sends `template_dialect: "Static"`, so KumoMTA doesn't run the message through its template engine. A `{{` in a message would otherwise be changed. KumoMTA older than 2025.12.02 doesn't know this field; set `KUMO_HTTP_STATIC_CONTENT=false` for those.
- `kumo-http` sends the message as JSON text, so it needs valid UTF-8. Use `relay` for 8-bit messages in other charsets.
- KumoMTA's own JSON "builder" form (`content` as an object) has no Cc field. That is why the JSON send API builds the MIME message itself and always sends it raw.
- KumoMTA's docs don't say how a raw message's own To and Cc headers are handled for each recipient. Send one test message through your KumoMTA version before relying on it.

`OUTBOUND_RELAY_TLS` sets how the relay connection uses TLS:
- `verify` (default): requires TLS with a valid certificate.
- `insecure`: encrypts but accepts self-signed certificates.
- `none`: plain connection, for a trusted private network only.

### Go MTA

A small delivery service using only the Go standard library. Node posts each message to it and it reports a result per recipient.

```bash
cd server/go-mta
go build -o go-mta .
GO_MTA_LISTEN=127.0.0.1:2580 GO_MTA_TOKEN=change-me GO_MTA_EHLO=smtp.yourdomain.com ./go-mta
```

- `POST /v1/deliver` takes `{ "from", "to": [], "raw": "<base64>" }` and returns `{ "results": [{ recipient, success, temporary, status, response, remoteMta }] }`
- `GET /healthz`
- Optional: `GO_MTA_ROUTES=example.org=10.0.0.5:25` sends a domain to a fixed host instead of its MX
- A `Dockerfile` is included

### Bounce server

When `BOUNCE_DOMAIN` is set (for example `bounces.yourdomain.com`, with its MX pointing at this server), outgoing mail uses `bounce+<queueId>@BOUNCE_DOMAIN` as the envelope sender. Bounces then come back to this server instead of the user's mailbox.

Bounces are accepted in four places:
- Port 25, for any recipient at `BOUNCE_DOMAIN`
- Port 25, for a bounce report (`multipart/report`) sent to a normal mailbox. It is still delivered to the mailbox, and the DSN processor also records it.
- The bounce SMTP server on `BOUNCE_SMTP_PORT` (default `2525`, turned off by `0` or `bounces.smtpServer.enabled=false`)
- `POST /kumo/events` on `BOUNCE_HTTP_PORT` (default `8025`) for KumoMTA log events: `Bounce`, `TransientFailure`, `Expiration`, `Feedback`. Needs `BOUNCE_WEBHOOK_TOKEN` as a Bearer token or `?token=`.

The bounce SMTP server follows the same layout as the incoming and outgoing servers: `BounceServerConfig` in `server/src/server/BounceServer.ts` and `NewBounceMailHandler` in `server/src/services/BounceMailHandler.ts`. The HTTP side is `BounceWebhookServerConfig` with `NewBounceWebhookHandler`.

The DSN processor (`services/bounce/DsnProcessor.ts`) reads each report's per-recipient status and matches it to the message we sent, using the VERP address or the `X-AE-Queue-Id` in the returned headers.

For every bounce:
- The original sender gets a standard bounce report (unless `bounces.notifySender` is `false`). The same happens when the queue gives up on a recipient.
- Addresses that hard-bounce (`5.1.x`) or send a spam complaint go on a suppression list for `bounces.suppression.days`. Later mail to them fails straight away instead of being sent.
- Only a bounce sent to the VERP address of a message we really sent, naming one of that message's recipients, can suppress an address, so a forged bounce can't block anyone. Reports that reach a normal mailbox are recorded but never suppress.
- Each event is posted to `BOUNCE_EVENTS_WEBHOOK_URL` if set.

Manage the suppression list with `GET` or `DELETE /suppressions/<email>` (same token).

### Background workers

DKIM checks on incoming mail, DKIM signing, PGP encryption, bounce parsing and building MIME messages for the JSON API run in worker threads, so a large message doesn't block other SMTP sessions.
Set `MAIL_WORKERS` for the number of threads (default: CPU cores minus 1, at most 4; `0` runs on the main thread).
When the work queue is full, clients get `451 4.3.2 Server is busy` and try again later.

### Configuration files

Settings are split three ways:

| Where | What |
|-------|------|
| `server/.env`, read only through `server/src/config/env.ts` | Hosts, ports, keys, passwords, driver choice |
| `server/config/mail.config.json` | What is turned on or off, policy actions, limits, queue and bounce behaviour |
| `server/config/smtp-messages.json` | Code, enhanced status and text of every SMTP reply the server sends |

Fixed values (driver names, DSN statuses, default settings, built-in reply catalog) are in `server/src/config/constants.ts`.

Both JSON files reload when you save them. If a file has a mistake, the server logs each problem and keeps the previous settings.
Listener settings (bounce servers on or off, the size advertised in EHLO) apply on restart. Everything else applies straight away.

**Policy actions.** Each check in `incoming.checks` takes one of:

| Action | Result |
|--------|--------|
| `accept` | Ignore the result |
| `tag` | Accept, and add `X-AE-Spam-Flag: YES` and `X-AE-Policy-Flags` to the message |
| `tempfail` | Reply `4xx` so the sender retries later |
| `reject` | Reply `5xx` |

| Check | Setting | Default | Reject reply |
|-------|---------|---------|--------------|
| Reverse DNS (with forward confirmation) | `reverseDns.enabled`, `onFail` | off, `tag` | `550 5.7.25` |
| Sender domain has no MX, A or AAAA | `senderDomain.onUnroutable` | `reject` | `550 5.1.8` |
| SPF `fail` / `softfail` / `none` / `temperror` | `spf.onFail`, `onSoftFail`, `onNone`, `onTempError` | `tag`, `accept`, `accept`, `accept` | `550 5.7.23` |
| DKIM fails / no signature | `dkim.onFail`, `onNone` | `tag`, `accept` | `550 5.7.20` |
| DMARC fails with `p=reject` / `p=quarantine` | `dmarc.onReject`, `onQuarantine` | `reject`, `tag` | `550 5.7.26` |

A DNS error never causes a hard reject: `reject` becomes `tempfail` for that message.
`incoming.trustedNetworks` (default: loopback) skips the checks and the rate limit, for example for an internal relay.

Other switches in `mail.config.json`:
- `incoming.maxMessageSizeBytes`, `maxRecipients`, `rateLimit`, `recipients.acceptedDomains` (empty accepts any), `recipients.knownRecipients` (empty accepts any user), `arcSeal`, `pgpEncryption`, `customHeaders`
- `outgoing.maxMessageSizeBytes`, `maxRecipients`, `rateLimit` (`maxConnectionsPerMinute: null` uses `MAX_EMAILS_PER_MINUTE`), `dkimSign`
- `queue.maxConcurrent`, `maxAgeHours`, `retryDelaysMinutes`
- `outgoing.bounceHeader`, `outgoing.customHeaders` (see [Outgoing headers](#outgoing-headers))
- `bounces.notifySender`, `suppression.enabled`, `suppression.days`, `trackingDays`, `smtpServer.enabled`, `httpServer.enabled`
- `api.enabled` for the JSON send API

**SMTP replies.** `smtp-messages.json` lists every reply the server sends, by key, for example:

```json
"MAILBOX_FULL": { "code": 552, "status": "5.2.2", "message": "Mailbox {recipient} is full" }
```

Change the text or code and save. `{placeholders}` are filled in at send time. The status must match the class of the code (`5xx` with `5.x.x`).
Replies that smtp-server sends itself, such as command syntax errors or `530 Authentication required`, are not in this file.

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

# Files (behaviour lives in config/mail.config.json, reply texts in config/smtp-messages.json)
MAIL_SPOOL_DIR=./spool
MAIL_CONFIG_PATH=./config/mail.config.json
SMTP_MESSAGES_PATH=./config/smtp-messages.json

# Outbound driver: direct | go | relay | kumo-http
OUTBOUND_DRIVER=direct

# relay driver (SMTP submission, e.g. KumoMTA on the private network)
OUTBOUND_RELAY_HOST=
OUTBOUND_RELAY_PORT=587
OUTBOUND_RELAY_USER=
OUTBOUND_RELAY_PASS=
OUTBOUND_RELAY_CA_PATH=
OUTBOUND_RELAY_TLS=verify

# kumo-http driver
KUMO_HTTP_URL=http://kumomta:8000
KUMO_HTTP_USER=
KUMO_HTTP_PASS=
KUMO_HTTP_STATIC_CONTENT=true

# go driver
GO_MTA_URL=http://go-mta:2580
GO_MTA_TOKEN=

# Bounces
BOUNCE_DOMAIN=
BOUNCE_SMTP_PORT=2525
BOUNCE_HTTP_PORT=8025
BOUNCE_WEBHOOK_TOKEN=
BOUNCE_EVENTS_WEBHOOK_URL=
BOUNCE_EVENTS_WEBHOOK_TOKEN=

# JSON send API (off until a token is set)
MAIL_API_HOST=0.0.0.0
MAIL_API_PORT=8080
MAIL_API_TOKEN=

# Worker threads (0 = main thread)
MAIL_WORKERS=

# Optional: ARC sealing of incoming mail
ARC_PRIVATE_KEY_PATH=
ARC_SIGNING_DOMAIN=
ARC_SELECTOR=default
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

1.  Install Dependencies First (Recommended) `cd server && bun install`

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
- ```bash chmod +x scripts/run.sh```
- ```bash ./scripts/run.sh```
2 .
- Go to server/src -> start.ts

- Open and replace `your_domain` with your domain name

```ts
const records = new DNSRecordGenerator("cirrusmail.cloud").generateAllRecords();
```

and Run this File, Records will create in `records.json` File in `server/` directory.

### Essential DNS Records

![DNS Record Setup](assets/images/image-1.png)

1. A Record

- Create mail.yourdomain.com pointing to your server IP
- Ensure the hostname matches SSL certificate

2 .PTR Record

- Contact your hosting provider to set up reverse DNS
- Should match your mail server's hostname

Share your Mailserver hostname, who ever wants to use your server and tell them to create MX Record pointing your server.

- Point to your mail server hostname
- Set priority (e.g., 10 mail.yourdomain.com)
  ![MX Record Setup](assets/images/image.png)

# Anti-Spam DNS Records

![Anti-Spam DNS Records Setup](assets/images/image-2.png)

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
![See image](assets/images/image-3.png)

 
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
server/src/
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
│   │   ├── MailComposer.ts          # RFC5322 header/MIME composition
│   │   ├── MailAuth.ts              # DKIM/SPF/DMARC/ARC auth
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
  temporary: boolean;         // true for 4xx / network errors that should be retried
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

