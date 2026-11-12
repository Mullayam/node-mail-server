import { white } from "colorette";
import { SMTPServer, type SMTPServerOptions } from "smtp-server";
import { env } from "../config/env";
import { mailConfig } from "../config/mailConfig";
import { smtpReply } from "../config/smtpMessages";
import { Logging } from "../lib/logs";
import { NewBounceMailHandler } from "../services/BounceMailHandler";

export class BounceServerConfig {
	constructor(private host: string) {}
	private BOUNCE_SERVER_PORT = env.bounce.smtpPort;
	private getOptions(handlers: SMTPServerOptions): SMTPServerOptions {
		return {
			allowInsecureAuth: false,
			logger: false,
			secure: false,
			name: this.host,
			banner: smtpReply("BOUNCE_GREETING").message,
			disabledCommands: ["AUTH"],
			size: mailConfig.get().incoming.maxMessageSizeBytes,
			disableReverseLookup: true,
			useXClient: false,
			hidePIPELINING: true,
			needsUpgrade: false,
			authOptional: true,
			useProxy: false,
			handshakeTimeout: 60000,
			socketTimeout: 60000,
			closeTimeout: 60000,
			maxClients: 200,
			...handlers,
		};
	}
	private eventListener(server: SMTPServer) {
		server.on("error", (err) =>
			Logging.dev("bounce Mail Server has error " + err, "error"),
		);
		server.on("close", () => Logging.dev("bounce Mail Server closed"));
	}
	private bounceHandlers(): SMTPServerOptions {
		return {
			onConnect(session, callback) {
				Logging.dev("Bounce Client Connected " + session.id);
				return callback(null);
			},
			onClose(session, callback) {},
			onRcptTo(address, session, callback) {
				return NewBounceMailHandler.HandleRcptTo(address, session, callback);
			},
			onData(stream, session, callback) {
				return NewBounceMailHandler.HandleNewMail(stream, session, callback);
			},
		};
	}
	public start(): SMTPServer | null {
		if (
			!this.BOUNCE_SERVER_PORT ||
			!mailConfig.get().bounces.smtpServer.enabled
		) {
			return null;
		}
		const options = this.getOptions(this.bounceHandlers());
		const server = new SMTPServer(options);
		this.eventListener(server);
		server.listen(this.BOUNCE_SERVER_PORT, env.bounce.smtpHost);
		Logging.dev(
			white(
				`Bounce Mail Server started Host: ${this.host} Port: ` +
					this.BOUNCE_SERVER_PORT,
			),
		);
		return server;
	}
}
