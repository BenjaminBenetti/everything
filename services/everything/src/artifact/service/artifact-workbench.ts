import { openAsBlob } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  ArtifactAuthor,
  ArtifactBuild,
  ArtifactBuildDetails,
  ArtifactDetails,
  ArtifactKind,
  ArtifactLogs,
  ArtifactSummary,
  ArtifactViewPassInput,
  DeployInput,
} from "@everything/artifact-contracts";
import type { CredentialBindingRequest } from "@everything/artifact-contracts/credential";
import {
  needsAlignment,
  type CredentialCatalogEntry,
  type CredentialGrants,
} from "../../credential/service/credential-grants.js";
import type {
  ArtifactActor,
  ArtifactGateway,
  LogChoice,
  TeammateArtifactView,
} from "../interface/artifact-gateway.js";
import { checkoutFiles } from "./artifact-checkout.js";
import { inWorkspace, workspaceDirectory } from "./workspace-path.js";
import { snapshotDirectory, type Snapshot } from "./workspace-snapshot.js";

/** The teammate using artifact tools: its owner, identity, working directory, and the shared folder. */
export interface WorkbenchContext {
  readonly ownerId: string;
  readonly author: ArtifactAuthor;
  readonly workspace: string;
  readonly shared: string;
  /** The teammate's private runtime state inside its workspace, never uploaded. */
  readonly privateDirectory: string;
}

/** Files skipped while uploading, reported back to the teammate. */
export interface UploadNote {
  readonly skipped: readonly string[];
}

/** A checkout's result. */
export interface CheckoutResult {
  readonly directory: string;
  readonly origin: "revision" | "build";
  readonly number: number;
  /** Release live when the source was read; pass it as `basedOn` when releasing again. */
  readonly release: number;
  readonly fileCount: number;
}

/** A teammate's deployment, naming credentials instead of carrying their values. */
export type WorkbenchDeployInput = Omit<DeployInput, "credentials"> & {
  /** Omit to keep the app's credentials; an empty list removes them. */
  readonly credentials?: readonly CredentialBindingRequest[];
};

/** Longest a teammate may wait for a build in one tool call. */
export const maximumBuildWaitSeconds = 60;

/** Seconds between checks while waiting for a build. */
const buildPollSeconds = 2;

/** Uploads running at once. */
const uploadConcurrency = 4;

/** Turns a teammate's workspace directories into artifact releases, and releases back into files. */
export class ArtifactWorkbench {
  // ===========================================
  // Construction
  // ===========================================

  /** Use the artifact service through its gateway, and credentials through their grants. */
  constructor(
    private readonly gateway: ArtifactGateway,
    private readonly credentials: Pick<
      CredentialGrants,
      "resolve" | "named" | "catalog" | "align"
    >,
  ) {}

  // ===========================================
  // Records
  // ===========================================

  /** List every shared artifact. */
  async list(context: WorkbenchContext): Promise<ArtifactSummary[]> {
    return Promise.all(
      (await this.gateway.list(context.ownerId)).map((artifact) =>
        this.named(artifact),
      ),
    );
  }

  /** Create an artifact on the teammate's behalf. */
  async create(
    context: WorkbenchContext,
    input: {
      slug: string;
      kind: ArtifactKind;
      title: string;
      description?: string;
    },
  ): Promise<ArtifactDetails> {
    return this.named(
      await this.gateway.create(this.actor(context), {
        slug: input.slug,
        kind: input.kind,
        title: input.title,
        description: input.description ?? "",
      }),
    );
  }

  /** Describe one artifact. */
  async get(
    context: WorkbenchContext,
    reference: string,
  ): Promise<ArtifactDetails> {
    return this.named(await this.gateway.get(context.ownerId, reference));
  }

  /** Change descriptive fields. */
  async update(
    context: WorkbenchContext,
    reference: string,
    input: { title?: string; description?: string },
  ): Promise<ArtifactDetails> {
    return this.named(
      await this.gateway.update(this.actor(context), reference, input),
    );
  }

  /** Delete an artifact. */
  delete(context: WorkbenchContext, reference: string): Promise<void> {
    return this.gateway.delete(this.actor(context), reference);
  }

