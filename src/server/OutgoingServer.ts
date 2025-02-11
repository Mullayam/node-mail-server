import { SMTPServer, SMTPServerOptions } from "smtp-server";
import { NewOutgoingMailHandler } from "../services/OutgoingMailHandler";

import { Logging } from "../lib/logs";
import { white } from "colorette";
import { readFileSync } from "fs";

// Make Sure to use TLS
// const options = {
//     key: readFileSync(process.env.TLS_PRIVATE_KEY_PATH as string,"utf8"),
//     cert: readFileSync(process.env.TLS_CERTFICATE_PATH as string,"utf8")
// }

export class OutgoingServerConfig {
    private readonly MAX_EMAILS_PER_MINUTE = Number(process.env.MAX_EMAILS_PER_MINUTE) || 5;
    protected greylist: Map<string, number>;
    protected rateLimitMap: Map<string, number>;
    private spamHistory: Map<string, number>;
    constructor(private host: string) {
        this.greylist = new Map();
        this.rateLimitMap = new Map();
        this.spamHistory = new Map();
    }
    private OUTGOING_SERVER_PORT = 587;
    private getOptions(handlers: SMTPServerOptions): SMTPServerOptions {
        return {
            allowInsecureAuth: false,
            logger: false,
            secure: false,
            name: this.host,
            //Enable TLS
            // key: options.key,
            // cert:options.cert,
            banner: `220 ${this.host} ESMTP NodeSMTP Server is Ready`,
            disabledCommands: [""],
            authMethods: ["PLAIN", "LOGIN", "CRAM-MD5"],
            size: 10 * 1024 * 1024,
            disableReverseLookup: true,
            useXClient: false,
            hidePIPELINING: true,
            needsUpgrade: false,
            authOptional: true,
            useProxy: false,
            handshakeTimeout: 60000,
            socketTimeout: 60000,  // Increase socket timeout to 60 seconds
            closeTimeout: 60000,  // Increase connection timeout to 60 seconds
            maxClients: 1000,
            enableTrace: true,
            ...handlers

        }
    }
    private eventListener(server: SMTPServer) {
        server.on("error", (err) => Logging.dev("incoming Mail Server has error " + err, "error"));
        server.on("close", () => Logging.dev("incoming Mail Server closed"));
    }
    private outgoingHandlers(): SMTPServerOptions {
        const self = this;
        return {
            async onConnect(session, callback) {
                const clientIP = session.remoteAddress || "";
                if (!self.greylist.has(clientIP)) {
                    self.rateLimitMap.set(clientIP, 0);
                    return callback(new Error("Try Again Once More, Please! to make your IP whitelist"));
                }

                return callback()
            },
            onClose(session, callback) { },
            onMailFrom(address, session, callback) {
                return NewOutgoingMailHandler.HandleMailFrom(address, session, callback);
            },
            onRcptTo(address, session, callback) {
                return NewOutgoingMailHandler.HandleRcptTo(address, session, callback);
            },
            onAuth(auth, session, callback) {
                return NewOutgoingMailHandler.HandleAuthenticate(auth, session, callback);
            },
            onData(stream, session, callback) {
                const senderIP = session.remoteAddress || "";
                const count = self.rateLimitMap.get(senderIP) || 0;
                if (count > self.MAX_EMAILS_PER_MINUTE) {
                    return callback(new Error("452 Too many emails sent. Slow down!"));
                }
                self.rateLimitMap.set(senderIP, count + 1);

                return NewOutgoingMailHandler.HandleNewMail(stream, session, callback);
            }
        }
    }
    public start() {
        const options = this.getOptions(this.outgoingHandlers());
        const server = new SMTPServer(options);
        this.eventListener(server);
        server.listen(this.OUTGOING_SERVER_PORT);
        Logging.dev(white("Outgoing Mail Server started on port " + this.OUTGOING_SERVER_PORT));
        return server
    }
}