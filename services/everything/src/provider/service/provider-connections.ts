import { randomUUID } from "node:crypto";
import AsyncLock from "async-lock";
import type { SecretCipher } from "@everything/security/session-cipher";
import {
  providerIds,
  providerLimits,
  type ApiKeyProviderId,
  type ProviderConnection,
  type ProviderId,
  type SaveProviderInput,
} from "@everything/provider-contracts";
import type { ProviderStore } from "../interface/provider-repository.js";
import type { ProviderConnections } from "../interface/provider-connections.js";
import type { ConnectionVerifier } from "../interface/connection-verifier.js";
import type { ChatGptAuthorization } from "../interface/chatgpt-authorization.js";
import type {
  PendingAuthorization,
  ProviderCredential,
  StoredProvider,
} from "../model/stored-provider.js";
import {
  ProviderAuthorizationError,
  ProviderInputError,
  ProviderNotConnectedError,
} from "../error/provider-errors.js";
import { verificationFailure } from "../error/provider-errors.js";

/** Own encrypted connection state transitions; no operation starts a teammate runtime. */
export class ProviderConnectionService implements ProviderConnections {
  // ===========================================
  // Construction
  // ===========================================

  private readonly locks = new AsyncLock({ maxPending: 20 });

  /** Inject storage, encryption, and provider-specific protocols. */
  constructor(
    private readonly store: ProviderStore,
    private readonly cipher: SecretCipher,
    private readonly verifiers: Readonly<
      Record<ProviderId, ConnectionVerifier>
    >,
    private readonly authorization: ChatGptAuthorization,
  ) {}

  // ===========================================
  // Connection operations
  // ===========================================

  /** Show the last successful check as verified for a bounded time without making paid requests. */
  async list(ownerId: string): Promise<ProviderConnection[]> {
    const records = await this.store.list({ ownerId });
    return providerIds.map((provider) =>
      this.publicState(
        provider,
        records.find((record) => record.provider === provider),
      ),
    );
  }

  /** Save write-only credentials, invalidating prior verification before checking the new settings. */
  async save(
    ownerId: string,
    provider: ApiKeyProviderId,
    input: SaveProviderInput,
  ): Promise<ProviderConnection> {
    return this.locks.acquire(`${ownerId}:${provider}`, async () => {
      const existing = await this.find(ownerId, provider);
      const previous = existing
        ? await this.open<ProviderCredential>(
            existing,
            existing.encryptedCredential,
          )
        : {};
      const baseUrl =
        provider === "anthropic"
          ? "https://api.anthropic.com/v1"
          : this.address(input.baseUrl ?? existing?.baseUrl ?? "");
      if (
        existing?.baseUrl &&
        baseUrl !== existing.baseUrl &&
        input.apiKey === undefined
      )
        throw new ProviderInputError(
          "Enter the API key for the new address, or leave it empty for a local server without a key.",
        );
      const apiKey = input.apiKey?.trim() ?? previous.apiKey ?? "";
      if (/[\r\n\0]/.test(apiKey))
        throw new ProviderInputError("Enter the API key as a single line.");
      if (provider === "anthropic" && !apiKey)
        throw new ProviderInputError("Enter your Claude API key.");
      const record: StoredProvider = {
        ...(existing ?? this.empty(ownerId, provider)),
        configured: true,
        baseUrl,
        model:
          input.model === undefined
            ? baseUrl === existing?.baseUrl
              ? existing.model
              : null
            : input.model.trim() || null,
        encryptedCredential: await this.seal(ownerId, provider, { apiKey }),
        encryptedPending: null,
        verifiedAt: null,
        verificationError: null,
      };
      await this.store.save({ ownerId }, record);
      return this.check(record);
    });
  }

  /** Serialize checks with edits, refreshes, and disconnects for the same connection. */
  async verify(
    ownerId: string,
    provider: ProviderId,
  ): Promise<ProviderConnection> {
    return this.locks.acquire(`${ownerId}:${provider}`, async () => {
      const record = await this.find(ownerId, provider);
      if (!record?.configured) throw new ProviderNotConnectedError();
      return this.check(record);
    });
  }

  /** Forget keys, revoke ChatGPT tokens where possible, and retain its stable registration. */
  async disconnect(ownerId: string, provider: ProviderId) {
    return this.locks.acquire(`${ownerId}:${provider}`, async () => {
      const record = await this.find(ownerId, provider);
      if (!record) return { message: null };
      if (provider !== "chatgpt") {
        await this.store.delete({ ownerId }, record.id);
        return { message: null };
      }
      const credential = await this.open<ProviderCredential>(
        record,
        record.encryptedCredential,
      );
      const revoked = await this.authorization.revoke(credential);
      const { hostId, clientId, subject } = credential;
      await this.store.save(
        { ownerId },
        {
          ...record,
          configured: false,
          account: null,
          model: null,
          verifiedAt: null,
          verificationError: null,
          encryptedPending: null,
          encryptedCredential: await this.seal(ownerId, provider, {
            hostId,
            clientId,
            subject,
          }),
        },
      );
      return {
        message: revoked
          ? null
          : "Disconnected here. Remote sign-out could not be confirmed; you can remove access in ChatGPT Settings.",
      };
    });
  }

  // ===========================================
  // ChatGPT authorization
  // ===========================================

