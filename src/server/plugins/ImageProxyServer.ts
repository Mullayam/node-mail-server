
import express, { Request, Response } from 'express';
import axios, { AxiosResponse } from 'axios';
import Redis from 'ioredis';
import rateLimit from 'express-rate-limit';

interface ImageProxyOptions {
    port: number;
    redisUrl: string;
    allowedDomains?: string[];
    cacheTTLSeconds?: number;
}

export class ImageProxyServer {
    private app = express();
    private redis: Redis;
    private port: number;
    private allowedDomains: string[];
    private cacheTTL: number;

    constructor(options: ImageProxyOptions) {
        this.port = options.port || 3000;
        this.allowedDomains = options.allowedDomains || [];
        this.cacheTTL = options.cacheTTLSeconds || 3600; // default 1 hour
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
        this.app.get('/proxy', async (req: Request, res: Response) => {
            const imageUrl = req.query.url as string;

            if (!imageUrl) {
                res.status(400).json({ error: 'Missing image URL.' }).end()
                return;
            }

            if (!/^https?:\/\//i.test(imageUrl)) {
                res.status(400).json({ error: 'Invalid URL.' }).end();
                return
            }

            if (!this.isDomainAllowed(imageUrl)) {
                res.status(403).json({ error: 'Domain not allowed.' }).end();
                return
            }

            try {
                const cached = await this.redis.getBuffer(imageUrl);
                if (cached) {
                    console.log(`[REDIS CACHE HIT] ${imageUrl}`);
                    this.sendBuffer(res, cached, 'image/jpeg');
                    return;
                }

                console.log(`[FETCHING] ${imageUrl}`);
                const response: AxiosResponse = await axios.get(imageUrl, {
                    responseType: 'arraybuffer',
                    timeout: 7000,
                    headers: { 'User-Agent': 'Mozilla/5.0 (EmailPrivacyProxy/1.0)' },
                });

                const contentType = response.headers['content-type'] || 'application/octet-stream';
                const buffer = Buffer.from(response.data, 'binary');

                // Store in Redis
                await this.redis.set(imageUrl, buffer, 'EX', this.cacheTTL);

                this.sendBuffer(res, buffer, contentType);

            } catch (error) {
                console.error('Proxy error:', (error as Error).message);
                this.sendFallbackImage(res);
            }
            finally {
                res.end();
            }
        });
    }

    public start() {
        this.app.listen(this.port, () => {
            console.log(`✅ Image Proxy Server running at http://localhost:${this.port}`);
        });
    }

    private isDomainAllowed(url: string): boolean {
        if (this.allowedDomains.length === 0) return true;
        try {
            const hostname = new URL(url).hostname;
            return this.allowedDomains.some(domain => hostname.endsWith(domain));
        } catch {
            return false;
        }
    }

    private sendBuffer(res: Response, buffer: Buffer, contentType: string) {
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.send(buffer);
    }

    private sendFallbackImage(res: Response) {
        const transparentPixel = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AwAI/AL+Xz+HwQAAAABJRU5ErkJggg==',
            'base64'
        );
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(transparentPixel);
    }
}
 