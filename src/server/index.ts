import { IncomingServerConfig } from "./IncomingServer";
import { OutgoingServerConfig } from "./OutgoingServer";

/** More Resources for Further Research
 * https:*github.com/devmehq/email-validator-js
 * https:*github.com/forwardemail/free-email-forwarding/tree/master
 * https:*iredmail.org/
 * https:*github.com/zone-eu/zone-mta
 * https:*devsrealm.com/posts/b52728be7a1dbe83/send-only-mail-server-with-haraka
 * https:*iaziz786.com/blog/self-hosted-smtp-haraka/
 * https:*www.jetmore.org/john/code/swaks/installation.html
 * https:*github.com/guileen/node-sendmail/blob/master/examples/meetingRequest.js
 * https:*datatracker.ietf.org/doc/html/rfc8461
 */

export class SMTP_SERVICE {
	private static _instance: SMTP_SERVICE | null = null;
	private readonly INCOMING_MAIL_HOST = process.env.INCOMING_MAIL_HOST
	private readonly OUTGOING_MAIL_HOST = process.env.OUTGOING_MAIL_HOST || process.env.INCOMING_MAIL_HOST
	constructor() {
		const incomingServer = new IncomingServerConfig(this.INCOMING_MAIL_HOST);
		const outgoingServer = new OutgoingServerConfig(this.OUTGOING_MAIL_HOST);

		incomingServer.start();
		outgoingServer.start();
	}
	static Initialize() {
		if (!SMTP_SERVICE._instance) {
			SMTP_SERVICE._instance = new SMTP_SERVICE();
		}
		return SMTP_SERVICE._instance;
	}
}
