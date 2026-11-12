export interface DsnOptions {
	notify?: ("SUCCESS" | "FAILURE" | "DELAY" | "NEVER")[];
	/** true = return headers only (HDRS), false = return full message (FULL) */
	returnHeaders?: boolean;
	envid?: string;
}

export interface RawMailOptions {
	from: string;
	to: string[];
	raw: Buffer;
	dsn?: DsnOptions;
}

export interface RelayOptions {
	host: string;
	port: number;
	auth?: { user: string; pass: string };
	tls?: { ca?: string | Buffer; rejectUnauthorized?: boolean };
}

export interface DeliveryResult {
	success: boolean;
	temporary: boolean;
	recipient: string;
	response?: string;
	error?: string;
	dsn?: {
		status: string;
		action: "delivered" | "failed" | "delayed" | "relayed" | "expanded";
		diagnosticCode?: string;
		remoteMta?: string;
		finalRecipient: string;
	};
}

export interface OutboundDriver {
	readonly name: string;
	send(mail: RawMailOptions): Promise<DeliveryResult[]>;
	close(): Promise<void>;
}
