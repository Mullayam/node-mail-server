import { randomUUID } from "crypto";
import { HEADER } from "../config/constants";
import { env } from "../config/env";
import { mailConfig } from "../config/mailConfig";
import { RawMessage } from "../lib/helpers/RawMessage";
import { Logging } from "../lib/logs";
import { mailWorkers } from "../lib/workers";
import { getMailRuntime } from "../server/mta/runtime";

export interface OutgoingSubmission {
	sender: string;
	recipients: string[];
	raw: Buffer;
	source: string;
}

const singleLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

const fillPlaceholders = (value: string, queueId: string, sender: string) =>
	value.replace(/\{queueId\}/g, queueId).replace(/\{sender\}/g, sender);

function outgoingHeaders(
	queueId: string,
	sender: string,
	bounceAddress?: string,
): Record<string, string> {
	const { customHeaders, bounceHeader } = mailConfig.get().outgoing;
	const headers: Record<string, string> = {};
	if (customHeaders.enabled) {
		for (const [name, value] of Object.entries(customHeaders.headers)) {
			headers[name] = singleLine(fillPlaceholders(value, queueId, sender));
		}
	}
	headers[HEADER.QUEUE_ID] = queueId;
	if (bounceAddress && bounceHeader.enabled)
		headers[bounceHeader.name] = bounceAddress;
	return headers;
}

export async function submitOutgoing({
	sender,
	recipients,
	raw,
	source,
}: OutgoingSubmission): Promise<string> {
	const config = mailConfig.get().outgoing;
	const { queue, bounces } = getMailRuntime();
	const queueId = randomUUID();
	const bounceAddress = bounces.bounceAddressFor(queueId, sender);

	const added = outgoingHeaders(queueId, sender, bounceAddress);
	const replaced = new Set([
		"bcc",
		...Object.keys(added).map((name) => name.toLowerCase()),
	]);
	const prepared = RawMessage.prependHeaders(
		RawMessage.stripHeaders(raw, (name) => replaced.has(name.toLowerCase())),
		Object.entries(added)
			.map(([name, value]) => `${name}: ${value}\r\n`)
			.join(""),
	);

	const dkimDomain = sender.split("@")[1];
	const dkimKey = env.dkim.privateKey;
	const signed =
		config.dkimSign && dkimKey && dkimDomain
			? await mailWorkers.dkimSign({
					raw: prepared,
					dkim: {
						domainName: dkimDomain,
						keySelector: env.dkim.selector,
						privateKey: dkimKey,
					},
					envelope: { from: sender, to: recipients },
				})
			: prepared;

	const returnPath = await bounces.prepareReturnPath(
		queueId,
		sender,
		recipients,
	);
	await queue.enqueue({
		id: queueId,
		from: returnPath,
		sender,
		recipients,
		raw: signed,
		dsn: { notify: ["FAILURE", "DELAY"], returnHeaders: true },
	});

	Logging.dev(
		`Outgoing mail queued id = ${queueId} source = ${source} driver = ${queue.driverName} from = ${sender || "<>"} to ${recipients.join(",")}`,
	);
	return queueId;
}
