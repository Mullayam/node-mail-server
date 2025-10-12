import * as openpgp from 'openpgp';
import argon2 from 'argon2';

import { PGPUserInfo, PGPKeyPair } from '../../interfaces/openpgp.interface';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export class PGPFactory {
  static async deriveEnvelopeKey(passphrase: string, salt: Buffer) {
    // Argon2id KDF -> 32 bytes symmetric key
    return Buffer.from(await argon2.hash(passphrase, {
      salt,
      raw: true,
      type: argon2.argon2id,
      timeCost: 3,
      memoryCost: 1 << 16
    }));
  }
  static async generateAndWrapKey(privateKeyArmored: string, passphrase: string) {
    const salt = randomBytes(16);
    const envelopeKey = await PGPFactory.deriveEnvelopeKey(passphrase, salt);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', envelopeKey, iv, { authTagLength: 16 });
    const encrypted = Buffer.concat([cipher.update(privateKeyArmored, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const wrappedPrivateKey = Buffer.concat([iv, tag, encrypted]).toString('base64');
    return { envelopeKey, salt: salt.toString('base64'), wrappedPrivateKey };
  }
  static async unwrapPrivateKey(wrappedBase64: string, passphrase: string, saltBase64: string): Promise<string> {
    const salt = Buffer.from(saltBase64, 'base64');
    const envelopeKey = await PGPFactory.deriveEnvelopeKey(passphrase, salt);

    const wrapped = Buffer.from(wrappedBase64, 'base64');
    const iv = wrapped.slice(0, 12);
    const tag = wrapped.slice(12, 28);
    const encrypted = wrapped.slice(28);

    const decipher = createDecipheriv('aes-256-gcm', envelopeKey, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8'); 
  }
  /**
   * Generates a new PGP key pair for the given user IDs and password.
   * @param userIDs - The user IDs to associate with the key pair.
   * @param password - The password to protect the private key.
   * @returns {Promise<PGPKeyPair>} - The generated key pair with the public and private keys in PEM format.
   */
  static async generateKey(userIDs: PGPUserInfo[], password: string): Promise<PGPKeyPair> {
    const key = await openpgp.generateKey({
      type: 'rsa',
      rsaBits: 4096,
      userIDs,
      passphrase: password,
      format: 'armored',
    });

    return {
      publicKey: key.publicKey,
      privateKey: key.privateKey,
      revocationCertificate: key.revocationCertificate,
    };
  }
}
