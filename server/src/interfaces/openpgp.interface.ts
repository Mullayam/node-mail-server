export interface PGPUserInfo {
  email: string;
}

export interface PGPKeyPair {
  publicKey: string;
  privateKey: string;
  revocationCertificate?: string;
}
