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
				Logging.dev("Client Connected " + session.id);
				return callback(null);
			},
			onClose(session, callback) { },
			async onMailFrom(address, session, callback) {
				try {
					Logging.dev("Mail Recived From " + address.address);

					await SpamFilteration.checkBlackListIp(session.remoteAddress, 3);
					return NewMailHandler.HandleMailFrom(address, session, callback);
				} catch (error: any) {
					return callback(new Error(error.message));
				}
			},
			onRcptTo(address, session, callback) {
				Logging.dev("Mail Recived To " + address.address);

				return NewMailHandler.HandleRcptTo(address, session, callback);
			},
			async onAuth(auth, session, callback) {
				try {
					if (auth.method === "XOAUTH2" || auth.username || auth.accessToken || auth.password) {
						await SpamFilteration.checkBlackListIp(
							session.remoteAddress,
							10,
						);
						throw new Error("Authentication not supported");
					}

					return callback(null);
				} catch (error: any) {
					return callback(error.message);
				}

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
				`Incoming Mail Server started Host: ${this.host} Port: ` + this.INCOMING_SERVER_PORT,
			),
		);
		return server;
	}
}
