import type { Request, Response } from "express";
import { HTTP_ERROR } from "../config/constants";
import { Logging } from "../lib/logs";
import { getMailRuntime } from "../server/mta/runtime";
import type { KumoLogRecord } from "./bounce/BounceProcessor";

class BounceWebhookHandler {
	async HandleKumoEvents(req: Request, res: Response): Promise<void> {
		const body = req.body as KumoLogRecord | KumoLogRecord[] | undefined;
		if (!body || typeof body !== "object") {
			res.status(400).json({ error: HTTP_ERROR.INVALID_BODY });
			return;
		}
		try {
			const { bounces } = getMailRuntime();
			for (const record of Array.isArray(body) ? body : [body]) {
				await bounces.handleKumoEvent(record);
			}
			res.json({ ok: true });
		} catch (error) {
			Logging.dev(`KumoMTA event processing failed: ${error}`, "error");
			res.status(500).json({ error: HTTP_ERROR.PROCESSING_FAILED });
		}
	}
	HandleGetSuppression(req: Request, res: Response): void {
		const email = String(req.params.email);
		const entry = getMailRuntime().suppression.check(email);
		if (!entry) {
			res.status(404).json({ error: HTTP_ERROR.NOT_FOUND });
			return;
		}
		res.json({ email, ...entry });
	}
	HandleDeleteSuppression(req: Request, res: Response): void {
		const removed = getMailRuntime().suppression.remove(
			String(req.params.email),
		);
		res.status(removed ? 204 : 404).end();
	}
}
export const NewBounceWebhookHandler = new BounceWebhookHandler();
