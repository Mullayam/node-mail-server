import "./config/env";
import "reflect-metadata";
import { SMTP_SERVICE } from "./server";

async function main() {
	await SMTP_SERVICE.Initialize();
}

export default main().catch((error) => {
	console.error(error);
	process.exit(1);
});
