import { white } from "colorette";
import { readFileSync } from "fs";
import { SMTPServer, type SMTPServerOptions } from "smtp-server";
import { DEFAULTS } from "../config/constants";
import { env } from "../config/env";
import { mailConfig } from "../config/mailConfig";
import { smtpReply } from "../config/smtpMessages";
import { toSmtpError } from "../lib/helpers/smtpErrors";
import { Logging } from "../lib/logs";
import { NewOutgoingMailHandler } from "../services/OutgoingMailHandler";
import { SpamFilteration } from "./config/SpamFilteration";

// Make Sure to use TLS
// const options = {
//     key: readFileSync(env.tls.privateKeyPath as string,"utf8"),
//     cert: readFileSync(env.tls.certificatePath as string,"utf8")
// }

export class OutgoingServerConfig {
	constructor(private host: string) {}
	private OUTGOING_SERVER_PORT = DEFAULTS.SMTP_PORT_OUTGOING;
	private getOptions(handlers: SMTPServerOptions): SMTPServerOptions {
		return {
			allowInsecureAuth: false,
			logger: false,
			secure: false,
			name: this.host,
			//Enable TLS
			// key: options.key,
			// cert:options.cert,
			banner: smtpReply("GREETING", { host: this.host }).message,
			disabledCommands: [""],
			authMethods: ["PLAIN", "LOGIN", "CRAM-MD5"],
			size: mailConfig.get().outgoing.maxMessageSizeBytes,
			disableReverseLookup: true,
			useXClient: false,
			needsUpgrade: false,
			authOptional: true, // use authOptional to allow unauthenticated for relay, but still support authentication if provided
			useProxy: false,
			handshakeTimeout: 60000,
			socketTimeout: 60000, // Increase socket timeout to 60 seconds
			closeTimeout: 60000, // Increase connection timeout to 60 seconds
			maxClients: 1000,
			enableTrace: true,
			hideDSN: true,
			hideREQUIRETLS: true,
			hideENHANCEDSTATUSCODES: true,
			hidePIPELINING: true,
			hideSTARTTLS: true,
			hideSize: true,
			hide8BITMIME: true,
			hideSMTPUTF8: true,
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
		return {
			async onConnect(session, callback) {
				try {
					const { rateLimit } = mailConfig.get().outgoing;
					if (rateLimit.enabled) {
						await SpamFilteration.checkBlackListIp(
							session.remoteAddress,
							rateLimit.maxConnectionsPerMinute ??
								env.server.maxEmailsPerMinute,
						);
					}
					return callback(null);
				} catch (error) {
					return callback(
						toSmtpError(error, "Outgoing connection check failed"),
					);
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
		const options = this.getOptions({
			authOptional: false,
			...this.outgoingHandlers(),
		});
		const server = new SMTPServer(options);
		this.eventListener(server);
		server.listen(this.OUTGOING_SERVER_PORT);
		Logging.dev(
			white(
				`Outgoing Mail Server started Host: ${this.host} Port: ` +
					this.OUTGOING_SERVER_PORT,
			),
		);
		return server;
	}
}
