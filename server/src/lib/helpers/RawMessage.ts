import type { Readable } from "stream";

export const normalizeIp = (ip: string): string => ip.replace(/^::ffff:/i, "");

export const collectMessage = (
	stream: Readable & { sizeExceeded?: boolean },
	maxBytes: number,
): Promise<Buffer | null> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let exceeded = false;
		stream.on("data", (chunk: Buffer) => {
			if (exceeded) return;
			size += chunk.length;
			if (size > maxBytes) {
				exceeded = true;
				chunks.length = 0;
				return;
			}
			chunks.push(chunk);
		});
		stream.once("error", reject);
		stream.once("end", () =>
			resolve(
				exceeded || stream.sizeExceeded ? null : Buffer.concat(chunks, size),
			),
		);
	});

export class RawMessage {
	static headerBoundary(raw: Buffer): number {
		const crlf = raw.indexOf("\r\n\r\n");
		const lf = raw.indexOf("\n\n");
		if (crlf === -1 && lf === -1) return raw.length;
		if (crlf === -1) return lf + 1;
		if (lf === -1) return crlf + 2;
		return Math.min(crlf + 2, lf + 1);
	}

	static headers(raw: Buffer, maxBytes: number = raw.length): string {
		return raw
			.subarray(0, Math.min(RawMessage.headerBoundary(raw), maxBytes))
			.toString("utf8");
	}

	static stripHeaders(
		raw: Buffer,
		shouldRemove: (name: string, value: string) => boolean,
	): Buffer {
		const boundary = RawMessage.headerBoundary(raw);
		const fields: string[] = [];
		for (const line of raw
			.subarray(0, boundary)
			.toString("latin1")
			.split(/(?<=\n)/)) {
			if (/^[ \t]/.test(line) && fields.length)
				fields[fields.length - 1] += line;
			else fields.push(line);
		}
		const kept = fields.filter((field) => {
			const colon = field.indexOf(":");
			return (
				colon <= 0 ||
				!shouldRemove(field.slice(0, colon).trim(), field.slice(colon + 1))
			);
		});
		if (kept.length === fields.length) return raw;
		return Buffer.concat([
			Buffer.from(kept.join(""), "latin1"),
			raw.subarray(boundary),
		]);
	}

	static prependHeaders(raw: Buffer, headers: string): Buffer {
		return headers ? Buffer.concat([Buffer.from(headers, "utf8"), raw]) : raw;
	}
}
