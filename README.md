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


