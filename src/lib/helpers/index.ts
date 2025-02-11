export class MiscellaneousHelper {
	public static filterId(inputId: string): string {
		let filteredId = inputId.split("@")[0];

		filteredId = filteredId.replace(/[^a-zA-Z0-9-]/g, "");

		return filteredId;
	}
	public static async delay(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
	static getStringSizeInBytes(str: string): number {
		return Buffer.byteLength(str, "utf8");
	}
	static extractEmail(input: string): string | null {
		const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
		const match = input.match(emailRegex);
		return match ? match[0] : null;
	}

	static extractNameAndEmail(input: string): {
		name: string | null;
		email: string;
	} {
		const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
		const nameRegex = /"([^"]+)"/; // Matches the name inside double quotes

		const emailMatch = input.match(emailRegex);
		const nameMatch = input.match(nameRegex);

		const email = emailMatch ? emailMatch[0] : input;
		const name = nameMatch ? nameMatch[1] : null;

		return { name, email };
	}
	public static extractDomainFromEmail(email: string): string {
		const emailParts = email.split("@");
		return emailParts[1];
	}
	public static getDomainUrl(request: Request) {
		const host =
			request.headers.get("X-Forwarded-Host") ?? request.headers.get("Host");
		if (!host) return null;

		const protocol = host.includes("localhost") ? "http" : "https";
		return `${protocol}://${host}`;
	}
	public static getDomainPathname(request: Request) {
		const pathname = new URL(request.url).pathname;
		if (!pathname) return null;
		return pathname;
	}
	public static combineHeaders(
		...headers: Array<ResponseInit["headers"] | null | undefined>
	) {
		const combined = new Headers();
		for (const header of headers) {
			if (!header) continue;
			for (const [key, value] of new Headers(header).entries()) {
				combined.append(key, value);
			}
		}
		return combined;
	}
	static singleton<Value>(name: string, value: () => Value): Value {
		const globalStore = global as any;

		globalStore.__singletons ??= {};
		globalStore.__singletons[name] ??= value();

		return globalStore.__singletons[name];
	}
	static getImageBase64() {
		return `data:image/png;base64,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`;
	}
}
