- **Recommended:** ProtonMail [Gluon](gluon.md)
- Not used / not recommended: [Dovecot](dovecot.md) (kept for reference only)

## Prototype

Gluon server with pluggable users, storage and quota. Logins, TLS, storing mail in Pebble, quotas and reload work. Mail received on port 25 is not written into IMAP storage yet.

- Config: `conf/imap.example.xml` and `conf/users.example.xml` (copy to `imap.xml` and `users.xml`).
- Only users with IMAP enabled are loaded into Gluon, so only they can log in.
- TLS: put `fullchain.pem` and `privkey.pem` in `tls/` and enable `<tls>` in `imap.xml`. The server then listens on 993 and offers STARTTLS on 143.
- Apply config changes or a renewed certificate without a restart: `docker compose -f deploy/docker-compose.yml exec imap imapctl reload`
- Admin commands: `imapctl routes`
- Layout: `core/` (Gluon factory and connector), `internal/conf`, `internal/directorykind` (users), `internal/quota`, `internal/storage` (`pebble` engine, `dir` and `postgres` placeholders), `internal/storage/kv` (reusable Get/Set/Delete/Scan/Batch), `internal/tlscert`, `internal/router`, `internal/control`, `cmd/imapctl`.

Full guide: `docs/content/docs/imap/overview.mdx`.