  /** Get a short-lived pass with which the teammate opens one artifact from its pod, as the user sees it. */
  view(
    context: WorkbenchContext,
    reference: string,
    input: ArtifactViewPassInput,
  ): Promise<TeammateArtifactView> {
    return this.gateway.viewPass(context.ownerId, reference, input);
  }

  // ===========================================
  // Source
  // ===========================================

  /** Copy a revision's or build's files into a workspace directory. */
  async checkout(
    context: WorkbenchContext,
    reference: string,
    input: {
      directory: string;
      revision?: number;
      build?: number;
      overwrite?: boolean;
    },
  ): Promise<CheckoutResult> {
    const target = await this.directory(context, input.directory, false);
    const source = await this.gateway.source(context.ownerId, reference, {
      ...(input.revision !== undefined ? { revision: input.revision } : {}),
      ...(input.build !== undefined ? { build: input.build } : {}),
    });
    await inWorkspace(context, () =>
      checkoutFiles(
        target,
        source.files,
        (hash) => this.gateway.readContent(hash),
        {
          overwrite: input.overwrite ?? false,
          privateDirectory: context.privateDirectory,
        },
      ),
    );
    return {
      // Relative to the workspace, or absolute in the shared folder.
      directory: target.startsWith(`${context.workspace}${path.sep}`)
        ? path.relative(context.workspace, target)
        : target,
      origin: source.origin,
      number: source.number,
      release: source.release,
      fileCount: source.files.length,
    };
  }

  // ===========================================
  // Static artifacts
  // ===========================================

  /** Publish a workspace directory as the next revision, or make an earlier revision live again. */
  async publish(
    context: WorkbenchContext,
    reference: string,
    input: { directory?: string; revision?: number; basedOn?: number },
  ): Promise<ArtifactDetails & UploadNote> {
    const basedOn =
      input.basedOn !== undefined ? { basedOn: input.basedOn } : {};
    if (input.revision !== undefined) {
      const details = await this.gateway.activate(
        this.actor(context),
        reference,
        input.revision,
        basedOn,
      );
      return { ...details, skipped: [] };
    }
    if (input.directory === undefined)
      throw new Error(
        "Name a directory to publish, or a revision to make live again.",
      );
    const snapshot = await this.upload(context, input.directory, {
      dockerignore: false,
    });
    const details = await this.gateway.publish(this.actor(context), reference, {
      files: snapshot.files.map(
        ({ absolutePath: _absolutePath, ...file }) => file,
      ),
      ...basedOn,
    });
    return { ...details, skipped: snapshot.skipped };
  }

  // ===========================================
  // Dynamic artifacts
  // ===========================================

  /** Upload a build context and start building its Dockerfile. */
  async build(
    context: WorkbenchContext,
    reference: string,
    input: {
      context: string;
      dockerfile?: string;
      buildArgs?: Record<string, string>;
    },
  ): Promise<ArtifactBuild & UploadNote> {
    const dockerfile = input.dockerfile ?? "Dockerfile";
    const snapshot = await this.upload(context, input.context, {
      dockerignore: true,
      alwaysInclude: [dockerfile, ".dockerignore"],
    });
    const build = await this.gateway.build(this.actor(context), reference, {
      files: snapshot.files.map(
        ({ absolutePath: _absolutePath, ...file }) => file,
      ),
      dockerfile,
      buildArgs: input.buildArgs ?? {},
    });
    return { ...build, skipped: snapshot.skipped };
  }

  /** Read a build, optionally waiting for it to finish; waiting ends early when aborted. */
  async waitForBuild(
    context: WorkbenchContext,
    reference: string,
    number: number,
    waitSeconds: number,
    signal?: AbortSignal,
  ): Promise<ArtifactBuildDetails> {
    const deadline =
      Date.now() + Math.min(waitSeconds, maximumBuildWaitSeconds) * 1000;
    let build = await this.gateway.getBuild(context.ownerId, reference, number);
    while (
      (build.status === "queued" || build.status === "running") &&
      Date.now() < deadline &&
      !signal?.aborted
    ) {
      await sleep(
        buildPollSeconds * 1000,
        undefined,
        signal ? { signal } : {},
      ).catch(() => {});
      build = await this.gateway.getBuild(context.ownerId, reference, number);
    }
    return build;
  }

