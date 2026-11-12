# IMAP with Gluon (Recommended)

[Gluon](https://github.com/ProtonMail/gluon) is Proton's IMAP server library, written in Go.
It is a **library, not a standalone daemon**: you embed it in a Go program and plug in a
**connector** that reads and writes mail from your own storage. Gluon handles the IMAP
protocol itself: sessions, mailboxes, UIDs, flags, IDLE and a local cache.

We use Gluon instead of Dovecot because:

- It ships as one Go binary. There are no system users, Maildir folders or file permissions to manage.
- Mail stays in our own database and pipeline (including the PGP-encrypted store).
- Users, auth and mailboxes are controlled from code, not from Dovecot config files.

## How it fits

```
Sender ──► SMTP :25 (Node, IncomingMailHandler) ──► Database / mail store
                                                          ▲
Mail client ◄──► IMAP :143 / :993 (Go, Gluon) ◄── connector (core/connector/db.go)
(Thunderbird, Outlook, mobile apps)
```

The SMTP server stores incoming mail. The Gluon connector reads that store and pushes new
messages to Gluon, so they show up in the user's mail client.

## Folder layout

| File | Purpose |
|------|---------|
| `main.go` | Starts the Gluon server, reads env vars, listens for IMAP connections |
| `core/factory.go` | Loads users and registers each one with Gluon (`AddUser` / `LoadUser`) |
| `core/connector/db.go` | `MyDBConnector`: the Gluon connector backed by our SQL database |
| `core/consts/init.go` | Default values |

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `GLUON_DIR` | none | Folder for Gluon's local data and database cache |
| `GLUON_HOST` | `localhost:143` | Address and port to listen on |
| `GLUON_LOG_LEVEL` | none | Log level (`trace`, `debug`, `info`, `warn`, `error`) |

Optional profiling flags: `-profile-cpu`, `-profile-mem`, `-profile-lock`, `-profile-path <dir>`.

## Run

Requires Go 1.22 or newer.

```bash
cd server/imap
go mod tidy
GLUON_DIR=./data GLUON_HOST=0.0.0.0:143 GLUON_LOG_LEVEL=debug go run .
```

## The connector

Gluon calls the connector for everything that touches storage. The main methods are:

| Method | What it should do |
|--------|-------------------|
| `Authorize` | Check the username and password against our users table |
| `GetUpdates` | Return a channel that pushes changes (new messages, flag changes) into Gluon. This is how mail received over SMTP appears in the client |
| `GetMessageLiteral` | Return the raw RFC 5322 message by ID |
| `CreateMailbox`, `UpdateMailboxName`, `DeleteMailbox` | Mailbox (folder) management |
| `CreateMessage`, `AddMessagesToMailbox`, `RemoveMessagesFromMailbox`, `MoveMessages` | Message management |
| `MarkMessagesSeen`, `MarkMessagesFlagged`, `MarkMessagesForwarded` | Flags |
| `Close` | Release resources |

For a working example, see the dummy connector in the Gluon repository (`connector/dummy.go`).

## Users

Gluon must know every user before that user can log in:

- **New user:** call `server.AddUser(ctx, connector, passphrase)`. It returns a Gluon user ID, which you save in the database.
- **Existing user:** call `server.LoadUser(ctx, connector, gluonUserID, passphrase)` on startup.

The `passphrase` encrypts that user's local Gluon cache. Use a separate secret for each
user, not one shared default value.

## TLS

`main.go` currently listens on plain TCP. Before going to production, enable TLS
(`gluon.WithTLS`) with the same Let's Encrypt certificate used for SMTP, and serve
port 993 (implicit TLS) or STARTTLS on 143.

## Testing

```bash
telnet localhost 143                      # plain
openssl s_client -connect localhost:993   # with TLS
```

```
a1 LOGIN user@example.com password
a2 LIST "" "*"
a3 SELECT INBOX
a4 FETCH 1 BODY[]
a5 LOGOUT
```

You can also connect with Thunderbird or any other IMAP client.

## Status / TODO

The IMAP module is a work in progress and does not build yet.

- [ ] Fix import paths in `main.go` and `core/factory.go` to match the `core/` folder
- [ ] Implement `Authorize` against the users table
- [ ] Implement the connector methods and the `GetUpdates` channel
- [ ] Use a per-user passphrase instead of `consts.DefaultImapPass`
- [ ] Enable TLS (993 / STARTTLS)
