import { MAIL_LIMITS } from "../../config/constants";
import { RawMessage } from "../../lib/helpers/RawMessage";
import { mailWorkers } from "../../lib/workers";
import type { ParsedDsn } from "../../lib/workers/mailTasks";
import type { BounceRegistry, TrackedMessage } from "./BounceRegistry";

export interface DsnAnalysis extends ParsedDsn {
	tracked?: TrackedMessage;
	viaVerp: boolean;
}

const VERP_LOCAL_PART = /^bounce\+([0-9a-f-]{36})$/i;
const REPORT_CONTENT_TYPE =
	/^content-type:[ \t]*multipart\/report\b[^\r\n]*report-type[ \t]*=[ \t]*"?(delivery-status|global-delivery-status|feedback-report)/im;
const MAX_HEADER_SCAN_BYTES = 64 * 1024;

export const verpIdOf = (address?: string) =>
	VERP_LOCAL_PART.exec((address ?? "").split("@")[0])?.[1];

export class DsnProcessor {
	constructor(private readonly registry: BounceRegistry) {}

	static isDeliveryReport(raw: Buffer): boolean {
		const headers = RawMessage.headers(raw, MAX_HEADER_SCAN_BYTES).replace(
			/\r?\n[ \t]+/g,
			" ",
		);
		return REPORT_CONTENT_TYPE.test(headers);
	}

	async analyze(
		raw: Buffer,
		envelopeRecipients: string[],
	): Promise<DsnAnalysis> {
		const parsed = await mailWorkers.parseDsn({
			raw,
			maxHeaderBytes: MAIL_LIMITS.MAX_ORIGINAL_HEADERS_BYTES,
		});
		const verpId = envelopeRecipients.map(verpIdOf).find(Boolean);
		const queueId = verpId ?? parsed.queueId;
		const tracked = queueId ? await this.registry.get(queueId) : undefined;
		return { ...parsed, queueId, tracked, viaVerp: Boolean(verpId) };
	}

	static isVerified(analysis: DsnAnalysis, recipient: string): boolean {
		if (!analysis.viaVerp || !analysis.tracked) return false;
		if (analysis.kind === "feedback") return true;
		const lower = recipient.toLowerCase();
		return analysis.tracked.recipients.some((r) => r.toLowerCase() === lower);
	}
}
