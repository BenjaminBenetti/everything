import { createHash, randomBytes } from "node:crypto";
import type {
  ArtifactAuthor,
  ArtifactBuild,
  ArtifactBuildDetails,
  ArtifactFile,
  StartBuildInput,
} from "@everything/artifact-contracts";
import type { ArtifactLock } from "../../artifact/service/artifact-lock.js";
import type { ArtifactLookup } from "../../artifact/service/artifact-lookup.js";
import { MissingContentError } from "../../content/error/content-errors.js";
import type { ContentStore } from "../../content/interface/content-store.js";
import { pathProblem, validateManifest } from "../../content/model/manifest.js";
import { InvalidFilesError } from "../../content/error/content-errors.js";
import {
  imageRepository,
  imageTag,
} from "../../cluster/model/cluster-names.js";
import {
  BuildNotFoundError,
  DockerfileMissingError,
} from "../error/build-errors.js";
import type { BuildRepository } from "../interface/build-repository.js";
import type { BuildRunner } from "../interface/build-runner.js";
import type { ImageRegistry } from "../interface/image-registry.js";
import type { DeploymentRepository } from "../../deployment/interface/deployment-repository.js";
import { buildLogLimit, buildRetention, type Build } from "../model/build.js";

/** Addresses build jobs use. */
export interface BuildAddresses {
  /** Base URL of this service's internal API, as reached from build pods. */
  readonly sourceUrl: string;
  /** Registry host and port build jobs push to. */
  readonly pushHost: string;
}

/** Seconds after which a build whose job cannot be found is considered lost. */
const lostAfterMs = 60_000;

/** Hash a source token for storage and lookup. */
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Present a build with its author and without internal fields. */
function representBuild(build: Build): ArtifactBuild {
  return {
    number: build.number,
    createdAt: build.createdAt,
    author: build.author,
    status: build.status,
    dockerfile: build.dockerfile,
    fileCount: build.fileCount,
    totalSize: build.totalSize,
    imageDigest: build.imageDigest,
    error: build.error,
    finishedAt: build.finishedAt,
  };
}

/** Starts image builds of dynamic artifacts and follows them to completion. */
export class BuildService {
  // ===========================================
  // Construction
  // ===========================================

