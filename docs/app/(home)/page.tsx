import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 text-center">
      <h1 className="mb-4 text-3xl font-bold">NodeMailServer</h1>
      <p className="mb-8 max-w-xl text-fd-muted-foreground">
        A self-hosted mail stack. Receive mail on port 25, send it from port
        587, deliver it with KumoMTA and read it over IMAP.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/docs"
          className="rounded-lg bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground"
        >
          Read the docs
        </Link>
        <Link
          href="/docs/getting-started/installation"
          className="rounded-lg border px-4 py-2 text-sm font-medium"
        >
          Installation
        </Link>
      </div>
    </main>
  );
}
