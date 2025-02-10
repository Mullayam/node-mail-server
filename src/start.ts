import { writeFileSync } from "fs";
import { DNSRecordGenerator } from "./server/config/DnsRecordGenrator";
import { Logging } from "./lib/logs";

async function createRecords() {

    Logging.dev("Creating DNS Records for your Domain", "notice");

    const records = await new DNSRecordGenerator("your_domain", process.env.MAIL_HOST as string).generateAllRecords();
    writeFileSync("records.json", JSON.stringify(records));
    Logging.dev("DNS Records Created", "info");

}
createRecords()