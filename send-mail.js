require('dotenv').config();
const nodemailer = require('nodemailer');
const readline = require('readline');
const dns = require('dns').promises;

// Function to prompt user input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function askQuestion(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

async function getMXRecord(email) {
    const domain = email.split('@')[1];
    try {
        const mxRecords = await dns.resolveMx(domain);
        return mxRecords.sort((a, b) => a.priority - b.priority)[0].exchange;
    } catch (error) {

        return null;
    }
}

async function sendMail(host, fromEmail, toEmail,pvt_key) {
    const transporter = nodemailer.createTransport({
        host,
        port: 25,
        logger: true,
        secure: false,
        tls: {
            rejectUnauthorized: false
        }
    });

    try {
        await transporter.verify();
        console.log("Transporter verified successfully");

        const info = await transporter.sendMail({
            from: fromEmail,
            to: toEmail,
            subject: 'Hello World',
            html: '<h1>Test Email</h1>',
            dkim:{
                domainName: fromEmail.split('@')[1],
                keySelector: "default",
                privateKey: pvt_key
            }
        });

        console.log("Email sent:", info);
    } catch (error) {
        console.error("Error:", error);
    }
}

async function main() {
    try {
        const fromEmail = await askQuestion("Enter mail from address: ");
        const toEmail = await askQuestion("Enter recipient address (only single email): ");
        const pvt_key = await askQuestion("Enter your private key: ");
        rl.close();

        const mxServer = await getMXRecord(toEmail);
        if (!mxServer) {
            throw new Error("MX record not found");
        }
        await sendMail(mxServer, fromEmail, toEmail,pvt_key);
    } catch (error) {
        console.error("Error:", error);
    }
}

main();
