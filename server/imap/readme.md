- **Recommended:** ProtonMail [Gluon](gluon.md)
- Not used / not recommended: [Dovecot](dovecot.md) (kept for reference only)

## Prototype

Gluon server with pluggable users, storage and quota. Logins, TLS, storing mail in Pebble, quotas, delivery from port 25, a Junk folder for spam and reload work.

- Config: `conf/imap.example.xml` and `conf/users.example.xml` (copy to `imap.xml` and `users.xml`).
- Only users with IMAP enabled are loaded into Gluon, so only they can log in and receive mail.
- Delivery: the Node server hands mail it accepts on port 25 to the LMTP listener (port 24, Docker network only). Set `IMAP_LMTP_HOST=imap` in `server/.env`. New mail reaches open mail clients at once through Gluon's update stream.
- Spam: mail marked `X-AE-Spam-Flag: YES` (or `X-Spam-Flag: YES`) goes to `Junk`. See `<delivery>` in `imap.xml`.
- Users: `imapctl user add/update/delete` saves `users.xml` (the config folder is mounted read-write).
- TLS: put `fullchain.pem` and `privkey.pem` in `tls/` and enable `<tls>` in `imap.xml`. The server then listens on 993 and offers STARTTLS on 143.
- Apply config changes or a renewed certificate without a restart: `docker compose -f deploy/docker-compose.yml exec imap imapctl reload`
- Admin commands: `imapctl routes`
- Layout: `core/` (Gluon factory, connector, delivery), `internal/conf`, `internal/directorykind` (users), `internal/quota`, `internal/storage` (`pebble` engine, `dir` and `postgres` placeholders), `internal/storage/kv` (reusable Get/Set/Delete/Scan/Batch), `internal/lmtp`, `internal/filing` (INBOX or Junk), `internal/tlscert`, `internal/router`, `internal/control`, `cmd/imapctl`.

Full guide: `docs/content/docs/imap/overview.mdx`.
