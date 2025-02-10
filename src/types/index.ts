type ENV = {
    MAIL_HOST: string
    MAIL_SERVER_IP: string
    MAX_EMAILS_PER_MINUTE: string
    TLS_PRIVATE_KEY_PATH: string
    TLS_CERTFICATE_PATH: string
}
declare global {
    namespace NodeJS {
        interface ProcessEnv extends ENV { }
    }
}