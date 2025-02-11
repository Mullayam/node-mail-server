import net from "net";
import dns from "dns";
import { MailConfig } from "../config/MailConfig";

// Not Recommended
export class NodeMailerMTA {
	private mxCache = new Map<string, { host: string; port: number }>();

	async DnsBasedDelivery(
		to: string,
		from: string,
		subject: string,
		body: string,
	) {
		return new Promise((resolve, reject) => {
			const domain = to.split("@")[1];

			// Lookup MX records for the recipient's domain
			dns.resolveMx(domain, (err, addresses) => {
				if (err || addresses.length === 0) {
					return reject(new Error(`Failed to resolve MX for ${domain}`));
				}
				// Sort MX records by priority (lowest first)
				addresses.sort((a, b) => a.priority - b.priority);
				const mxHost = addresses[0].exchange;
				console.log(`Connecting to MX host: ${mxHost}:${25}`);
				const client = net.createConnection(25, mxHost, () => {
					console.log(`Connected to recipient's mail server ${mxHost}:${25}`);
				});

				let response = "";

				client.on("data", async (data) => {
					response += data.toString();

					// Automatically proceed with SMTP handshake
					if (response.includes("220")) {
						client.write("EHLO test.example.com\r\n");
					} else if (response.includes("250-STARTTLS")) {
						await sendCommand(`MAIL FROM:<${from}>`);
					} else if (response.includes("250 Sender")) {
						await sendCommand(`RCPT TO:<${to}>`);
					} else if (response.includes("250 OK")) {
						await sendCommand(`DATA`);
						await sendCommand(
							`Subject: ${subject}\r\nFrom: ${from}\r\nTo: ${to}\r\n\r\n${body}\r\n.`,
						);
						await sendCommand(`QUIT`);
						client.end(); // Close connection after sending email
						resolve(response);
					} else if (response.includes("553")) {
						await sendCommand(`QUIT`);
						client.end(); // Close connection after getting relay error
						resolve(response);
					}
				});
				function sendCommand(command: string) {
					return new Promise<void>((res) => {
						client.write(command + "\r\n", "utf-8", () => res());
					});
				}
				client.on("error", (err) => {
					console.error("Connection error:", err);
					reject(err);
				});

				client.on("end", () => {
					console.log("SMTP Connection closed");
				});
			});
		});
	}
	async useTransport(totalRecipients: string[]) {
		const groupedRecipients =
			MailConfig.groupRecipientsByDomain(totalRecipients);
		for await (const [domain, recipients] of Object.entries(
			groupedRecipients,
		)) {
			try {
				let mxServer = this.mxCache.get(domain) || null;

				if (!mxServer) {
					mxServer = await MailConfig.checkConnections(domain);
					if (!mxServer) {
						continue;
					}
					this.mxCache.set(domain, mxServer);
				}
				//   send to recipients mx server
				for (const recipient in recipients) {
					const response = await MailConfig.createtransporter(
						mxServer.host,
						mxServer.port,
					).sendMail({
						text: recipient,
						//  extra data like from,body, aattachment

						//  Dkim Part is required otherwise mail will rejected,
						// dkim: {
						//     domainName: domain,
						//     keySelector: "default",
						//     privateKey: PVT_KEY
						// }
					});
				}

				console.log(`Mail Successfully Delivered`);
			} catch (error: any) {
				console.log(`Delivery Attempt Failed` + error.message);
			}
		}
	}
}
