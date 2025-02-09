# Documentation
Use Any Package Manager, I'mm just using `bun.sh`
Step 1.  Install Dependencies First (Recommended) `bun install`
Step 2.  Build the Applications `bun run build`, dont use `bun build`
Step 3 . Start with command `bun run dev` (Development) and `bun run start` with root permissions (Incase not able to start then use `sudo node ./build/main.js`)

## Working
- Go to src -> start.ts 
- Open and replace `your_domain` with your domain name
```ts
const records = new DNSRecordGenerator("cirrusmail.cloud").generateAllRecords();
```
and Run this File, Records will create in Json File.
- Use them as DNS Records 
### Note: Required Ports => 25, 587
 #### Port 25 is used for receiving mails and outbound traffice to send mail from your server to another mail server
 #### Port 587 is used for to connection to your mail server and create transport which send mail and process the mail , how it is going to deliver via Direct or Relay

### Generate SSL Ceritificate for using STARTTLS to prevent spam. Dont use Self Signed Certificate
Mail Server SSL Certificate Setup
Simple guide to secure your mail server with Let's Encrypt/ZeroSSL certificates using Certbot. This setup enables encrypted SMTP connections and works with any transport method (relay or direct delivery).

### Prerequisites

Linux server with root access
Domain with DNS A record pointing to your server
Port 80 temporarily available for verification

### Installation Steps

Install Certbot:

```bash
sudo apt update
sudo apt install certbot
```
Generate certificate:
```bash
sudo certbot certonly --standalone --preferred-challenges http -d mail.domain.com
```
Certificate locations:
Certificate: /etc/letsencrypt/live/mail.domain.com/fullchain.pem
Private key: /etc/letsencrypt/live/mail.domain.com/privkey.pem

Update Your .env
```
MAIL_HOST="mail.domain.com"
MAIL_SERVER_IP="127.0.0.1"
MAX_EMAILS_PER_MINUTE=5
TLS_PRIVATE_KEY_PATH="/etc/letsencrypt/live/mail.domain.com/privkey.pem"
TLS_CERTFICATE_PATH="/etc/letsencrypt/live/mail.domain.com/fullchain.pem"
```
