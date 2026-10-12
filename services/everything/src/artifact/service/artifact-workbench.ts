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
  DeployInput,
} from "@everything/artifact-contracts";
import type {
  ArtifactActor,
  ArtifactGateway,
  LogChoice,
} from "../interface/artifact-gateway.js";
import { checkoutFiles } from "./artifact-checkout.js";
import { workspaceDirectory } from "./workspace-path.js";
import { snapshotDirectory, type Snapshot } from "./workspace-snapshot.js";

/** The teammate using artifact tools: its owner, identity, and working directory. */
export interface WorkbenchContext {
  readonly ownerId: string;
  readonly author: ArtifactAuthor;
  readonly workspace: string;
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

  /** Use the artifact service through its gateway. */
  constructor(private readonly gateway: ArtifactGateway) {}

  // ===========================================
  // Records
  // ===========================================

  /** List every shared artifact. */
  list(context: WorkbenchContext): Promise<ArtifactSummary[]> {
    return this.gateway.list(context.ownerId);
  }

  /** Create an artifact on the teammate's behalf. */
  create(
    context: WorkbenchContext,
    input: {
      slug: string;
      kind: ArtifactKind;
      title: string;
      description?: string;
    },
  ): Promise<ArtifactDetails> {
    return this.gateway.create(this.actor(context), {
      slug: input.slug,
      kind: input.kind,
      title: input.title,
      description: input.description ?? "",
    });
  }

  /** Describe one artifact. */
  get(context: WorkbenchContext, reference: string): Promise<ArtifactDetails> {
    return this.gateway.get(context.ownerId, reference);
  }

  /** Change descriptive fields. */
  update(
    context: WorkbenchContext,
    reference: string,
    input: { title?: string; description?: string },
  ): Promise<ArtifactDetails> {
    return this.gateway.update(this.actor(context), reference, input);
  }

  /** Delete an artifact. */
  delete(context: WorkbenchContext, reference: string): Promise<void> {
    return this.gateway.delete(this.actor(context), reference);
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
    await checkoutFiles(
      target,
      source.files,
      (hash) => this.gateway.readContent(hash),
      input.overwrite ?? false,
    );
    return {
      directory: path.relative(context.workspace, target) || ".",
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

  /** Deploy a build as the next release. */
  deploy(
    context: WorkbenchContext,
    reference: string,
    input: DeployInput,
  ): Promise<ArtifactDetails> {
    return this.gateway.deploy(this.actor(context), reference, input);
  }

  /** Stop a dynamic artifact. */
  stop(context: WorkbenchContext, reference: string): Promise<ArtifactDetails> {
    return this.gateway.stop(this.actor(context), reference);
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

  /** Snapshot a workspace directory and upload content the artifact service does not have. */
  private async upload(
    context: WorkbenchContext,
    directory: string,
    options: { dockerignore: boolean; alwaysInclude?: readonly string[] },
  ): Promise<Snapshot> {
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
  }

  /** Resolve a directory inside the teammate's workspace. */
  private directory(
    context: WorkbenchContext,
    directory: string,
    mustExist: boolean,
  ): Promise<string> {
    return workspaceDirectory(context.workspace, directory, { mustExist });
  }

  /** The teammate acting on the owner's artifacts. */
  private actor(context: WorkbenchContext): ArtifactActor {
    return { ownerId: context.ownerId, author: context.author };
  }
}
