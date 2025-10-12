import * as openpgp from 'openpgp';
export class PGPAdapter {
  static async encrypt({
    plaintext,
    publicKeyArmored,
    privateKeyArmored,
    password,
  }: {
    plaintext: string;
    publicKeyArmored: string;
    privateKeyArmored: string;
    password: string;
  }): Promise<openpgp.WebStream<string>> {
    const publicKey = await openpgp.readKey({ armoredKey: publicKeyArmored });
    const privateKey = await openpgp.decryptKey({
      privateKey: await openpgp.readPrivateKey({ armoredKey: privateKeyArmored }),
      passphrase: password,
    });


    const message = await openpgp.createMessage({ text: plaintext });

    return openpgp.encrypt({
      message,
      encryptionKeys: publicKey,
      signingKeys: privateKey,
      config:{
       versionString: "Airsend Mail Client 1.0.1.2" ,
        commentString: 'Encrypted & Signed by ENJOYS',
      }
      // format: 'armored'
    });
  }

  static async decrypt({
    encrypted,
    privateKeyArmored,
    publicKeyArmored,
    password,
  }: {
    encrypted: string;
    privateKeyArmored: string;
    publicKeyArmored: string;
    password: string;
  }): Promise<string> {
    const privateKey = await openpgp.decryptKey({
      privateKey: await openpgp.readPrivateKey({ armoredKey: privateKeyArmored }),
      passphrase: password,
    });

    const publicKey = await openpgp.readKey({ armoredKey: publicKeyArmored });
    const message = await openpgp.readMessage({ armoredMessage: encrypted });

    const { data, signatures } = await openpgp.decrypt({
      message,
      verificationKeys: publicKey,
      decryptionKeys: privateKey,
    });

    await signatures[0].verified;
    return data.toString();
  }
}
