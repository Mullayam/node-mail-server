# relay — public SMTP relay (KumoMTA)

Apps and servers send mail through this relay with a username and password. Each
account may only send for its own domains. Every event for that account's mail
(received, delivered, deferred, bounced, rejected) is POSTed to that account's
webhook, and only that account's. Built on [KumoMTA](https://docs.kumomta.com/),
like [`outbound/`](../outbound/README.md).

```
app ──2587 STARTTLS + AUTH──▶ KumoMTA ──DKIM──▶ queue ──▶ recipient MX (or smarthost)
                                 │
                                 └──▶ account's webhook (signed JSON, one POST per event)
```

## Layout

| Path | What it does |
|------|--------------|
| `policy/` | Mounted read-only at `/opt/kumomta/etc/policy`. |
| `policy/init.lua` | Entry point: 2587 listener, AUTH, sender and From checks, spool and logs. |
| `policy/accounts.lua` | Loads `users.lua` and checks passwords and domains. |
| `policy/webhook.lua` | Sends each event to the webhook of the account that sent the mail. |
| `policy/trace.lua` | Reads `X-Trace-Id` / `X-Campaign`, removes them, and picks the logged fields. |
| `policy/dkim.lua` | DKIM signing. Keys come from a file, HTTP or Redis (`DKIM_BACKEND`). |
| `policy/egress.lua` | Source IPs, per-provider shaping, smarthost connection settings. |
| `policy/queue.lua` | Retry schedule and smarthost routing. |
| `policy/users.lua` | Accounts. Gitignored; copy from `users.example.lua`. |
| `.env` | Runtime settings. Gitignored; copy from `.env.example`. |

## Accounts

```lua
return {
  ["app1"] = {
    password = "change-me",
    domains = { "example.com" },
    webhook = {
      url = "https://app1.example.com/webhooks/mail",
      secret = "change-me",
      events = { "Reception", "Delivery", "TransientFailure", "Bounce", "Expiration" },
    },
  },
}
```

- `domains`: the envelope sender (`MAIL FROM`) and the `From` header must both be in
  one of these domains or a subdomain (`example.com` also allows `news.example.com`).
  Mail is DKIM-signed for the `From` domain.
- `webhook` is optional. If it is present, `url` and `secret` are both required.
  Otherwise the account is disabled and its logins fail; the reason is in the relay log.
- `events` is optional. Leave it out to receive every type.
- Edits to `users.lua` apply within a minute, without a restart.

## Run

```bash
cp relay/.env.example relay/.env
cp relay/policy/users.example.lua relay/policy/users.lua
# edit both, then:
docker compose -f deploy/docker-compose.yml up -d relay
docker compose -f deploy/docker-compose.yml logs -f relay
```

Queued mail and pending webhook events live in the `relay-spool` volume and survive
a rebuild. For a public relay, set `RELAY_TLS_CERT` and `RELAY_TLS_KEY` and mount
the certificate. Without them KumoMTA uses a self-signed certificate, and clients
must turn off certificate checks.

## Sending

| Setting | Value |
|---------|-------|
| Host / port | relay host, `2587` |
| Security | STARTTLS (required: AUTH is only offered after it) |
| Auth | account name and password from `users.lua` |

Optional headers, removed before the mail is delivered:

| Header | Becomes | Default |
|--------|---------|---------|
| `X-Trace-Id` | `meta.x_trace_id` | the relay's message id |
| `X-Campaign` | `meta.campaign` and the queue name | none |

```js
const transport = nodemailer.createTransport({
  host: "relay.example.com",
  port: 2587,
  requireTLS: true,
  auth: { user: "app1", pass: "change-me" },
});
await transport.sendMail({
  from: "hello@example.com",
  to: "someone@gmail.com",
  subject: "Hi",
  text: "Hello",
  headers: { "X-Trace-Id": "order-1234" },
});
```

The `250` reply holds the relay's message id per recipient (`OK ids=<id> ...`),
the same value as `id` in webhook events.

| Reply | Meaning |
|-------|---------|
| `530 5.7.0` | Not logged in |
| `535 5.7.8` | Wrong name or password, or account disabled |
| `550 5.7.1 Sender domain ...` | `MAIL FROM` domain not in the account's `domains` |
| `550 5.7.1 From must be ...` | `From` header isn't one address in the account's `domains` |

## Webhook

One `POST` per event. The body is a KumoMTA
[log record](https://docs.kumomta.com/reference/log_record/):

```json
{
  "type": "Bounce",
  "id": "65f291aedeea11f194609a64d9b217fd",
  "sender": "hello@example.com",
  "recipient": "someone@example.net",
  "queue": "welcome:app1@example.net",
  "response": { "code": 556, "content": "...", "enhanced_code": { "class": 5, "subject": 1, "detail": 10 } },
  "timestamp": 1794523393,
  "num_attempts": 1,
  "meta": { "authn_id": "app1", "x_trace_id": "order-1234", "campaign": "welcome", "received_from": "198.51.100.7:49652" },
  "headers": { "Message-ID": "<...>", "Subject": "Hi", "From": "hello@example.com", "To": "someone@example.net" }
}
```

Match events to your records with `meta.x_trace_id` (yours) or `id` (the relay's).
`type` is one of `Reception`, `Delivery`, `TransientFailure`, `Bounce`,
`Expiration`, `Rejection`, `AdminBounce`, `Delayed`, plus the rarer types in
the log record docs.

| Header | Value |
|--------|-------|
| `X-Relay-Event-Id` | Unique per event, the same on every retry. Use it to drop duplicates. |
| `X-Relay-Timestamp` | Unix seconds when this attempt was signed. |
| `X-Relay-Signature` | `sha256=` + hex HMAC-SHA256 of `<timestamp>.<raw body>` with the account's `secret`. |

How the relay treats your response:

| Response | Result |
|----------|--------|
| `2xx`, `409` | Done |
| `400`, `410`, `413`, `415`, `422` | Dropped, not retried |
| anything else, timeout, connection error | Retried (30s, backing off to 10m) until `WEBHOOK_MAX_AGE` (default 3 days) |

Verify the signature against the raw body before parsing it:

```js
const crypto = require("crypto");

function verifyRelayWebhook(rawBody, headers, secret) {
  const timestamp = headers["x-relay-timestamp"];
  const expected = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const given = Buffer.from(headers["x-relay-signature"] || "");
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  return fresh && given.length === expected.length && crypto.timingSafeEqual(given, Buffer.from(expected));
}
```

## Smarthost

By default the relay delivers to each recipient's MX, with KumoMTA's bundled
per-provider shaping (add `policy/shaping.toml` to override it). To hand
everything to another server instead, set `RELAY_SMARTHOST`, plus
`RELAY_SMARTHOST_PORT`, `RELAY_SMARTHOST_USER` and `RELAY_SMARTHOST_PASS` if it
needs AUTH. To go through this stack's `outbound` service, use
`RELAY_SMARTHOST=outbound`, port `587`, an account from `outbound/policy/users.lua`,
and `RELAY_SMARTHOST_TLS=RequiredInsecure` (outbound's certificate is self-signed).
Set `DKIM_BACKEND=none` if the smarthost signs.

## Limits

- Passwords in `users.lua` are plain text.
- No per-account rate limits yet.
- Connections that fail before logging in can't be tied to an account, so they
  only show up in the relay's local logs (`relay-logs` volume).
- An account's pending events are dropped if the account or its webhook is
  removed from `users.lua`.
- Bounces that remote servers send back later (after accepting the mail) go to
  the envelope sender's domain, not to the relay.
