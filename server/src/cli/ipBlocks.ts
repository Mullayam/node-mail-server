import { isIP } from "node:net";
import { serverDbPath } from "../lib/serverDb";
import { IpBlockStore } from "../services/IpBlockStore";

const USAGE = `Usage:
  bun src/cli/ipBlocks.ts list
  bun src/cli/ipBlocks.ts unblock <ip>
  bun src/cli/ipBlocks.ts block <ip> [reason]`;

const time = (ms: number) =>
	new Date(ms).toISOString().replace("T", " ").slice(0, 19);

const [command, ip, ...rest] = process.argv.slice(2);
if (!command || (command !== "list" && !isIP(ip ?? ""))) {
	console.error(USAGE);
	process.exit(1);
}

const store = new IpBlockStore(serverDbPath());
try {
	switch (command) {
		case "list": {
			const now = Date.now();
			const rows = store.list();
			console.log(`${rows.length} IP(s) in ${serverDbPath()}`);
			for (const b of rows) {
				const status = b.permanent
					? "PERMANENT"
					: b.blockedUntil > now
						? `blocked until ${time(b.blockedUntil)}`
						: "strike on record";
				console.log(
					`${b.ip.padEnd(39)} ${status.padEnd(33)} strikes ${b.strikes}  last ${time(b.lastStrike)}  ${b.reason}`,
				);
			}
			break;
		}
		case "unblock":
			console.log(
				store.unblock(ip) ? `Unblocked ${ip}` : `${ip} is not on the list`,
			);
			break;
		case "block":
			store.block(ip, rest.join(" ") || "blocked by an administrator");
			console.log(`Blocked ${ip} permanently`);
			break;
		default:
			console.error(USAGE);
			process.exitCode = 1;
	}
} finally {
	store.close();
}
