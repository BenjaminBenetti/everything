/** Recognize single SSH public keys or armored private-key files without decrypting or testing them. */
export function isSshKeyMaterial(material: string): boolean {
  const value = material.trim().replace(/\r\n/g, "\n");
  const publicKey =
    /^(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,2}(?:[ \t]+[^\n]*)?$/;
  const privateKey =
    /^-----BEGIN (OPENSSH PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY|DSA PRIVATE KEY|PRIVATE KEY|ENCRYPTED PRIVATE KEY)-----\n(?:Proc-Type: 4,ENCRYPTED\nDEK-Info: [A-Z0-9-]+,[A-Fa-f0-9]+\n\n)?[A-Za-z0-9+/]+(?:\n[A-Za-z0-9+/]+)*={0,2}\n-----END \1-----$/;
  return publicKey.test(value) || privateKey.test(value);
}
