import { PGPFactory } from './PGPFactory';
import { PGPAdapter } from './PGPAdapter';
import { PGPUserInfo, PGPKeyPair } from '../../interfaces/openpgp.interface';

import * as openpgp from 'openpgp';

export class PGPService {
  /**
   * Generates a new PGP key pair for the given user IDs and password.
   *
   * @param userIDs - The user IDs to associate with the key pair.
   * @param password - The password to protect the private key.
   * @returns {Promise<PGPKeyPair>} - The generated key pair with the public and private keys in PEM format.
   */
  async generateKeyPair(userIDs: PGPUserInfo[], password: string): Promise<PGPKeyPair> {
    return await PGPFactory.generateKey(userIDs, password);
  }
  /**
 * Generate a fresh OpenPGP session (envelope) key.
 * 
 * @param symmetricAlgorithm - Optional symmetric cipher algorithm (default: AES-256)
 * @returns session key object with algorithm and key bytes
 */
  async generateSessionKey(): Promise<{ algorithm: string; key: string }> {
    const keyLengthBytes = 32; // AES-256
    const keyBuffer = crypto.getRandomValues(new Uint8Array(keyLengthBytes));
    return {
      algorithm: 'aes256',
      key: keyBuffer.toString(),
    };
  }

  /**
   * Encrypts a given plaintext message with the given key pair and password.
   *
   * @param plaintext - The message to be encrypted.
   * @param keyPair - The key pair to use for encryption.
   * @param password - The password to use for decryption.
   * @returns {Promise<string>} - The encrypted message in PEM format.
   */
  async encryptMessage(
    plaintext: string,
    keyPair: PGPKeyPair,
    password: string
  ): Promise<openpgp.WebStream<string>> {
    return PGPAdapter.encrypt({
      plaintext,
      publicKeyArmored: keyPair.publicKey,
      privateKeyArmored: keyPair.privateKey,
      password,
    });
  }

  /**
   * Decrypts a given ciphertext message with the given key pair and password.
   *
   * @param encrypted - The ciphertext message to be decrypted.
   * @param keyPair - The key pair to use for decryption.
   * @param password - The password to use for decryption.
   * @returns {Promise<string>} - The decrypted message.
   */
  async decryptMessage(
    encrypted: string,
    keyPair: PGPKeyPair,
    password: string
  ): Promise<string> {
    return await PGPAdapter.decrypt({
      encrypted,
      privateKeyArmored: keyPair.privateKey,
      publicKeyArmored: keyPair.publicKey,
      password,
    });
  }
}
