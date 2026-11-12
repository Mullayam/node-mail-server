import { availableParallelism } from "os";
import { extname, join } from "path";
import { env } from "../../config/env";
import { Logging } from "../logs";
import {
	type AuthenticateTask,
	type DkimSignTask,
	MAIL_TASKS,
	type MailTaskName,
	type MailTaskPayload,
	type MailTaskResult,
	type ParseDsnTask,
	type PgpEncryptTask,
} from "./mailTasks";
import { WorkerPool } from "./WorkerPool";

let pool: WorkerPool | null | undefined;
let fallbackLogged = false;

const getPool = (): WorkerPool | null => {
	if (pool !== undefined) return pool;
	const size =
		env.workers.count ?? Math.min(4, Math.max(1, availableParallelism() - 1));
	pool =
		size > 0
			? new WorkerPool(join(__dirname, `mail.worker${extname(__filename)}`), {
					size,
					maxTasksPerWorker: env.workers.concurrency,
					maxQueue: env.workers.maxQueue,
					taskTimeoutMs: env.workers.timeoutMs,
				})
			: null;
	return pool;
};

async function runMailTask<K extends MailTaskName>(
	name: K,
	payload: MailTaskPayload<K>,
): Promise<MailTaskResult<K>> {
	const active = getPool();
	if (active && !active.broken) {
		try {
			return await active.run<MailTaskResult<K>>(name, payload);
		} catch (error) {
			if (!active.broken) throw error;
		}
	}
	if (active?.broken && !fallbackLogged) {
		fallbackLogged = true;
		Logging.dev(
			`${active.broken.message}. Running mail tasks on the main thread.`,
			"error",
		);
	}
	return (
		MAIL_TASKS[name] as (
			payload: MailTaskPayload<K>,
		) => Promise<MailTaskResult<K>>
	)(payload);
}

const toBuffer = (data: Uint8Array): Buffer =>
	Buffer.isBuffer(data)
		? data
		: Buffer.from(data.buffer, data.byteOffset, data.byteLength);

export const mailWorkers = {
	authenticate: (task: AuthenticateTask) => runMailTask("authenticate", task),
	dkimSign: async (task: DkimSignTask) =>
		toBuffer(await runMailTask("dkimSign", task)),
	pgpEncrypt: (task: PgpEncryptTask) => runMailTask("pgpEncrypt", task),
	parseDsn: (task: ParseDsnTask) => runMailTask("parseDsn", task),
};

export const closeMailWorkers = async (): Promise<void> => {
	if (pool) await pool.close();
	pool = null;
};
