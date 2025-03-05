import "dotenv/config";
import { writeFileSync } from "fs";
import { DNSRecordGenerator } from "./server/config/DnsRecordGenrator";
import { Logging } from "./lib/logs";

async function createRecords() {
	Logging.dev("Creating DNS Records for your Domain", "notice");
	 
	const records = await new DNSRecordGenerator(
		process.env.DOMAIN_NAME as string,
	).generateAllRecords();
	writeFileSync("records.json", JSON.stringify(records));
	Logging.dev("DNS Records Created", "info");
}
createRecords();
