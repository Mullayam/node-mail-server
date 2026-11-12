import { white } from "colorette";
import express, { type Express } from "express";
import type { Server } from "http";
import { HTTP_ERROR } from "../config/constants";
import { env } from "../config/env";
import { mailConfig } from "../config/mailConfig";
import { bearerAuth, jsonErrorHandler } from "../lib/helpers/httpAuth";
import { Logging } from "../lib/logs";
import { NewBounceWebhookHandler } from "../services/BounceWebhookHandler";

export class BounceWebhookServerConfig {
	private BOUNCE_HTTP_PORT = env.bounce.httpPort;
	private getApp(token: string): Express {
		const app = express();
		app.disable("x-powered-by");
		app.get("/healthz", (_req, res) => {
			res.json({ ok: true });
		});
		app.use(bearerAuth(token));
		app.use(express.json({ limit: "1mb" }));
		app.post("/kumo/events", (req, res) =>
			NewBounceWebhookHandler.HandleKumoEvents(req, res),
		);
		app.get("/suppressions/:email", (req, res) =>
			NewBounceWebhookHandler.HandleGetSuppression(req, res),
		);
		app.delete("/suppressions/:email", (req, res) =>
			NewBounceWebhookHandler.HandleDeleteSuppression(req, res),
		);
		app.use(jsonErrorHandler(HTTP_ERROR.INVALID_BODY));
		return app;
	}
	public start(): Server | null {
		if (
			!this.BOUNCE_HTTP_PORT ||
			!mailConfig.get().bounces.httpServer.enabled
		) {
			return null;
		}
		const token = env.bounce.webhookToken;
		if (!token) {
			Logging.dev(
				"BOUNCE_WEBHOOK_TOKEN is not set, bounce HTTP endpoints are disabled",
				"notice",
			);
			return null;
		}
		const server = this.getApp(token).listen(
			this.BOUNCE_HTTP_PORT,
			env.bounce.httpHost,
		);
		server.on("error", (err) =>
			Logging.dev("bounce HTTP Server has error " + err, "error"),
		);
		Logging.dev(
			white(`Bounce HTTP Server started Port: ${this.BOUNCE_HTTP_PORT}`),
		);
		return server;
	}
}
