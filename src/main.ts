import "dotenv/config"
import "reflect-metadata"
import { SMTP_SERVICE } from "./server"

function main() {

    SMTP_SERVICE.Initialize()
}

export default main()