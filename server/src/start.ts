import { writeFileSync } from "fs";
import { env } from "./config/env";
import { Logging } from "./lib/logs";
import { DNSRecordGenerator } from "./server/config/DnsRecordGenrator";

async function createRecords() {
	Logging.dev("Creating DNS Records for your Domain", "notice");

	const records = await new DNSRecordGenerator(
		env.setup.domainName as string,
	).generateAllRecords();
	writeFileSync("records.json", JSON.stringify(records));
	Logging.dev("DNS Records Created", "info");
}
createRecords();
