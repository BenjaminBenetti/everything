import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type {
  ActivateRevisionInput,
  ArtifactApiKey,
  ArtifactBuild,
  ArtifactBuildDetails,
  ArtifactDetails,
  ArtifactFailure,
  ArtifactList,
  ArtifactLogs,
  ArtifactSource,
  ArtifactSummary,
  ArtifactView,
  ArtifactViewInput,
  ArtifactViewPass,
  ArtifactViewPassInput,
  CreateArtifactInput,
  DeployInput,
  MissingContent,
  PublishRevisionInput,
  StartBuildInput,
  UpdateArtifactInput,
} from "@everything/artifact-contracts";
import type { AccessTokenSource } from "@everything/security/client-credentials";
import { ArtifactRequestFailure } from "../error/artifact-errors.js";
import type {
  ArtifactActor,
  ArtifactGateway,
  LogChoice,
  SourceChoice,
  TeammateArtifactView,
} from "../interface/artifact-gateway.js";

/** Where Everything reaches the artifact service, and where teammate pods reach its artifact host. */
export interface ArtifactServiceAddresses {
  /** Base URL of the internal API. */
  readonly url: string;
  /** Origin of the artifact host inside the cluster. */
  readonly hostUrl: string;
}

/** How one request is sent and what it expects back. */
interface RequestOptions {
  readonly method?: string;
  readonly actor?: ArtifactActor;
  readonly json?: unknown;
  readonly body?: Blob;
  readonly timeoutMs?: number;
}

/** Most requests are small; uploads and downloads may move whole files. */
const defaultTimeoutMs = 30_000;
const transferTimeoutMs = 5 * 60_000;

