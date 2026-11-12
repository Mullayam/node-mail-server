import { createHash, timingSafeEqual } from "crypto";
import express, {
	type NextFunction,
	type Request,
	type Response,
} from "express";
import type { Server } from "http";
import { SMTPServer } from "smtp-server";
import { HTTP_ERROR } from "../config/constants";
import { env } from "../config/env";
import { mailConfig } from "../config/mailConfig";
import { smtpReply } from "../config/smtpMessages";
import { collectMessage } from "../lib/helpers/RawMessage";
import { toSmtpError } from "../lib/helpers/smtpErrors";
import { Logging } from "../lib/logs";
import type {
	BounceProcessor,
	KumoLogRecord,
} from "../services/bounce/BounceProcessor";

const digest = (value: string) => createHash("sha256").update(value).digest();

export class BounceServer {
	private smtp?: SMTPServer;
	private http?: Server;

	constructor(private readonly processor: BounceProcessor) {}

	start(): void {
		this.startSmtp();
		this.startHttp();
	}

	async close(): Promise<void> {
		await Promise.all([
			this.smtp
				? new Promise<void>((resolve) => this.smtp?.close(() => resolve()))
				: undefined,
			this.http
				? new Promise<void>((resolve) => this.http?.close(() => resolve()))
				: undefined,
		]);
	}

	private startSmtp(): void {
		const { smtpPort: port, smtpHost: host } = env.bounce;
		if (!port || !mailConfig.get().bounces.smtpServer.enabled) return;
		const processor = this.processor;
		const maxSize = () => mailConfig.get().incoming.maxMessageSizeBytes;

		this.smtp = new SMTPServer({
			name: env.server.outgoingHost,
			banner: smtpReply("BOUNCE_GREETING", { host: env.server.outgoingHost })
				.message,
			authOptional: true,
			disabledCommands: ["AUTH"],
			logger: false,
			size: maxSize(),
			maxClients: 200,
			socketTimeout: 60_000,
			onRcptTo(address, _session, callback) {
				if (
					processor.bounceDomain &&
					!processor.isBounceAddress(address.address)
				) {
					return callback(
						smtpReply("UNKNOWN_BOUNCE_ADDRESS", {
							recipient: address.address,
						}).toError(),
					);
				}
				return callback();
			},
			onData(stream, session, callback) {
				collectMessage(stream, maxSize())
					.then(async (raw) => {
						if (!raw) {
							return callback(
								smtpReply("MESSAGE_TOO_LARGE", {
									maxSize: maxSize(),
								}).toError(),
							);
						}
						await processor.handleIncomingBounce(
							raw,
							session.envelope.rcptTo.map((r) => r.address),
						);
						return callback(null, smtpReply("BOUNCE_ACCEPTED").text);
					})
					.catch((error) =>
						callback(toSmtpError(error, "Bounce processing failed")),
					);
			},
		});
		this.smtp.on("error", (error) =>
			Logging.dev(`Bounce SMTP server error: ${error}`, "error"),
		);
		this.smtp.listen(port, host);
		Logging.dev(`Bounce SMTP server listening on ${host}:${port}`);
	}

	private startHttp(): void {
		const { httpPort: port, httpHost: host, webhookToken: token } = env.bounce;
		if (!port || !mailConfig.get().bounces.httpServer.enabled) return;
		if (!token) {
			Logging.dev(
				"BOUNCE_WEBHOOK_TOKEN is not set, bounce HTTP endpoints are disabled",
				"notice",
			);
			return;
		}
		const expected = digest(token);
		const processor = this.processor;

		const app = express();
		app.disable("x-powered-by");
		app.get("/healthz", (_req, res) => {
			res.json({ ok: true });
		});
		app.use((req: Request, res: Response, next: NextFunction) => {
			const header = req.get("authorization");
			const provided = header?.startsWith("Bearer ")
				? header.slice(7)
				: String(req.query.token ?? "");
			if (!provided || !timingSafeEqual(digest(provided), expected)) {
				res.status(401).json({ error: HTTP_ERROR.UNAUTHORIZED });
				return;
			}
			next();
		});
		app.use(express.json({ limit: "1mb" }));

		app.post("/kumo/events", async (req: Request, res: Response) => {
			const body = req.body as KumoLogRecord | KumoLogRecord[] | undefined;
			if (!body || typeof body !== "object") {
				res.status(400).json({ error: HTTP_ERROR.INVALID_BODY });
				return;
			}
			try {
				for (const record of Array.isArray(body) ? body : [body])
					await processor.handleKumoEvent(record);
				res.json({ ok: true });
			} catch (error) {
				Logging.dev(`KumoMTA event processing failed: ${error}`, "error");
				res.status(500).json({ error: HTTP_ERROR.PROCESSING_FAILED });
			}
		});

		app.get("/suppressions/:email", (req: Request, res: Response) => {
			const entry = processor.suppression?.check(String(req.params.email));
			if (!entry) {
				res.status(404).json({ error: HTTP_ERROR.NOT_FOUND });
				return;
			}
			res.json({ email: req.params.email, ...entry });
		});

		app.delete("/suppressions/:email", (req: Request, res: Response) => {
			const removed =
				processor.suppression?.remove(String(req.params.email)) ?? false;
			res.status(removed ? 204 : 404).end();
		});

		app.use(
			(
				error: Error & { type?: string },
				_req: Request,
				res: Response,
				_next: NextFunction,
			) => {
				res
					.status(error.type === "entity.parse.failed" ? 400 : 500)
					.json({ error: HTTP_ERROR.INVALID_BODY });
			},
		);

		this.http = app.listen(port, host, () =>
			Logging.dev(`Bounce HTTP server listening on ${host}:${port}`),
		);
	}
}
