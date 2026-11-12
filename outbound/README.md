# outbound — sending MTA (KumoMTA)

Takes authenticated mail on port 587, DKIM-signs it, queues it, and delivers it
to each recipient's MX. Delivery events go to a webhook. Built on
[KumoMTA](https://docs.kumomta.com/); everything in `policy/` is KumoMTA Lua/TOML.

```
client ──587 AUTH──▶ KumoMTA ──DKIM sign──▶ queue (per domain) ──egress pool──▶ recipient MX
                                                     └──▶ WEBHOOK_URL (delivery / bounce events)
```

## Layout

| Path | What it does |
|------|--------------|
| `policy/` | Mounted read-only at `/opt/kumomta/etc/policy`. Only what KumoMTA reads lives here. |
| `policy/init.lua` | Entry point: 587 listener, spool and logs, AUTH, sender-domain and recipient checks. |
| `policy/dkim.lua` | DKIM signing. Keys come from a file, HTTP or Redis (`DKIM_BACKEND`). |
| `policy/egress.lua` | Builds `main-pool` from `KUMOMTA_SOURCE_IPS`. |
| `policy/queue.lua` | Per-domain message rate and retry schedule (`get_queue_config`). |
| `policy/webhook.lua` | JSON log webhook to `WEBHOOK_URL`. |
| `policy/shaping.toml` | Per-provider connection/rate rules. **Not loaded yet**, see Known issues. |
| `policy/listener_domains.toml` | Which domains may relay and log bounces/FBLs. |
| `policy/domains.lua` | Sender domains allowed when `USE_RELAY=true`. |
| `policy/users.lua` | SMTP AUTH accounts. Gitignored; copy from `users.example.lua`. |
| `.env` | Runtime settings. Gitignored; copy from `.env.example`. |

## Run

From the repo root:

```bash
cp outbound/.env.example outbound/.env
cp outbound/policy/users.example.lua outbound/policy/users.lua
# edit both, then:
docker compose -f deploy/docker-compose.yml up -d outbound
docker compose -f deploy/docker-compose.yml logs -f outbound
```

Spool and logs are kept in the `kumo-spool` and `kumo-logs` volumes, so queued
mail survives a container rebuild.

KumoMTA's HTTP API listens on `127.0.0.1:8000` inside the container only. Use
`kcli` from inside it:

```bash
docker compose -f deploy/docker-compose.yml exec outbound /opt/kumomta/sbin/kcli queue-summary
```

## Known issues

- With `USE_RELAY=false`, nothing is DKIM-signed and the sender-domain check
  is skipped, so mail leaves unsigned. (The calls to an undefined `dkim_signer`
  are gone: `init.lua` now calls `dkim.sign(msg)` once per handler.)
- `shaping.toml` isn't loaded: nothing registers `get_egress_path_config`.
  Wire it up with `policy-extras.shaping`. Its `automation` rules also need the
  KumoMTA TSA daemon running.
- `queue.lua` sets `conns` and `per_conn` for each domain but never uses them.
  Those limits belong in egress path config (that is, `shaping.toml`).
- `domains.lua` and `listener_domains.toml` both list the allowed domains. Keep one.
- `WEBHOOK_SECRET` is read but not sent with webhook requests.
