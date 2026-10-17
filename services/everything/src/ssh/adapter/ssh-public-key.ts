import {
  createPrivateKey,
  createPublicKey,
  type JsonWebKey,
} from "node:crypto";
import { readString, sshString } from "./agent-protocol.js";

/** OpenSSH's names for the curves its ECDSA keys use, by JSON Web Key curve. */
const ecdsaCurves: Readonly<Record<string, string>> = {
  "P-256": "nistp256",
  "P-384": "nistp384",
  "P-521": "nistp521",
};

/**
 * The base64 wire-format public key of an unencrypted private key, as `ssh-add -L` and the agent
 * protocol name it; undefined for public keys, passphrase-protected keys, and formats without one
 * here (DSA). OpenSSH keys carry their public key in clear; PEM keys are read with Node's crypto.
 */
export function sshPublicKey(material: string): string | undefined {
  const value = material.trim().replace(/\r\n/g, "\n");
  const openSsh =
    /^-----BEGIN OPENSSH PRIVATE KEY-----\n([A-Za-z0-9+/=\n]+)\n-----END OPENSSH PRIVATE KEY-----$/.exec(
      value,
    );
  try {
    if (openSsh) return openSshPublicKey(Buffer.from(openSsh[1]!, "base64"));
    return pemPublicKey(value);
  } catch {
    return undefined;
  }
}

/** Read the first public key of an unencrypted `openssh-key-v1` container. */
function openSshPublicKey(container: Buffer): string | undefined {
  const magic = Buffer.from("openssh-key-v1\0");
  if (!container.subarray(0, magic.length).equals(magic)) return undefined;
  const [cipher, afterCipher] = readString(container, magic.length);
  const [, afterKdf] = readString(container, afterCipher);
  const [, afterOptions] = readString(container, afterKdf);
  if (cipher.toString() !== "none" || afterOptions + 4 > container.length)
    return undefined;
  if (container.readUInt32BE(afterOptions) !== 1) return undefined;
  return readString(container, afterOptions + 4)[0].toString("base64");
}

/** Derive the public key of an unencrypted PEM RSA, ECDSA, or Ed25519 private key. */
function pemPublicKey(value: string): string | undefined {
  const jwk = createPublicKey(createPrivateKey(value)).export({
    format: "jwk",
  });
  const blob = publicKeyBlob(jwk);
  return blob?.toString("base64");
}

/** Encode a public JSON Web Key in OpenSSH's wire format. */
function publicKeyBlob(jwk: JsonWebKey): Buffer | undefined {
  if (jwk.kty === "RSA" && jwk.e && jwk.n)
    return Buffer.concat([
      sshString("ssh-rsa"),
      mpint(Buffer.from(jwk.e, "base64url")),
      mpint(Buffer.from(jwk.n, "base64url")),
    ]);
  if (jwk.kty === "EC" && jwk.crv && ecdsaCurves[jwk.crv] && jwk.x && jwk.y) {
    const curve = ecdsaCurves[jwk.crv]!;
    const point = Buffer.concat([
      Buffer.of(4),
      Buffer.from(jwk.x, "base64url"),
      Buffer.from(jwk.y, "base64url"),
    ]);
    return Buffer.concat([
      sshString(`ecdsa-sha2-${curve}`),
      sshString(curve),
      sshString(point),
    ]);
  }
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519" && jwk.x)
    return Buffer.concat([
      sshString("ssh-ed25519"),
      sshString(Buffer.from(jwk.x, "base64url")),
    ]);
  return undefined;
}

/** Encode an unsigned big-endian integer as an SSH `mpint`. */
function mpint(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const digits = value.subarray(start);
  return sshString(
    digits[0]! & 0x80 ? Buffer.concat([Buffer.of(0), digits]) : digits,
  );
}
