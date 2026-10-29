import type { BaseEntity, OwnedEntity } from "@everything/persistence/entity";

/**
 * A credential an app's backend receives: the grant is by stable credential ID, never by name, and
 * records the version of the value stored for the app. Grants live apart from deployment history.
 */
export interface CredentialBinding extends OwnedEntity {
  readonly artifactId: string;
  readonly credentialId: string;
  readonly env: string;
  readonly version: number;
  /** Random identity of the stored value; null only for grants made before identities existed. */
  readonly valueId: string | null;
}

/** A grant to store for an app; its owner and app come from the scope. */
export type NewCredentialBinding = Pick<
  CredentialBinding,
  "credentialId" | "env" | "version" | "valueId"
>;

/**
 * The app service's durable record of one credential: the newest version delivered, and when it
 * was revoked. A revoked credential can never be granted again, and an older value is never stored
 * after a newer one was delivered. The record's ID is the credential's ID.
 */
export interface CredentialRecord extends BaseEntity {
  readonly version: number;
  /**
   * Identity of that version's value. A version is accepted with only one value, so a pod's version
   * annotation identifies its value exactly; null only for records made before identities existed.
   */
  readonly valueId: string | null;
  readonly revokedAt: string | null;
}

/**
 * How many times an app's set of credential grants has changed. Grants that add access must name
 * the generation they were authorized against; any change in between, such as a removal, refuses
 * them. The record's ID is the app's ID.
 */
export interface CredentialGeneration extends BaseEntity {
  readonly generation: number;
}

/** One credential a process holds: its variable, credential, and value version. */
export interface CredentialEntry {
  readonly env: string;
  readonly credentialId: string;
  readonly version: number;
}

/** Pod annotation listing the credential entries a pod's environment was created with. */
export const credentialAnnotation = "everything.dev/credentials";

/** Entry text, such as `SLACK_TOKEN=<credential id>@3`; identifiers only, never the value. */
export function formatCredentialEntry(entry: CredentialEntry): string {
  return `${entry.env}=${entry.credentialId}@${entry.version}`;
}

/** Annotation value for a set of entries, in a stable order so unchanged sets never roll pods. */
export function formatCredentialEntries(
  entries: readonly CredentialEntry[],
): string {
  return entries.map(formatCredentialEntry).sort().join(",");
}

/** Read entries back from a pod's annotation, skipping anything malformed. */
export function parseCredentialEntries(
  annotation: string | undefined,
): CredentialEntry[] {
  if (!annotation) return [];
  return annotation.split(",").flatMap((text) => {
    const match =
      /^([A-Za-z_][A-Za-z0-9_]*)=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@([1-9][0-9]{0,9})$/.exec(
        text,
      );
    return match
      ? [{ env: match[1]!, credentialId: match[2]!, version: Number(match[3]) }]
      : [];
  });
}
