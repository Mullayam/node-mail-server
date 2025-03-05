const fs = require('fs');
const dns = require('dns');
const readline = require('readline');
const { exec } = require('child_process');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function askQuestion(query) {
    return new Promise((resolve) => {
        rl.question(query, (answer) => {
            if (!answer.trim()) {
                console.log("Input required. Exiting...");
                process.exit(1);
            }
            resolve(answer.trim());
        });
    });
}


(async function () {
    try {
        const SERVER_DOMAIN_NAME = await askQuestion("Enter the Mail Server Domain name: ");
        const SERVER_IP = await askQuestion("Enter the Mail Server IP: ");
        const MAIL_DOMAIN_NAME = await askQuestion("Enter that domain to handle mails: ");

        console.log("Mail Server Domain:", SERVER_DOMAIN_NAME);
        console.log("Mail Handling Domain:", MAIL_DOMAIN_NAME);



        const envContent = `INCOMING_MAIL_HOST=mx.${SERVER_DOMAIN_NAME}\nOUTGOING_MAIL_HOST=mail.${SERVER_DOMAIN_NAME}\nMAIL_SERVER_IP=${SERVER_IP}\nMAX_EMAILS_PER_MINUTE=5\nTLS_PRIVATE_KEY_PATH=\nTLS_CERTFICATE_PATH=`;

        fs.writeFileSync('.env', envContent, 'utf8');
        console.log("Environment Configuration file created successfully.");

        console.log("Creating DNS Records for your Domain");
        

        exec(`tsc -p . && DOMAIN_NAME=${MAIL_DOMAIN_NAME} node ./build/start.js`,{
            shell: "bash",        
        }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Execution error: ${error.message}`);
                return;
            }
            if (stderr) {
                console.error(`stderr: ${stderr}`);
                return;
            }
            console.log(`stdout: ${stdout}`);
        });
    } catch (error) {
        console.error("Error:", error);
    } finally {
        rl.close();
    }
})();
