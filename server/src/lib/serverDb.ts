import { join } from "node:path";
import { DEFAULTS } from "../config/constants";
import { env } from "../config/env";

export const serverDbPath = (): string =>
	join(env.paths.dataDir, DEFAULTS.SERVER_DB_FILE);
