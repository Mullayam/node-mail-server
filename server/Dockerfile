# Inbound SMTP server. Runs the TypeScript with Bun, which resolves the
# "@/..." tsconfig path aliases that `node build/main.js` can't.
FROM oven/bun:1.3.6-slim

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --production

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

EXPOSE 25 587
CMD ["bun", "src/main.ts"]
