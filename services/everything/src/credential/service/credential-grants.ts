import {
  appCredentialLimits,
  credentialEnvironmentProblem,
  type AppCredential,
  type AppCredentialGrant,
  type AppCredentialList,
  type AttachCredentialInput,
  type CredentialBindingRequest,
  type CredentialUsage,
} from "@everything/artifact-contracts/credential";
import type { AppCredentialStatus } from "@everything/artifact-contracts/credential";
import type { SecretCipher } from "@everything/security/session-cipher";
import {
  ArtifactNotFoundError,
  ArtifactRequestFailure,
  ArtifactServiceUnavailableError,
} from "../../artifact/error/artifact-errors.js";
import type { ArtifactActor } from "../../artifact/interface/artifact-gateway.js";
import {
  AppCredentialAccessError,
  CredentialOwnerOnlyError,
  KeyNotFoundError,
} from "../../key/error/key-errors.js";
import type { GenericCredentialRepository } from "../../key/interface/generic-credential-repository.js";
import type { KeyActor } from "../../key/model/key-actor.js";
import type { StoredKey } from "../../key/model/stored-key.js";
import {
  AmbiguousCredentialNameError,
  CredentialChangeRefusedError,
  CredentialNotFoundError,
  CredentialUnavailableError,
  DuplicateCredentialVariableError,
  InvalidCredentialVariableError,
  ReservedCredentialVariableError,
  TooManyCredentialsError,
} from "../error/credential-errors.js";
import type { ArtifactGateway } from "../../artifact/interface/artifact-gateway.js";
import type { ApplicationError } from "@everything/errors";
import type { CredentialGateway } from "../interface/credential-gateway.js";
import { effectiveStatus, usageFor } from "../model/credential-usage.js";
import type { CredentialRollouts } from "./credential-rollouts.js";

/** Refusals after which aligning the credential with what apps hold, and retrying once, can help. */
const alignable = new Set(["CREDENTIAL_VALUE_CONFLICT", "CREDENTIAL_CHANGED"]);

/** Whether a refusal means apps hold another value of the credential, or a newer one. */
export function needsAlignment(error: unknown): boolean {
  const code =
    (error as Partial<ApplicationError> | null)?.code ??
    (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && alignable.has(code);
}

/** One credential a teammate can attach, with the apps of its owner that use it. */
export interface CredentialCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly updatedAt: string;
  readonly apps: readonly {
    readonly app: string;
    readonly env: string;
    readonly status: AppCredentialStatus;
  }[];
}

/** Refuse variable names that can't hold a credential, before anything is looked up. */
export function requireCredentialVariables(
  requests: readonly { readonly env: string }[],
): void {
  if (requests.length > appCredentialLimits.count)
    throw new TooManyCredentialsError();
  const seen = new Set<string>();
  for (const { env } of requests) {
    const problem = credentialEnvironmentProblem(env);
    if (problem === "invalid") throw new InvalidCredentialVariableError(env);
    if (problem === "reserved") throw new ReservedCredentialVariableError(env);
    if (seen.has(env)) throw new DuplicateCredentialVariableError(env);
    seen.add(env);
  }
}

/**
 * Decide which generic credentials an app may receive and turn requests into grants. Only the
 * account that added a credential, and that account's teammates, may give it to apps: listing a
 * credential's metadata never implies permission to grant it. Names are resolved only among those
 * credentials, case-insensitively, and the result is pinned to the credential's stable ID.
 */
export class CredentialGrants {
  // ===========================================
  // Construction
  // ===========================================

  /** Inject credential storage, decryption, and the app service. */
  constructor(
    private readonly credentials: Pick<
      GenericCredentialRepository,
      "findByName" | "getById" | "list"
    >,
    private readonly cipher: Pick<SecretCipher, "open">,
    private readonly gateway: Pick<
      CredentialGateway,
      "attachCredential" | "detachCredential" | "credentialUses"
    > &
      Pick<ArtifactGateway, "get">,
    private readonly aligner: Pick<CredentialRollouts, "align">,
  ) {}

  // ===========================================
  // Teammates
  // ===========================================

  /** Resolve a teammate's requests among its owner's credentials, refusing missing or ambiguous names. */
  async resolve(
    ownerId: string,
    requests: readonly CredentialBindingRequest[],
  ): Promise<AppCredentialGrant[]> {
    requireCredentialVariables(requests);
    const grants: AppCredentialGrant[] = [];
    for (const request of requests) {
      const name = request.name.trim();
      const matches = await this.credentials.findByName(
        { usage: "credential-grant", ownerId },
        name,
      );
      if (!matches.length) throw new CredentialNotFoundError(name);
      if (matches.length > 1) throw new AmbiguousCredentialNameError(name);
      const [credential] = matches as [StoredKey];
      if (!credential.valueId) throw new CredentialUnavailableError();
      grants.push({
        credentialId: credential.id,
        env: request.env,
        version: credential.version,
        valueId: credential.valueId,
        value: await this.open(credential),
      });
    }
    return grants;
  }