  /** Persist state, nonce, PKCE, and the host ID before returning an authorization URL. */
  async authorize(ownerId: string) {
    return this.locks.acquire(`${ownerId}:chatgpt`, async () => {
      const existing = await this.find(ownerId, "chatgpt");
      const saved = existing
        ? await this.open<ProviderCredential>(
            existing,
            existing.encryptedCredential,
          )
        : {};
      const attempt = this.authorization.begin(saved);
      await this.store.save(
        { ownerId },
        {
          ...(existing ?? this.empty(ownerId, "chatgpt")),
          encryptedCredential: await this.seal(
            ownerId,
            "chatgpt",
            attempt.credential,
          ),
          encryptedPending: await this.seal(
            ownerId,
            "chatgpt",
            attempt.pending,
          ),
        },
      );
      return attempt.authorization;
    });
  }

  /** Consume an authorization exactly once and retain issued registration before token exchange. */
  async complete(
    ownerId: string,
    callback: string,
  ): Promise<ProviderConnection> {
    return this.locks.acquire(`${ownerId}:chatgpt`, async () => {
      let record = await this.find(ownerId, "chatgpt");
      if (!record?.encryptedPending) throw new ProviderAuthorizationError();
      const pending = await this.open<PendingAuthorization>(
        record,
        record.encryptedPending,
      );
      const saved = await this.open<ProviderCredential>(
        record,
        record.encryptedCredential,
      );
      record = { ...record, encryptedPending: null };
      await this.store.save({ ownerId }, record);
      const result = await this.authorization.complete(
        saved,
        pending,
        callback,
        async (credential) => {
          record = {
            ...record!,
            encryptedCredential: await this.seal(
              ownerId,
              "chatgpt",
              credential,
            ),
          };
          await this.store.save({ ownerId }, record);
        },
      );
      record = {
        ...record,
        configured: true,
        account: result.account,
        encryptedCredential: await this.seal(
          ownerId,
          "chatgpt",
          result.credential,
        ),
        verifiedAt: null,
        verificationError: null,
      };
      await this.store.save({ ownerId }, record);
      return this.check(record);
    });
  }

  // ===========================================
  // Verification and representation
  // ===========================================

  /** Persist a rotated grant before inference so a failed check cannot lose its refresh token. */
  private async check(saved: StoredProvider): Promise<ProviderConnection> {
    let record = {
      ...saved,
      verifiedAt: null,
      verificationError: null,
    } as StoredProvider;
    await this.store.save({ ownerId: record.ownerId }, record);
    try {
      let credential = await this.open<ProviderCredential>(
        record,
        record.encryptedCredential,
      );
      if (record.provider === "chatgpt") {
        credential = await this.authorization.refresh(credential);
        record = {
          ...record,
          encryptedCredential: await this.seal(
            record.ownerId,
            record.provider,
            credential,
          ),
        };
        await this.store.save({ ownerId: record.ownerId }, record);
      }
      const model = await this.verifiers[record.provider].verify({
        credential,
        baseUrl: record.baseUrl,
        model: record.model,
      });
      record = { ...record, model, verifiedAt: new Date() };
    } catch (error) {
      record = {
        ...record,
        verificationError:
          error instanceof ProviderAuthorizationError
            ? error.message
            : verificationFailure(error).message,
      };
    }
    await this.store.save({ ownerId: record.ownerId }, record);
    return this.publicState(record.provider, record);
  }

  /** Project a strict allowlist; credentials and pending OAuth state never reach the UI. */
  private publicState(
    provider: ProviderId,
    record?: StoredProvider,
  ): ProviderConnection {
    const configured = record?.configured ?? false;
    const fresh =
      record?.verifiedAt &&
      record.verifiedAt.getTime() >
        Date.now() - providerLimits.verificationLifetimeMs;
    return {
      provider,
      configured,
      status: !configured
        ? "disconnected"
        : record?.verificationError
          ? "error"
          : fresh
            ? "verified"
            : "unverified",
      baseUrl:
        provider === "openai-compatible" ? (record?.baseUrl ?? null) : null,
      model: record?.model ?? null,
      account: record?.account ?? null,
      verifiedAt: record?.verifiedAt?.toISOString() ?? null,
      message: record?.verificationError ?? null,
    };
  }

  /** The bounded connection catalog is always queried inside the caller's ownership scope. */
  private async find(
    ownerId: string,
    provider: ProviderId,
  ): Promise<StoredProvider | undefined> {
    return (await this.store.list({ ownerId })).find(
      (record) => record.provider === provider,
    );
  }

  /** Prepare a new record independently from persistence and runtime availability. */
  private empty(ownerId: string, provider: ProviderId): StoredProvider {
    return {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ownerId,
      provider,
      configured: false,
      baseUrl: null,
      model: null,
      account: null,
      encryptedCredential: "",
      encryptedPending: null,
      verifiedAt: null,
      verificationError: null,
    };
  }

  /** Allow explicit HTTP endpoints for local models while rejecting embedded credentials and URL parameters. */
  private address(value: string): string {
    try {
      const url = new URL(value.trim());
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
      return url.href.replace(/\/+$/, "");
    } catch {
      throw new ProviderInputError(
        "Enter an HTTP or HTTPS API base address without credentials or query parameters, including /v1 if your server uses it.",
      );
    }
  }

  /** Bind ciphertext to its owner and provider to reject swapped records. */
  private seal(
    ownerId: string,
    provider: ProviderId,
    value: unknown,
  ): Promise<string> {
    return this.cipher.seal(JSON.stringify({ ownerId, provider, value }));
  }

  /** Decrypt only a matching owner/provider envelope. */
  private async open<T>(
    record: StoredProvider,
    ciphertext: string,
  ): Promise<T> {
    const envelope = JSON.parse(await this.cipher.open(ciphertext)) as {
      ownerId: string;
      provider: ProviderId;
      value: T;
    };
    if (
      envelope.ownerId !== record.ownerId ||
      envelope.provider !== record.provider
    )
      throw new Error("Provider credential scope mismatch");
    return envelope.value;
  }
}
