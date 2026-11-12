import type { SMTPServer } from "smtp-server";
import { MAIL_LIMITS } from "../config/constants";
import { env } from "../config/env";
import { mailConfig } from "../config/mailConfig";
import { smtpMessages } from "../config/smtpMessages";
import { Logging } from "../lib/logs";
import { closeMailWorkers } from "../lib/workers";
import { BounceServer } from "./BounceServer";
import { IncomingServerConfig } from "./IncomingServer";
import { closeMailRuntime, getMailRuntime } from "./mta/runtime";
import { OutgoingServerConfig } from "./OutgoingServer";

/** More Resources for Further Research
 * https:*github.com/devmehq/email-validator-js
 * https:*github.com/forwardemail/free-email-forwarding/tree/master
 * https:*iredmail.org/
 * https:*github.com/zone-eu/zone-mta
 * https:*devsrealm.com/posts/b52728be7a1dbe83/send-only-mail-server-with-haraka
 * https:*iaziz786.com/blog/self-hosted-smtp-haraka/
 * https:*www.jetmore.org/john/code/swaks/installation.html
 * https:*github.com/guileen/node-sendmail/blob/master/examples/meetingRequest.js
 * https:*datatracker.ietf.org/doc/html/rfc8461
 */

export class SMTP_SERVICE {
	private static _instance: Promise<SMTP_SERVICE> | null = null;
	private readonly servers: SMTPServer[] = [];
	private readonly bounceServer: BounceServer;
	private shuttingDown?: Promise<void>;

	private constructor() {
		const runtime = getMailRuntime();
		const incomingServer = new IncomingServerConfig(env.server.incomingHost);
		const outgoingServer = new OutgoingServerConfig(env.server.outgoingHost);

		this.servers.push(incomingServer.start(), outgoingServer.start());
		this.bounceServer = new BounceServer(runtime.bounces);
		this.bounceServer.start();
		this.registerProcessHandlers();
	}

	static Initialize(): Promise<SMTP_SERVICE> {
		SMTP_SERVICE._instance ??= (async () => {
			await Promise.all([mailConfig.load(), smtpMessages.load()]);
			mailConfig.watch();
			smtpMessages.watch();
			return new SMTP_SERVICE();
		})();
		return SMTP_SERVICE._instance;
	}

	shutdown(): Promise<void> {
		this.shuttingDown ??= Promise.race([
			(async () => {
				await Promise.allSettled([
					...this.servers.map(
						(server) =>
							new Promise<void>((resolve) => server.close(() => resolve())),
					),
					this.bounceServer.close(),
				]);
				await closeMailRuntime();
				await closeMailWorkers();
				mailConfig.close();
				smtpMessages.close();
			})(),
			new Promise<void>((resolve) =>
				setTimeout(resolve, MAIL_LIMITS.SHUTDOWN_TIMEOUT_MS).unref(),
			),
		]);
		return this.shuttingDown;
	}

	private registerProcessHandlers(): void {
		const stop = (signal: string, exitCode: number) => {
			Logging.dev(`${signal} received, shutting down`, "notice");
			void this.shutdown().finally(() => process.exit(exitCode));
		};
		process.once("SIGINT", () => stop("SIGINT", 0));
		process.once("SIGTERM", () => stop("SIGTERM", 0));
		process.on("unhandledRejection", (reason) => {
			Logging.dev(
				`Unhandled promise rejection: ${reason instanceof Error ? reason.stack : String(reason)}`,
				"error",
			);
		});
		process.on("uncaughtException", (error) => {
			Logging.dev(
				`Uncaught exception: ${error.stack || error.message}`,
				"error",
			);
			stop("uncaughtException", 1);
		});
	}
}
