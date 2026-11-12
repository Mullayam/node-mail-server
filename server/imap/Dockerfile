# IMAP server (Gluon) and its admin CLI, imapctl.
# Gluon keeps its cache in SQLite, so the build needs cgo.
FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 go build -trimpath -o /out/imap . \
 && CGO_ENABLED=0 go build -trimpath -o /out/imapctl ./cmd/imapctl

FROM debian:bookworm-slim
RUN useradd --system --uid 1000 --home-dir /data --shell /usr/sbin/nologin imap \
 && install -d -o imap -g imap -m 0700 /data /run/imap \
 && install -d -o imap -g imap /etc/imap
COPY --from=build /out/imap /out/imapctl /usr/local/bin/
USER imap
ENV IMAP_CONFIG=/etc/imap/imap.xml \
    IMAP_CONTROL_SOCKET=/run/imap/control.sock
EXPOSE 143
HEALTHCHECK --interval=30s --timeout=5s CMD ["imapctl", "status"]
ENTRYPOINT ["imap"]