  /**
   * Deploy a build as the next release. Named credentials are resolved among the owner's own
   * generic credentials and sent as grants; values never appear in the result. The app and its
   * credential generation are read once, before the grants are authorized, and pinned for the whole
   * operation: a refusal because apps hold another value of a credential is retried once after
   * alignment with fresh values of the same credentials, but never with fresh authority, so a
   * removal at any point after that read refuses the deployment.
   */
  async deploy(
    context: WorkbenchContext,
    reference: string,
    { credentials, ...input }: WorkbenchDeployInput,
  ): Promise<ArtifactDetails> {
    const actor = this.actor(context);
    if (!credentials?.length)
      return this.named(
        await this.gateway.deploy(actor, reference, {
          ...input,
          ...(credentials ? { credentials: [] } : {}),
        }),
      );
    const app = await this.gateway.get(context.ownerId, reference);
    let granted: string[] | undefined;
    const attempt = async () => {
      const grants = await this.credentials.resolve(
        context.ownerId,
        credentials,
        granted,
      );
      granted = grants.map((grant) => grant.credentialId);
      return this.gateway.deploy(actor, app.id, {
        ...input,
        credentials: grants,
        credentialGeneration: app.credentialGeneration,
      });
    };
    try {
      return this.named(await attempt());
    } catch (error) {
      if (!needsAlignment(error) || !granted) throw error;
      await this.credentials.align(granted);
      return this.named(await attempt());
    }
  }

  /** Stop a published app while retaining its release and data. */
  async stop(
    context: WorkbenchContext,
    reference: string,
  ): Promise<ArtifactDetails> {
    return this.named(await this.gateway.stop(this.actor(context), reference));
  }

  /** The generic credentials the teammate's owner can attach, and where their apps use them. */
  listCredentials(
    context: WorkbenchContext,
  ): Promise<CredentialCatalogEntry[]> {
    return this.credentials.catalog(context.ownerId);
  }

  /** Read a dynamic artifact's output. */
  logs(
    context: WorkbenchContext,
    reference: string,
    choice: LogChoice,
  ): Promise<ArtifactLogs> {
    return this.gateway.logs(context.ownerId, reference, choice);
  }

  // ===========================================
  // Uploads
  // ===========================================

  /** Snapshot a workspace directory without its private state, and upload content the service lacks. */
  private upload(
    context: WorkbenchContext,
    directory: string,
    options: { dockerignore: boolean; alwaysInclude?: readonly string[] },
  ): Promise<Snapshot> {
    return inWorkspace(context, async () => {
      const root = await this.directory(context, directory, true);
      const snapshot = await snapshotDirectory(root, {
        ...options,
        exclude: [context.privateDirectory],
      });
      const missing = new Set(
        await this.gateway.missingContent(
          snapshot.files.map((file) => file.sha256),
        ),
      );
      const pending = snapshot.files.filter((file) => {
        if (!missing.has(file.sha256)) return false;
        missing.delete(file.sha256);
        return true;
      });
      for (let index = 0; index < pending.length; index += uploadConcurrency)
        await Promise.all(
          pending
            .slice(index, index + uploadConcurrency)
            .map(async (file) =>
              this.gateway.uploadContent(
                file.sha256,
                await openAsBlob(file.absolutePath),
              ),
            ),
        );
      return snapshot;
    });
  }

  /**
   * Resolve a directory the teammate named, relative to its workspace or under `/workspace`,
   * refusing its private state.
   */
  private directory(
    context: WorkbenchContext,
    directory: string,
    mustExist: boolean,
  ): Promise<string> {
    return inWorkspace(context, () =>
      workspaceDirectory(context, directory, { mustExist }),
    );
  }

  /** Fill in the current names of an artifact's credentials. */
  private async named<T extends ArtifactSummary>(artifact: T): Promise<T> {
    return {
      ...artifact,
      credentials: await this.credentials.named(artifact.credentials ?? []),
    };
  }

  /** The teammate acting on the owner's artifacts. */
  private actor(context: WorkbenchContext): ArtifactActor {
    return { ownerId: context.ownerId, author: context.author };
  }
}
