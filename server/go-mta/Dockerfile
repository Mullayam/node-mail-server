FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /go-mta .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -H mta
USER mta
COPY --from=build /go-mta /usr/local/bin/go-mta
ENV GO_MTA_LISTEN=0.0.0.0:2580
EXPOSE 2580
ENTRYPOINT ["/usr/local/bin/go-mta"]
