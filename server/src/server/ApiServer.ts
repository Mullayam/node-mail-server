import { white } from "colorette";
import express, { type Express } from "express";
import type { Server } from "http";
import { API_ERROR } from "../config/constants";
import { env } from "../config/env";
import { mailConfig } from "../config/mailConfig";
import { bearerAuth, jsonErrorHandler } from "../lib/helpers/httpAuth";
import { Logging } from "../lib/logs";
import { NewJsonMailHandler } from "../services/JsonMailHandler";

const BASE64_OVERHEAD = 1.4;
const JSON_ENVELOPE_BYTES = 64 * 1024;

export class ApiServerConfig {
	private API_PORT = env.api.port;
	private getApp(token: string): Express {
		const bodyLimit = Math.ceil(
			mailConfig.get().outgoing.maxMessageSizeBytes * BASE64_OVERHEAD +
				JSON_ENVELOPE_BYTES,
		);
		const app = express();
		app.disable("x-powered-by");
		app.get("/healthz", (_req, res) => {
			res.json({ ok: true });
		});
		app.use(bearerAuth(token));
		app.use(express.json({ limit: bodyLimit }));
		app.post("/v1/messages", (req, res) =>
			NewJsonMailHandler.HandleSend(req, res),
		);
		app.use(jsonErrorHandler(API_ERROR.INVALID_BODY));
		return app;
	}
	public start(): Server | null {
		if (!this.API_PORT || !mailConfig.get().api.enabled) return null;
		const token = env.api.token;
		if (!token) {
			Logging.dev(
				"MAIL_API_TOKEN is not set, the JSON send API is disabled",
				"notice",
			);
			return null;
		}
		const server = this.getApp(token).listen(this.API_PORT, env.api.host);
		server.on("error", (err) =>
			Logging.dev("JSON send API has error " + err, "error"),
		);
		Logging.dev(white(`JSON send API started Port: ${this.API_PORT}`));
		return server;
	}
}
