import { BlockList, isIP } from "net";
import {
	CONFIG_ERROR,
	DEFAULT_MAIL_CONFIG,
	FREEFORM_CONFIG_PATHS,
	type MailConfig,
	POLICY_ACTION,
	POLICY_ACTION_PATHS,
} from "./constants";
import { env } from "./env";
import { JsonConfig } from "./jsonConfig";

const POLICY_ACTIONS = new Set<string>(Object.values(POLICY_ACTION));

const valueAt = (config: MailConfig, path: string): unknown =>
	path
		.split(".")
		.reduce<unknown>(
			(node, key) => (node as Record<string, unknown>)?.[key],
			config,
		);

const parseNetwork = (
	cidr: string,
): { address: string; prefix: number; family: "ipv4" | "ipv6" } | null => {
	const [address, prefixText] = cidr.split("/");
	const version = isIP(address);
	if (!version) return null;
	const max = version === 4 ? 32 : 128;
	const prefix = prefixText === undefined ? max : Number(prefixText);
	if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
	return { address, prefix, family: version === 4 ? "ipv4" : "ipv6" };
};

const positivePaths = [
	"incoming.maxMessageSizeBytes",
	"incoming.maxRecipients",
	"incoming.rateLimit.maxMessagesPerMinute",
	"outgoing.maxMessageSizeBytes",
	"outgoing.maxRecipients",
	"queue.maxConcurrent",
	"queue.maxAgeHours",
	"bounces.suppression.days",
	"bounces.trackingDays",
] as const;

function validate(config: MailConfig): string[] {
	const errors: string[] = [];
	for (const path of POLICY_ACTION_PATHS) {
		if (!POLICY_ACTIONS.has(String(valueAt(config, path))))
			errors.push(CONFIG_ERROR.INVALID_ACTION(path));
	}
	for (const path of positivePaths) {
		const value = valueAt(config, path);
		if (typeof value !== "number" || !(value > 0))
			errors.push(CONFIG_ERROR.WRONG_TYPE(path, "a number above 0"));
	}
	if (
		!config.queue.retryDelaysMinutes.length ||
		config.queue.retryDelaysMinutes.some((m) => !(m > 0))
	) {
		errors.push(
			CONFIG_ERROR.WRONG_TYPE(
				"queue.retryDelaysMinutes",
				"a non-empty list of minutes above 0",
			),
		);
	}
	for (const cidr of config.incoming.trustedNetworks) {
		if (!parseNetwork(cidr))
			errors.push(CONFIG_ERROR.INVALID_CIDR("incoming.trustedNetworks", cidr));
	}
	return errors;
}

const store = new JsonConfig<MailConfig>({
	name: "mail.config.json",
	path: env.paths.mailConfig,
	defaults: DEFAULT_MAIL_CONFIG,
	freeformPaths: FREEFORM_CONFIG_PATHS,
	validate,
});

let trusted: { source: readonly string[]; list: BlockList } | undefined;

export const mailConfig = {
	get: (): MailConfig => store.value,
	load: () => store.load(),
	watch: () => store.watch(),
	close: () => store.close(),
	onChange: (listener: (config: MailConfig) => void) =>
		store.onChange(listener),
	isTrustedAddress(ip: string): boolean {
		const networks = store.value.incoming.trustedNetworks;
		if (trusted?.source !== networks) {
			const list = new BlockList();
			for (const cidr of networks) {
				const network = parseNetwork(cidr);
				if (network)
					list.addSubnet(network.address, network.prefix, network.family);
			}
			trusted = { source: networks, list };
		}
		const version = isIP(ip);
		return (
			version !== 0 && trusted.list.check(ip, version === 6 ? "ipv6" : "ipv4")
		);
	},
};
