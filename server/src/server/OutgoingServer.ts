import { SMTPServer, SMTPServerOptions } from "smtp-server";
import { NewOutgoingMailHandler } from "../services/OutgoingMailHandler";

import { Logging } from "../lib/logs";
import { white } from "colorette";
import { readFileSync } from "fs";
import { SpamFilteration } from "./config/SpamFilteration";

// Make Sure to use TLS
// const options = {
//     key: readFileSync(process.env.TLS_PRIVATE_KEY_PATH as string,"utf8"),
//     cert: readFileSync(process.env.TLS_CERTFICATE_PATH as string,"utf8")
// }

export class OutgoingServerConfig {
	private readonly MAX_EMAILS_PER_MINUTE =
		Number(process.env.MAX_EMAILS_PER_MINUTE) || 5;

	constructor(private host: string) {}
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
			socketTimeout: 60000, // Increase socket timeout to 60 seconds
			closeTimeout: 60000, // Increase connection timeout to 60 seconds
			maxClients: 1000,
			enableTrace: true,
			...handlers,
		};
	}
	private eventListener(server: SMTPServer) {
		server.on("error", (err) =>
			Logging.dev("incoming Mail Server has error " + err, "error"),
		);
		server.on("close", () => Logging.dev("incoming Mail Server closed"));
	}
	private outgoingHandlers(): SMTPServerOptions {
		const self = this;
		return {
			async onConnect(session, callback) {
				try {
					await SpamFilteration.checkBlackListIp(
						session.remoteAddress,
						self.MAX_EMAILS_PER_MINUTE,
					);
					return callback(null);
				} catch (error: any) {
					return callback(error.message);
				}
			},
			onClose(session, callback) {},
			onMailFrom(address, session, callback) {
				return NewOutgoingMailHandler.HandleMailFrom(
					address,
					session,
					callback,
				);
			},
			onRcptTo(address, session, callback) {
				return NewOutgoingMailHandler.HandleRcptTo(address, session, callback);
			},
			onAuth(auth, session, callback) {
				return NewOutgoingMailHandler.HandleAuthenticate(
					auth,
					session,
					callback,
				);
			},
			onData(stream, session, callback) {
				return NewOutgoingMailHandler.HandleNewMail(stream, session, callback);
			},
		};
	}
	public start() {
		const options = this.getOptions(this.outgoingHandlers());
		const server = new SMTPServer(options);
		this.eventListener(server);
		server.listen(this.OUTGOING_SERVER_PORT);
		Logging.dev(
			white(				 
				`Outgoing Mail Server started Host: ${this.host} Port: ` + this.OUTGOING_SERVER_PORT,
			),
		);
		return server;
	}
}
