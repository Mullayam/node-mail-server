export const loadOpenPgp = () => import("openpgp");

export type OpenPgp = Awaited<ReturnType<typeof loadOpenPgp>>;
export type OpenPgpPublicKey = Awaited<ReturnType<OpenPgp["readKey"]>>;
export type OpenPgpPrivateKey = Awaited<ReturnType<OpenPgp["decryptKey"]>>;
