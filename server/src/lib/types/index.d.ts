import {
	SMTPServer,
	SMTPServerDataStream,
	SMTPServerOptions,
	Session,
} from "smtp-server";

declare module "smtp-server" {
	interface SMTPServerOptions {
		hideDSN?: boolean;
		hideREQUIRETLS?: boolean;
		hideENHANCEDSTATUSCODES?: boolean;
		hidePIPELINING?: boolean;
		hideSTARTTLS?: boolean;
		hideSize?: boolean;
		hide8BITMIME?: boolean;
		hideSMTPUTF8?: boolean;
	}
	interface SMTPServerOptions {
		onData(
			stream: SMTPServerDataStream,
			session: SMTPServerSession,
			callback: (err?: Error | null | undefined, message?: string) => void,
		): void;
	}
}
