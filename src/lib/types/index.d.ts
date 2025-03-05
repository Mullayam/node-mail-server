import { SMTPServer, SMTPServerDataStream, SMTPServerOptions, Session } from 'smtp-server';

declare module 'smtp-server' {
    interface SMTPServerOptions {
        onData(
            stream: SMTPServerDataStream,
            session: Session, // Use `Session` instead of `SMTPServerSession`
            callback: (err?: Error | null | undefined, message?: string) => void
        ): void;
    }
}