import { white } from "colorette";
import { SMTPServer, type SMTPServerOptions } from "smtp-server";
import { DEFAULTS } from "../config/constants";
import { mailConfig } from "../config/mailConfig";
import { smtpReply } from "../config/smtpMessages";
import { toSmtpError } from "../lib/helpers/smtpErrors";
import { Logging } from "../lib/logs";
import { NewMailHandler } from "../services/IncomingMailHandler";
import { IncomingPolicy } from "../services/IncomingPolicy";
import { SpamFilteration } from "./config/SpamFilteration";

export class IncomingServerConfig {
	constructor(private host: string) {}
	private INCOMING_SERVER_PORT = DEFAULTS.SMTP_PORT_INCOMING;
	private getOptions(handlers: SMTPServerOptions): SMTPServerOptions {
		return {
			allowInsecureAuth: false,
			logger: false,
			secure: false,
			name: this.host,
			banner: smtpReply("GREETING", { host: this.host }).message,
			disabledCommands: ["AUTH"],
			size: mailConfig.get().incoming.maxMessageSizeBytes,
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
				try {
					Logging.dev("Client Connected " + session.id);
					return callback(await IncomingPolicy.checkConnection(session));
				} catch (error) {
					return callback(
						toSmtpError(error, "Incoming connection check failed"),
					);
				}
			},
			onClose(session, callback) {},
			async onMailFrom(address, session, callback) {
				try {
					Logging.dev("Mail Recived From " + address.address);

					const { rateLimit } = mailConfig.get().incoming;
					if (rateLimit.enabled && !IncomingPolicy.isTrusted(session)) {
						await SpamFilteration.checkBlackListIp(
							session.remoteAddress,
							rateLimit.maxMessagesPerMinute,
						);
					}
					return NewMailHandler.HandleMailFrom(address, session, callback);
				} catch (error) {
					return callback(toSmtpError(error, "Incoming MAIL FROM failed"));
				}
			},
			onRcptTo(address, session, callback) {
				Logging.dev("Mail Recived To " + address.address);

				return NewMailHandler.HandleRcptTo(address, session, callback);
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
				`Incoming Mail Server started Host: ${this.host} Port: ` +
					this.INCOMING_SERVER_PORT,
			),
		);
		return server;
	}
}