  /** The credentials a teammate's owner can attach, and where that owner's apps use them. */
  async catalog(ownerId: string): Promise<CredentialCatalogEntry[]> {
    const credentials = await this.credentials.list({
      usage: "credential-grant",
      ownerId,
    });
    return Promise.all(
      credentials
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async (credential) => ({
          name: credential.name,
          description: credential.description ?? "",
          updatedAt: credential.updatedAt,
          apps: usageFor(
            ownerId,
            await this.gateway.credentialUses(credential.id),
            credential,
          ).apps.map(({ slug, env, status }) => ({ app: slug, env, status })),
        })),
    );
  }

  /** Make apps hold each credential's saved value before a refused grant of it is retried. */
  async align(credentialIds: readonly string[]): Promise<void> {
    for (const id of new Set(credentialIds)) await this.aligner.align(id);
  }

  // ===========================================
  // Users
  // ===========================================

  /**
   * Give one of the user's apps a credential the user added. Only the credential's owner gets as
   * far as the app; its credential generation is read before the value is opened and sent with
   * the grant, so a removal in between refuses it.
   */
  async attach(
    actor: KeyActor,
    appId: string,
    input: AttachCredentialInput,
  ): Promise<AppCredentialList> {
    if (actor.app) throw new AppCredentialAccessError();
    requireCredentialVariables([input]);
    const attempt = async () => {
      const credential = await this.credentials.getById(
        { usage: "credential-sync" },
        input.credentialId,
      );
      if (!credential || credential.deletedAt) throw new KeyNotFoundError();
      if (credential.ownerId !== actor.subject)
        throw new CredentialOwnerOnlyError();
      if (!credential.valueId) throw new CredentialUnavailableError();
      const { credentialGeneration } = await this.changing(() =>
        this.gateway.get(actor.subject, appId),
      );
      const value = await this.open(credential);
      return this.changing(() =>
        this.gateway.attachCredential(userActor(actor), appId, {
          credentialId: credential.id,
          env: input.env,
          version: credential.version,
          valueId: credential.valueId!,
          value,
          credentialGeneration,
        }),
      );
    };
    let details;
    try {
      details = await attempt();
    } catch (error) {
      if (!needsAlignment(error)) throw error;
      await this.align([input.credentialId]);
      details = await attempt();
    }
    return { credentials: await this.named(details.credentials) };
  }

  /** Take a credential away from one of the user's apps. */
  async detach(
    actor: KeyActor,
    appId: string,
    env: string,
  ): Promise<AppCredentialList> {
    if (actor.app) throw new AppCredentialAccessError();
    const details = await this.changing(() =>
      this.gateway.detachCredential(userActor(actor), appId, env),
    );
    return { credentials: await this.named(details.credentials) };
  }

  /** Which of the caller's apps use a generic credential; other accounts' apps are only counted. */
  async usage(actor: KeyActor, id: string): Promise<CredentialUsage> {
    const credential = await this.credentials.getById(
      { usage: "credential-sync" },
      id,
    );
    if (!credential) throw new KeyNotFoundError();
    try {
      return usageFor(
        actor.subject,
        await this.gateway.credentialUses(id),
        credential.deletedAt ? undefined : credential,
      );
    } catch {
      throw new ArtifactServiceUnavailableError();
    }
  }

  /**
   * Fill in current credential names; a credential that no longer exists has none. A grant that
   * doesn't hold the saved version and value is shown updating, and value identities stay internal.
   */
  async named(credentials: readonly AppCredential[]): Promise<AppCredential[]> {
    if (!credentials.length) return [];
    const stored = new Map(
      (await this.credentials.list({ usage: "credential-sync" })).map(
        (credential) => [credential.id, credential],
      ),
    );
    return credentials.map(({ valueId, ...credential }) => {
      const saved = stored.get(credential.credentialId);
      return {
        ...credential,
        name: saved?.name ?? null,
        status: effectiveStatus(
          { ...credential, valueId: valueId ?? null },
          saved && !saved.deletedAt ? saved : undefined,
        ),
      };
    });
  }

  // ===========================================
  // Helpers
  // ===========================================

  /** Decrypt a value, failing closed without saying why. */
  private async open(credential: StoredKey): Promise<string> {
    try {
      return await this.cipher.open(credential.encryptedMaterial);
    } catch {
      throw new CredentialUnavailableError();
    }
  }

  /** Express the app service's refusals as this API's errors, keeping its safe messages. */
  private async changing<T>(change: () => Promise<T>): Promise<T> {
    try {
      return await change();
    } catch (error) {
      if (error instanceof ArtifactRequestFailure) {
        if (error.status === 404 && error.code === "ARTIFACT_NOT_FOUND")
          throw new ArtifactNotFoundError();
        if (error.status >= 400 && error.status < 500)
          throw new CredentialChangeRefusedError(
            error.status,
            error.code,
            error.message,
          );
      }
      throw new ArtifactServiceUnavailableError();
    }
  }
}

/** The signed-in user acting on their own apps. */
function userActor(actor: KeyActor): ArtifactActor {
  return { ownerId: actor.subject, author: { id: actor.subject, name: "You" } };
}