/** Calls the artifact service's internal API with a service-account token. */
export class HttpArtifactGateway implements ArtifactGateway {
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the service's addresses and the token source; the fetcher is replaceable for tests. */
  constructor(
    private readonly addresses: ArtifactServiceAddresses,
    private readonly tokens: AccessTokenSource,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  // ===========================================
  // Artifacts
  // ===========================================

  /** List the owner's artifacts. */
  async list(ownerId: string): Promise<ArtifactSummary[]> {
    const result = await this.json<ArtifactList>(
      `${this.owner(ownerId)}/artifacts`,
    );
    return [...result.artifacts];
  }

  /** Create an unpublished artifact. */
  create(
    actor: ArtifactActor,
    input: CreateArtifactInput,
  ): Promise<ArtifactDetails> {
    return this.json(`${this.owner(actor.ownerId)}/artifacts`, {
      method: "POST",
      actor,
      json: input,
    });
  }

  /** Describe one artifact. */
  get(ownerId: string, reference: string): Promise<ArtifactDetails> {
    return this.json(this.artifact(ownerId, reference));
  }

  /** Change descriptive fields. */
  update(
    actor: ArtifactActor,
    reference: string,
    input: UpdateArtifactInput,
  ): Promise<ArtifactDetails> {
    return this.json(this.artifact(actor.ownerId, reference), {
      method: "PATCH",
      actor,
      json: input,
    });
  }

  /** Delete the artifact. */
  async delete(
    actor: ArtifactActor,
    reference: string,
    requireStopped = false,
  ): Promise<void> {
    await this.send(
      `${this.artifact(actor.ownerId, reference)}${requireStopped ? "?requireStopped=true" : ""}`,
      {
        method: "DELETE",
        actor,
      },
    );
  }

  /** Read a revision's or build's file list. */
  source(
    ownerId: string,
    reference: string,
    choice: SourceChoice,
  ): Promise<ArtifactSource> {
    const query = new URLSearchParams();
    if (choice.revision !== undefined)
      query.set("revision", String(choice.revision));
    if (choice.build !== undefined) query.set("build", String(choice.build));
    const suffix = query.size ? `?${query}` : "";
    return this.json(`${this.artifact(ownerId, reference)}/source${suffix}`);
  }

  // ===========================================
  // Content
  // ===========================================

  /** Ask which content still needs uploading. */
  async missingContent(hashes: readonly string[]): Promise<string[]> {
    const result = await this.json<MissingContent>(
      "/internal/v1/content/missing",
      {
        method: "POST",
        json: { hashes },
      },
    );
    return [...result.missing];
  }

  /** Upload one file's content. */
  async uploadContent(hash: string, content: Blob): Promise<void> {
    await this.send(`/internal/v1/content/${hash}`, {
      method: "PUT",
      body: content,
      timeoutMs: transferTimeoutMs,
    });
  }

  /** Download stored content as a Node stream. */
  async readContent(hash: string): Promise<Readable> {
    const response = await this.send(`/internal/v1/content/${hash}`, {
      timeoutMs: transferTimeoutMs,
    });
    if (!response.body) throw new Error("The apps service returned no content");
    return Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  }

  // ===========================================
  // Releases
  // ===========================================

  /** Publish a static artifact's next revision. */
  publish(
    actor: ArtifactActor,
    reference: string,
    input: PublishRevisionInput,
  ): Promise<ArtifactDetails> {
    return this.json(`${this.artifact(actor.ownerId, reference)}/revisions`, {
      method: "POST",
      actor,
      json: input,
    });
  }

  /** Make an earlier revision live again. */
  activate(
    actor: ArtifactActor,
    reference: string,
    revision: number,
    input: ActivateRevisionInput,
  ): Promise<ArtifactDetails> {
    return this.json(
      `${this.artifact(actor.ownerId, reference)}/revisions/${revision}/activate`,
      { method: "POST", actor, json: input },
    );
  }

  /** Start a build. */
  build(
    actor: ArtifactActor,
    reference: string,
    input: StartBuildInput,
  ): Promise<ArtifactBuild> {
    return this.json(`${this.artifact(actor.ownerId, reference)}/builds`, {
      method: "POST",
      actor,
      json: input,
    });
  }

  /** Read a build. */
  getBuild(
    ownerId: string,
    reference: string,
    number: number,
  ): Promise<ArtifactBuildDetails> {
    return this.json(`${this.artifact(ownerId, reference)}/builds/${number}`);
  }

  /** Deploy a build. */
  deploy(
    actor: ArtifactActor,
    reference: string,
    input: DeployInput,
  ): Promise<ArtifactDetails> {
    return this.json(`${this.artifact(actor.ownerId, reference)}/deployments`, {
      method: "POST",
      actor,
      json: input,
    });
  }

  /** Resume the app's saved release, preserving its image and runtime settings. */
  async start(
    actor: ArtifactActor,
    reference: string,
  ): Promise<ArtifactDetails> {
    return this.json(`${this.artifact(actor.ownerId, reference)}/start`, {
      method: "POST",
      actor,
    });
  }

  /** Stop a published app while retaining its files and data. */
  stop(actor: ArtifactActor, reference: string): Promise<ArtifactDetails> {
    return this.json(`${this.artifact(actor.ownerId, reference)}/stop`, {
      method: "POST",
      actor,
      json: {},
    });
  }

  /** Read container output. */
  logs(
    ownerId: string,
    reference: string,
    choice: LogChoice,
  ): Promise<ArtifactLogs> {
    const query = new URLSearchParams({
      previous: String(choice.previous),
      lines: String(choice.lines),
    });
    return this.json(`${this.artifact(ownerId, reference)}/logs?${query}`);
  }

  /** Issue a view link. */
  view(ownerId: string, input: ArtifactViewInput): Promise<ArtifactView> {
    return this.json(`${this.owner(ownerId)}/views`, {
      method: "POST",
      json: input,
    });
  }

  /** Read the app's API key. */
  apiKey(ownerId: string, reference: string): Promise<ArtifactApiKey> {
    return this.json(`${this.artifact(ownerId, reference)}/api-key`);
  }

  /** Issue a teammate pass and resolve its paths on the in-cluster artifact host. */
  async viewPass(
    ownerId: string,
    reference: string,
    input: ArtifactViewPassInput,
  ): Promise<TeammateArtifactView> {
    const pass = await this.json<ArtifactViewPass>(
      `${this.artifact(ownerId, reference)}/view-passes`,
      { method: "POST", json: input },
    );
    return {
      url: this.addresses.hostUrl + pass.path,
      browserUrl: this.addresses.hostUrl + pass.signInPath,
      token: pass.token,
      expiresAt: pass.expiresAt,
    };
  }

  // ===========================================
  // Transport
  // ===========================================

  /** Path of the owner's resources. */
  private owner(ownerId: string): string {
    return `/internal/v1/owners/${encodeURIComponent(ownerId)}`;
  }

  /** Path of one artifact. */
  private artifact(ownerId: string, reference: string): string {
    return `${this.owner(ownerId)}/artifacts/${encodeURIComponent(reference)}`;
  }

  /** Send a request and parse its JSON answer. */
  private async json<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    return (await (await this.send(path, options)).json()) as T;
  }

  /** Send an authenticated request, turning a failure answer into an ArtifactRequestFailure. */
  private async send(
    path: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    const headers = new Headers({
      Authorization: `Bearer ${await this.tokens.token()}`,
      Accept: "application/json",
    });
    if (options.actor) {
      headers.set("X-Everything-Actor-Id", options.actor.author.id);
      headers.set(
        "X-Everything-Actor-Name",
        encodeURIComponent(options.actor.author.name),
      );
    }
    let body: BodyInit | undefined;
    if (options.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.json);
    } else if (options.body) {
      headers.set("Content-Type", "application/octet-stream");
      body = options.body;
    }
    const response = await this.fetcher(this.addresses.url + path, {
      method: options.method ?? "GET",
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs),
    });
    if (response.ok) return response;
    let failure: Partial<ArtifactFailure> = {};
    try {
      failure = (await response.json()) as ArtifactFailure;
    } catch {
      // A body that is not JSON carries no caller-safe message.
    }
    throw new ArtifactRequestFailure(
      response.status,
      failure.code ?? "ARTIFACT_SERVICE_ERROR",
      failure.message ?? `The apps service failed (${response.status}).`,
    );
  }
}
