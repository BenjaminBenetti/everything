/** Authenticated encryption boundary for server-held credentials. */
export interface SecretCipher {
  /** Encrypt a UTF-8 value with integrity protection. */
  seal(value: string): Promise<string>;
  /** Reject modified ciphertext and return its original value. */
  open(value: string): Promise<string>;
}
