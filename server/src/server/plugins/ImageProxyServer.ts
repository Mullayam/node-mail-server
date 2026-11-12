import axios, { type AxiosResponse } from "axios";
import { createHash } from "crypto";
import dns from "dns";
import express, { type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import Redis from "ioredis";
import net from "net";

interface ImageProxyOptions {
	port: number;
	redisUrl: string;
	allowedDomains?: string[];
	cacheTTLSeconds?: number;
	maxImageBytes?: number;
}

const blockedRanges = new net.BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	blockedRanges.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
	["::", 128],
	["::1", 128],
	["64:ff9b::", 96],
	["100::", 64],
	["2001:db8::", 32],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const)
	blockedRanges.addSubnet(address, prefix, "ipv6");

const isBlockedAddress = (address: string): boolean => {
	const family = net.isIP(address);
	return (
		family === 0 || blockedRanges.check(address, family === 6 ? "ipv6" : "ipv4")
	);
};

const safeLookup = async (
	hostname: string,
): Promise<[{ address: string; family: 4 | 6 }[]]> => {
	const addresses = await dns.promises.lookup(hostname, { all: true });
	if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address))) {
		throw new Error(`Blocked address for ${hostname}`);
	}
	return [
		addresses.map((a) => ({
			address: a.address,
			family: a.family === 6 ? 6 : 4,
		})),
	];
};

export class ImageProxyServer {
	private app = express();
	private redis: Redis;
	private port: number;
	private allowedDomains: string[];
	private cacheTTL: number;
	private maxImageBytes: number;

	constructor(options: ImageProxyOptions) {
		this.port = options.port || 3000;
		this.allowedDomains = (options.allowedDomains || []).map((d) =>
			d.toLowerCase().replace(/^\./, ""),
		);
		this.cacheTTL = options.cacheTTLSeconds || 3600; // default 1 hour
		this.maxImageBytes = options.maxImageBytes || 5 * 1024 * 1024;
		this.redis = new Redis(options.redisUrl);

		this.setupMiddlewares();
		this.setupRoutes();
	}

	private setupMiddlewares() {
		const limiter = rateLimit({
			windowMs: 15 * 60 * 1000,
			max: 200,
			standardHeaders: true,
			legacyHeaders: false,
		});
		this.app.use(limiter);
	}

	private setupRoutes() {
		this.app.get("/proxy", async (req: Request, res: Response) => {
			const imageUrl = req.query.url;

			if (typeof imageUrl !== "string" || !imageUrl) {
				res.status(400).json({ error: "Missing image URL." });
				return;
			}

			const target = this.parseTarget(imageUrl);
			if (!target) {
				res.status(400).json({ error: "Invalid URL." });
				return;
			}

			if (!this.isHostAllowed(target.hostname)) {
				res.status(403).json({ error: "Domain not allowed." });
				return;
			}

			const cacheKey = `imgproxy:${createHash("sha256").update(target.href).digest("hex")}`;

			try {
				const [[, cachedBody], [, cachedType]] = (await this.redis
					.pipeline()
					.getBuffer(`${cacheKey}:body`)
					.get(`${cacheKey}:type`)
					.exec()) as [
					[Error | null, Buffer | null],
					[Error | null, string | null],
				];
				if (cachedBody && cachedType) {
					this.sendBuffer(res, cachedBody, cachedType);
					return;
				}

				const response: AxiosResponse<ArrayBuffer> = await axios.get(
					target.href,
					{
						responseType: "arraybuffer",
						timeout: 7000,
						maxContentLength: this.maxImageBytes,
						maxBodyLength: this.maxImageBytes,
						maxRedirects: 3,
						proxy: false,
						lookup: safeLookup,
						beforeRedirect: (options: { hostname?: string; host?: string }) => {
							if (
								!this.isHostAllowed(
									String(options.hostname || options.host || ""),
								)
							) {
								throw new Error("Redirect target not allowed");
							}
						},
						headers: { "User-Agent": "Mozilla/5.0 (EmailPrivacyProxy/1.0)" },
					},
				);

				const contentType = String(response.headers["content-type"] || "")
					.split(";")[0]
					.trim()
					.toLowerCase();
				if (
					!contentType.startsWith("image/") ||
					contentType === "image/svg+xml"
				) {
					this.sendFallbackImage(res);
					return;
				}
				const buffer = Buffer.from(response.data);

				await this.redis
					.multi()
					.set(`${cacheKey}:body`, buffer, "EX", this.cacheTTL)
					.set(`${cacheKey}:type`, contentType, "EX", this.cacheTTL)
					.exec();

				this.sendBuffer(res, buffer, contentType);
			} catch (error) {
				console.error("Proxy error:", (error as Error).message);
				this.sendFallbackImage(res);
			}
		});
	}

	public start() {
		this.app.listen(this.port, () => {
			console.log(
				`✅ Image Proxy Server running at http://localhost:${this.port}`,
			);
		});
	}

	private parseTarget(rawUrl: string): URL | null {
		try {
			const url = new URL(rawUrl);
			if (url.protocol !== "http:" && url.protocol !== "https:") return null;
			if (url.username || url.password) return null;
			const host = url.hostname.replace(/^\[|\]$/g, "");
			if (net.isIP(host) && isBlockedAddress(host)) return null;
			return url;
		} catch {
			return null;
		}
	}

	private isHostAllowed(hostname: string): boolean {
		const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
		if (net.isIP(host) && isBlockedAddress(host)) return false;
		if (this.allowedDomains.length === 0) return true;
		return this.allowedDomains.some(
			(domain) => host === domain || host.endsWith(`.${domain}`),
		);
	}

	private sendBuffer(res: Response, buffer: Buffer, contentType: string) {
		res.setHeader("Content-Type", contentType);
		res.setHeader("Cache-Control", "public, max-age=86400");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("X-Frame-Options", "DENY");
		res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
		res.send(buffer);
	}

	private sendFallbackImage(res: Response) {
		const transparentPixel = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AwAI/AL+Xz+HwQAAAABJRU5ErkJggg==",
			"base64",
		);
		res.setHeader("Content-Type", "image/png");
		res.setHeader("Cache-Control", "public, max-age=86400");
		res.send(transparentPixel);
	}
}
