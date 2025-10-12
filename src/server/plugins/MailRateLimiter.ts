import { type Redis } from "ioredis";

export class MailRateLimiter {
    constructor(private readonly redis: Redis) {
        this.redis = redis
    }
    async isRateLimited(
        email: string,
        limits: {
            limit_per_minute: number;
            limit_per_Hour: number;
            limit_per_day: number;
        }
    ): Promise<boolean> {
        const keyMinute = `rate:${email}:minute`;
        const keyHour = `rate:${email}:hour`;
        const keyDay = `rate:${email}:day`;

        const [countMinute, countHour, countDay] = await Promise.all([
            this.redis.incr(keyMinute),
            this.redis.incr(keyHour),
            this.redis.incr(keyDay),
        ]);

        if (countMinute === 1) await this.redis.expire(keyMinute, 60);
        if (countHour === 1) await this.redis.expire(keyHour, 3600);
        if (countDay === 1) await this.redis.expire(keyDay, 86400);

        return countMinute > limits.limit_per_minute || countHour > limits.limit_per_Hour || countDay > limits.limit_per_day;
    }
}