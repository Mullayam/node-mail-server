import { parentPort } from "worker_threads";
import { MAIL_TASKS, type MailTaskName } from "./mailTasks";

interface TaskMessage {
	id: number;
	type: MailTaskName;
	payload: unknown;
}

parentPort?.on("message", async ({ id, type, payload }: TaskMessage) => {
	try {
		const handler = MAIL_TASKS[type] as
			| ((payload: unknown) => Promise<unknown>)
			| undefined;
		if (!handler) throw new Error(`Unknown mail worker task ${type}`);
		parentPort?.postMessage({ id, ok: true, result: await handler(payload) });
	} catch (error) {
		const failure = error as {
			message?: string;
			code?: string;
			responseCode?: number;
		};
		parentPort?.postMessage({
			id,
			ok: false,
			error: {
				message: failure?.message ?? String(error),
				code: failure?.code,
				responseCode: failure?.responseCode,
			},
		});
	}
});
