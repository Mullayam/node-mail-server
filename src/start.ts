import { writeFileSync } from "fs";
import { DNSRecordGenerator } from "./server/config/DnsRecordGenrator";

function createRecords() {



    const records = new DNSRecordGenerator("your_domain", process.env.MAIL_SERVER_IP as string).generateAllRecords();
    writeFileSync("records.json", JSON.stringify(records));

}
createRecords()