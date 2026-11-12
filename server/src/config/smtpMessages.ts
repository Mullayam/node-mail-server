import {
	CONFIG_ERROR,
	DEFAULT_SMTP_MESSAGES,
	type SmtpMessageDefinition,
	type SmtpMessageKey,
} from "./constants";
import { env } from "./env";
import { JsonConfig } from "./jsonConfig";

export type SmtpError = Error & { responseCode: number };
export type SmtpMessageParams = Record<string, string | number>;

export class SmtpResponse {
	constructor(
		readonly code: number,
		readonly status: string,
		readonly message: string,
	) {}

	get text(): string {
		return `${this.status} ${this.message}`;
	}

	toError(): SmtpError {
		return Object.assign(new Error(this.text), { responseCode: this.code });
	}
}

type SmtpMessages = Record<SmtpMessageKey, SmtpMessageDefinition>;

function validate(messages: SmtpMessages): string[] {
	const errors: string[] = [];
	for (const [key, definition] of Object.entries(messages)) {
		if (
			!Number.isInteger(definition.code) ||
			definition.code < 200 ||
			definition.code > 599
		) {
			errors.push(CONFIG_ERROR.INVALID_REPLY_CODE(key));
		}
		const match = /^([245])\.\d{1,3}\.\d{1,3}$/.exec(definition.status);
		if (!match || match[1] !== String(definition.code)[0]) {
			errors.push(CONFIG_ERROR.INVALID_REPLY_STATUS(key));
		}
		if (!definition.message.trim() || /[\r\n]/.test(definition.message)) {
			errors.push(CONFIG_ERROR.INVALID_REPLY_MESSAGE(key));
		}
	}
	return errors;
}

const store = new JsonConfig<SmtpMessages>({
	name: "smtp-messages.json",
	path: env.paths.smtpMessages,
	defaults: DEFAULT_SMTP_MESSAGES,
	validate,
});

const fill = (template: string, params?: SmtpMessageParams): string =>
	template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
		params && name in params
			? String(params[name]).replace(/[\r\n]+/g, " ")
			: placeholder,
	);

export function smtpReply(
	key: SmtpMessageKey,
	params?: SmtpMessageParams,
): SmtpResponse {
	const definition = store.value[key];
	return new SmtpResponse(
		definition.code,
		definition.status,
		fill(definition.message, params),
	);
}

export const smtpMessages = {
	load: () => store.load(),
	watch: () => store.watch(),
	close: () => store.close(),
};
