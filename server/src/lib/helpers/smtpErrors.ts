import { type SmtpError, smtpReply } from "../../config/smtpMessages";
import { Logging } from "../logs";

export const isSmtpError = (error: unknown): error is SmtpError =>
	error instanceof Error &&
	typeof (error as Partial<SmtpError>).responseCode === "number";

export const toSmtpError = (error: unknown, context: string): SmtpError => {
	if (isSmtpError(error)) return error;
	Logging.dev(
		`${context}: ${error instanceof Error ? error.stack || error.message : String(error)}`,
		"error",
	);
	return smtpReply("INTERNAL_ERROR").toError();
};
