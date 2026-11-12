# IMAP server (Go + Gluon). WIP: go.mod has no requirements yet and the
# import paths don't match the folders, so this build fails until that's fixed.
FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN go build -o /out/imap .

FROM debian:bookworm-slim
COPY --from=build /out/imap /usr/local/bin/imap
EXPOSE 143
ENTRYPOINT ["imap"]