  /** Inject storage, content, the job runner, the registry, and the per-artifact lock. */
  constructor(
    private readonly builds: BuildRepository,
    private readonly deployments: Pick<DeploymentRepository, "findByRelease">,
    private readonly content: Pick<ContentStore, "missing">,
    private readonly runner: BuildRunner,
    private readonly registry: ImageRegistry,
    private readonly lookup: ArtifactLookup,
    private readonly lock: ArtifactLock,
    private readonly addresses: BuildAddresses,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Record a build of uploaded source and start its job; the build runs in the background. */
  async start(
    ownerId: string,
    actor: ArtifactAuthor,
    reference: string,
    input: StartBuildInput,
  ): Promise<ArtifactBuild> {
    const { id } = await this.lookup.resolveKind(ownerId, reference, "dynamic");
    const problem = pathProblem(input.dockerfile);
    if (problem) throw new InvalidFilesError(problem);
    const manifest = validateManifest(input.files);
    if (!manifest.files.some((file) => file.path === input.dockerfile))
      throw new DockerfileMissingError(input.dockerfile);
    const missing = await this.content.missing(
      manifest.files.map((file) => file.sha256),
    );
    if (missing.length) throw new MissingContentError(missing.length);
    const build = await this.lock.run(id, async () => {
      const artifact = await this.lookup.resolveKind(ownerId, id, "dynamic");
      const scope = { ownerId, artifactId: artifact.id };
      const token = randomBytes(32).toString("base64url");
      const created = await this.builds.create(scope, {
        number: (await this.builds.latestNumber(scope)) + 1,
        author: actor,
        dockerfile: input.dockerfile,
        buildArgs: input.buildArgs,
        files: manifest.files,
        totalSize: manifest.totalSize,
        sourceTokenHash: tokenHash(token),
      });
      const live =
        artifact.liveDeployment === null
          ? undefined
          : await this.deployments.findByRelease(
              scope,
              artifact.liveDeployment,
            );
      await this.builds.prune(scope, buildRetention, live?.build ?? null);
      return { created, token };
    });
    try {
      await this.runner.start({
        buildId: build.created.id,
        artifactId: id,
        dockerfile: input.dockerfile,
        buildArgs: input.buildArgs,
        sourceUrl: `${this.addresses.sourceUrl}/internal/v1/build-sources/${build.created.id}?token=${build.token}`,
        image: `${this.addresses.pushHost}/${imageRepository(id)}:${imageTag(build.created.number)}`,
      });
    } catch (error) {
      await this.fail(build.created, "The build could not be started.", "");
      throw error;
    }
    return representBuild(build.created);
  }

  /** Report a build with the end of its log, read live while it runs. */
  async get(
    ownerId: string,
    reference: string,
    number: number,
  ): Promise<ArtifactBuildDetails> {
    const artifact = await this.lookup.resolveKind(
      ownerId,
      reference,
      "dynamic",
    );
    const build = await this.builds.findByNumber(
      { ownerId, artifactId: artifact.id },
      number,
    );
    if (!build) throw new BuildNotFoundError(number);
    const log =
      build.log ??
      (await this.runner.log(build.id, buildLogLimit).catch(() => ""));
    return { ...representBuild(build), log };
  }

  /** Return an unfinished build's files to the job presenting its source token. */
  async source(
    buildId: string,
    token: string,
  ): Promise<readonly ArtifactFile[] | undefined> {
    const build = await this.builds.getById(
      { sourceTokenHash: tokenHash(token) },
      buildId,
    );
    return build && build.status !== "succeeded" && build.status !== "failed"
      ? build.files
      : undefined;
  }

  /** Bring every unfinished build up to date with its job; one failure does not stop the rest. */
  async monitor(): Promise<void> {
    for (const build of await this.builds.list({ active: true }))
      await this.follow(build).catch((error: unknown) =>
        console.error("Build monitoring failed", {
          build: build.id,
          name: (error as Error).name,
        }),
      );
  }

  /** Remove the jobs of an artifact's unfinished builds before the artifact is deleted. */
  async cancel(ownerId: string, artifactId: string): Promise<void> {
    for (const build of await this.builds.list({ active: true }))
      if (build.ownerId === ownerId && build.artifactId === artifactId)
        await this.runner.remove(build.id);
  }

  // ===========================================
  // Monitoring
  // ===========================================

  /** Move one build forward according to its job's phase. */
  private async follow(build: Build): Promise<void> {
    const progress = await this.runner.progress(build.id);
    switch (progress.phase) {
      case "pending":
        return;
      case "running":
        if (build.status === "queued")
          await this.builds.record({ active: true }, build.id, {
            status: "running",
          });
        return;
      case "succeeded": {
        const log = await this.runner.log(build.id, buildLogLimit);
        try {
          const digest = await this.registry.digest(
            imageRepository(build.artifactId),
            imageTag(build.number),
          );
          await this.builds.record({ active: true }, build.id, {
            status: "succeeded",
            imageDigest: digest,
            log,
            finishedAt: new Date().toISOString(),
          });
          await this.runner.remove(build.id);
        } catch {
          await this.fail(
            build,
            "The image was built but could not be found in the registry.",
            log,
          );
        }
        return;
      }
      case "failed":
        await this.fail(
          build,
          progress.reason,
          await this.runner.log(build.id, buildLogLimit),
        );
        return;
      case "missing":
        if (Date.now() - Date.parse(build.createdAt) > lostAfterMs)
          await this.fail(
            build,
            "The build job disappeared before it finished.",
            "",
          );
        return;
    }
  }

  /** Record a failed build with its log and remove its job. */
  private async fail(
    build: Build,
    error: string | null,
    log: string,
  ): Promise<void> {
    await this.builds.record({ active: true }, build.id, {
      status: "failed",
      error,
      log,
      finishedAt: new Date().toISOString(),
    });
    await this.runner.remove(build.id);
  }
}
