import { SMTPServer, SMTPServerOptions } from "smtp-server";
import { NewMailHandler } from "../services/IncomingMailHandler";
import { Logging } from "../lib/logs";
import { white } from "colorette";
import { SpamFilteration } from "./config/SpamFilteration";

export class IncomingServerConfig {
	constructor(private host: string) { }
	private INCOMING_SERVER_PORT = 25;
	private getOptions(handlers: SMTPServerOptions): SMTPServerOptions {
		return {
			allowInsecureAuth: false,
			logger: false,
			secure: false,
			name: this.host,
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
	private incomingHandlers(): SMTPServerOptions {
		return {
			async onConnect(session, callback) {
				return callback(null);
			},
			onClose(session, callback) { },
			async onMailFrom(address, session, callback) {
				try {
					await SpamFilteration.checkBlackListIp(session.remoteAddress, 3)
					return NewMailHandler.HandleMailFrom(address, session, callback);

				} catch (error) {

				}
			},
			onRcptTo(address, session, callback) {
				return NewMailHandler.HandleRcptTo(address, session, callback);
			},
			onAuth(auth, session, callback) {
				return callback(null);
			},
			onData(stream, session, callback) {
				return NewMailHandler.HandleNewMail(stream, session, callback);
			},
		};
	}
	public start() {
		const options = this.getOptions(this.incomingHandlers());
		const server = new SMTPServer(options);
		this.eventListener(server);
		server.listen(this.INCOMING_SERVER_PORT);
		Logging.dev(
			white(
				"Incoming Mail Server started on port " + this.INCOMING_SERVER_PORT,
			),
		);
		return server;
	}
}
