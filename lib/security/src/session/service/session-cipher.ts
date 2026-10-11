import { CompactEncrypt, compactDecrypt } from "jose";
import type { SecretCipher } from "../interface/secret-cipher.js";
export type { SecretCipher } from "../interface/secret-cipher.js";

/** Use JOSE's authenticated encryption for credentials persisted by a server. */
export class SessionCipher implements SecretCipher {
  // ===========================================
  // Construction
  // ===========================================

  private readonly key: Uint8Array;

  /** Require an explicit 256-bit base64 key from deployment secrets. */
  constructor(encodedKey: string) {
    this.key = Buffer.from(encodedKey, "base64");
    if (
      this.key.length !== 32 ||
      Buffer.from(this.key).toString("base64") !== encodedKey
    )
      throw new Error("Session encryption requires a 256-bit base64 key");
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Encrypt with a fresh initialization vector and authenticated algorithm metadata. */
  async seal(value: string): Promise<string> {
    return new CompactEncrypt(new TextEncoder().encode(value))
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .encrypt(this.key);
  }

  /** Allow only the configured authenticated-encryption algorithms. */
  async open(value: string): Promise<string> {
    const result = await compactDecrypt(value, this.key, {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    return new TextDecoder().decode(result.plaintext);
  }
}
