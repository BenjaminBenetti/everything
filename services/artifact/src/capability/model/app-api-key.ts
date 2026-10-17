import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { OwnedEntity } from "@everything/persistence/entity";
import {
  appApiKeyPattern,
  appApiKeyPrefix,
} from "@everything/artifact-contracts/api-key";

/** The app host's record of a dynamic app's current API key; it never holds the key itself. */
export interface AppApiKeyRecord extends OwnedEntity {
  readonly artifactId: string;
  /** SHA-256 of the key, compared in constant time. */
  readonly keyHash: string;
}

/** Accepted API key values, checked before any lookup. */
const keyPattern = new RegExp(appApiKeyPattern);

/** Generate a new key with 256 bits of randomness. */
export function newAppApiKey(): string {
  return appApiKeyPrefix + randomBytes(32).toString("base64url");
}

/** Whether a value has the exact form of an app API key. */
export function isAppApiKey(value: string): boolean {
  return keyPattern.test(value);
}

/** Hash a key for its verification record. */
export function appApiKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Compare a key with a stored hash without revealing, through timing, how much of it matched. */
export function matchesAppApiKey(key: string, keyHash: string): boolean {
  const expected = Buffer.from(keyHash, "hex");
  const actual = createHash("sha256").update(key).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
