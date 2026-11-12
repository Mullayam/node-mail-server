import { createHash, timingSafeEqual } from "crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { HTTP_ERROR } from "../../config/constants";

const digest = (value: string) => createHash("sha256").update(value).digest();

export const bearerAuth = (token: string): RequestHandler => {
	const expected = digest(token);
	return (req: Request, res: Response, next: NextFunction) => {
		const header = req.get("authorization");
		const provided = header?.startsWith("Bearer ")
			? header.slice(7)
			: String(req.query.token ?? "");
		if (!provided || !timingSafeEqual(digest(provided), expected)) {
			res.status(401).json({ error: HTTP_ERROR.UNAUTHORIZED });
			return;
		}
		next();
	};
};

export const jsonErrorHandler =
	(message: string) =>
	(
		error: Error & { type?: string; status?: number },
		_req: Request,
		res: Response,
		_next: NextFunction,
	) => {
		const status =
			error.type === "entity.parse.failed"
				? 400
				: error.type === "entity.too.large"
					? 413
					: 500;
		res.status(status).json({ error: message });
	};
