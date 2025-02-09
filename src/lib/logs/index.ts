import { bold, greenBright, magenta, red, white, yellow } from "colorette"
import moment from 'moment';
type LoggingLevel = "info" | "error" | "debug" | "alert" | "notice"


class Logger {
    public static appName = 'NodeMailServer'
    constructor() {
        console.log("\u001b[2J\u001b[0;0H");
        console.log(greenBright(`[${Logger.appName}] ${yellow(process.pid)} - ${white(moment().format('DD/MM/YYYY hh:mm:ss A'))}, [INFO] ${Logger.name} Service Iniatialized`))
    }
    setName(name: string) {
        return Logger.appName = name
    }


    /**
     * Logs a message to the console.
     *
     * @param {string} text - The message to be logged.
     */
    log(text: string) {
        console.log(yellow(`----------- ${text} -------------`))
    };
    dev(text: string, type: LoggingLevel = "info") {

        if (type === "info") {
            return console.log(greenBright(`[${Logger.appName}] ${yellow(process.pid)} - ${white(moment().format('DD/MM/YYYY hh:mm:ss A'))}, [${(type).toUpperCase()}] ${text}`))
        }
        if (type === "error") {
            return console.log(red(`[${Logger.appName}] ${process.pid} - ${white(moment().format('DD/MM/YYYY hh:mm:ss A'))}, [${(type).toUpperCase()}] ${text} console.log`))
        }
        if (type === "debug") {
            console.log(bold(`[${Logger.appName}] ${process.pid} - ${white(moment().format('DD/MM/YYYY hh:mm:ss A'))}, [${(type).toUpperCase()}] ${text} console.log`))
            return process.exit(1)
        }
        if (type === "alert") {
            console.log(magenta(`[${Logger.appName}] ${yellow(process.pid)} - ${white(moment().format('DD/MM/YYYY hh:mm:ss A'))}, [${(type).toUpperCase()}] ${text}console.log`))
        }
        if (type === "notice") {
            return console.log(yellow(`[${Logger.appName}] ${process.pid} - ${white(moment().format('DD/MM/YYYY hh:mm:ss A'))}, [${(type).toUpperCase()}] ${text}console.log`))
        }
    };
    /**
     * Prints the given text in the console with a formatted alert message.
     *
     * @param {string} text - The text to be displayed in the alert message.
     */
    alert(text: string) {
        console.log(magenta(`----------- ${text} -------------`))
    };



}

const Logging = new Logger();
export { Logging }