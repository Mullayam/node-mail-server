import { RATE_LIMIT } from "../config/constants";
import { mailConfig } from "../config/mailConfig";
import { type SmtpError, smtpReply } from "../config/smtpMessages";
import { normalizeIp } from "../lib/helpers/RawMessage";
import { Logging } from "../lib/logs";
import { serverDbPath } from "../lib/serverDb";
import { type BlockState, IpBlockStore, MINUTE_MS } from "./IpBlockStore";

const windows = new Map<string, { start: number; count: number }>();
let store: IpBlockStore | undefined;
let storeFailed = false;

setInterval(() => {
	const now = Date.now();
	for (const [ip, w] of windows) {
		if (now - w.start >= RATE_LIMIT.WINDOW_MS) windows.delete(ip);
	}
	if (store) {
		try {
			store.prune(mailConfig.get().incoming.ipBlocking.strikeResetHours, now);
		} catch (error) {
			Logging.dev(`IP block list cleanup failed: ${error}`, "error");
		}
	}
}, RATE_LIMIT.SWEEP_INTERVAL_MS).unref();

function openStore(): IpBlockStore | undefined {
	if (store || storeFailed) return store;
	try {
		store = new IpBlockStore(serverDbPath());
	} catch (error) {
		storeFailed = true;
		Logging.dev(
			`IP block list unavailable (${serverDbPath()}), blocks will not be kept: ${error}`,
			"error",
		);
	}
	return store;
}

function overLimit(ip: string, max: number, now: number): boolean {
	let w = windows.get(ip);
	if (!w || now - w.start >= RATE_LIMIT.WINDOW_MS) {
		w = { start: now, count: 0 };
		windows.set(ip, w);
	}
	w.count++;
	if (w.count <= max) return false;
	windows.delete(ip);
	return true;
}

function reply(
	ip: string,
	state: BlockState,
	now: number,
): SmtpError | undefined {
	if (state.kind === "permanent")
		return smtpReply("IP_BLOCKED", { ip }).toError();
	if (state.kind === "temporary")
		return smtpReply("RATE_LIMITED", {
			ip,
			seconds: Math.max(1, Math.ceil((state.until - now) / 1000)),
		}).toError();
	return undefined;
}

export const IpBlocklist = {
	enabled(): boolean {
		return mailConfig.get().incoming.ipBlocking.enabled;
	},

	rejection(remoteAddress: string, now = Date.now()): SmtpError | undefined {
		if (!this.enabled()) return undefined;
		const ip = normalizeIp(remoteAddress);
		try {
			const s = openStore();
			return s ? reply(ip, s.state(ip, now), now) : undefined;
		} catch (error) {
			Logging.dev(
				`IP block check failed for ${ip}, letting it through: ${error}`,
				"error",
			);
			return undefined;
		}
	},

	countMessage(
		remoteAddress: string,
		maxPerMinute: number,
		now = Date.now(),
	): SmtpError | undefined {
		const ip = normalizeIp(remoteAddress);
		if (!overLimit(ip, maxPerMinute, now)) return undefined;
		const policy = mailConfig.get().incoming.ipBlocking;
		const reason = `more than ${maxPerMinute} messages per minute`;
		const fallback: BlockState = {
			kind: "temporary",
			until: now + (policy.temporaryBlockMinutes[0] ?? 15) * MINUTE_MS,
			strikes: 1,
		};
		let state: BlockState;
		try {
			state = openStore()?.strike(ip, reason, policy, now) ?? fallback;
		} catch (error) {
			Logging.dev(`Could not record a strike for ${ip}: ${error}`, "error");
			state = fallback;
		}
		if (state.kind === "permanent") {
			Logging.dev(
				`IP ${ip} blocked permanently after strike ${state.strikes} (${reason})`,
				"alert",
			);
		} else if (state.kind === "temporary") {
			Logging.dev(
				`IP ${ip} strike ${state.strikes} of ${policy.temporaryBlockMinutes.length + 1}: blocked until ${new Date(state.until).toISOString()} (${reason})`,
				"notice",
			);
		}
		return reply(ip, state, now);
	},
};
