import type {
  ArtifactAuthor,
  ArtifactDetails,
  ArtifactSource,
  ArtifactSummary,
  CreateArtifactInput,
  UpdateArtifactInput,
} from "@everything/artifact-contracts";
import { BuildNotFoundError } from "../../image/error/build-errors.js";
import type { BuildRepository } from "../../image/interface/build-repository.js";
import type { BuildService } from "../../image/service/build-service.js";
import type { DeploymentRepository } from "../../deployment/interface/deployment-repository.js";
import type { WorkloadOrchestrator } from "../../deployment/interface/workload-orchestrator.js";
import type { WorkloadReconciler } from "../../deployment/service/workload-reconciler.js";
import { RevisionNotFoundError } from "../../revision/error/revision-errors.js";
import type { RevisionRepository } from "../../revision/interface/revision-repository.js";
import {
  AppMustBeStoppedError,
  SourceNotFoundError,
} from "../error/artifact-errors.js";
import type { ArtifactRepository } from "../interface/artifact-repository.js";
import type { Artifact } from "../model/artifact.js";
import {
  representDetails,
  representSummary,
  type HostOrigins,
} from "../presenter/artifact-presenter.js";
import type { ArtifactLock } from "./artifact-lock.js";
import type { ArtifactLookup } from "./artifact-lookup.js";

/** Number of revisions and builds shown with an artifact's details. */
const recentHistory = 10;

/** Which source to check out: a revision, a build, or by default the live release. */
export interface SourceChoice {
  readonly revision?: number;
  readonly build?: number;
}

/** Owns artifact records and assembles what callers see of them. */
export class ArtifactService {
  // ===========================================
  // Construction
  // ===========================================

  /** Inject artifact storage, history, runtime, cleanup, and the artifact host's origin. */
  constructor(
    private readonly artifacts: ArtifactRepository,
    private readonly revisions: Pick<
      RevisionRepository,
      "history" | "findByNumber"
    >,
    private readonly builds: Pick<
      BuildRepository,
      "history" | "findByNumber" | "latestNumber"
    >,
    private readonly deployments: Pick<DeploymentRepository, "findByRelease">,
    private readonly orchestrator: Pick<WorkloadOrchestrator, "runtimes">,
    private readonly cleanup: {
      readonly builds: Pick<BuildService, "cancel">;
      readonly workloads: Pick<WorkloadReconciler, "remove">;
    },
    private readonly lookup: ArtifactLookup,
    private readonly lock: ArtifactLock,
    private readonly origins: HostOrigins,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** List the owner's artifacts with capability flags from their current deployments, including stopped apps. */
  async list(ownerId: string): Promise<ArtifactSummary[]> {
    const [artifacts, runtimes] = await Promise.all([
      this.artifacts.list({ ownerId }),
      this.orchestrator.runtimes(),
    ]);
    return Promise.all(
      artifacts.map(async (artifact) =>
        representSummary(
          artifact,
          runtimes.get(artifact.id),
          this.origins,
          artifact.liveDeployment === null
            ? undefined
            : await this.deployments.findByRelease(
                { ownerId, artifactId: artifact.id },
                artifact.liveDeployment,
              ),
        ),
      ),
    );
  }

  /** Create an unpublished artifact; its slug and kind never change. */
  async create(
    ownerId: string,
    actor: ArtifactAuthor,
    input: CreateArtifactInput,
  ): Promise<ArtifactDetails> {
    return this.present(await this.artifacts.create({ ownerId }, input, actor));
  }

  /** Describe one artifact with its recent history and runtime. */
  async details(ownerId: string, reference: string): Promise<ArtifactDetails> {
    return this.present(await this.lookup.resolve(ownerId, reference));
  }

  /** Change descriptive fields. */
  async update(
    ownerId: string,
    actor: ArtifactAuthor,
    reference: string,
    input: UpdateArtifactInput,
  ): Promise<ArtifactDetails> {
    const { id } = await this.lookup.resolve(ownerId, reference);
    const updated = await this.lock.run(id, () =>
      this.artifacts.update({ ownerId }, id, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        updatedBy: actor,
      }),
    );
    return this.present(updated ?? (await this.lookup.resolve(ownerId, id)));
  }

  /** Delete the app and its data; manual deletion requires it to remain stopped under the lock. */
  async delete(
    ownerId: string,
    reference: string,
    requireStopped = false,
  ): Promise<void> {
    const { id } = await this.lookup.resolve(ownerId, reference);
    await this.lock.run(id, async () => {
      const artifact = await this.lookup.resolve(ownerId, id);
      if (requireStopped && artifact.running) throw new AppMustBeStoppedError();
      await this.cleanup.builds.cancel(ownerId, id);
      await this.cleanup.workloads.remove(artifact);
      await this.artifacts.delete({ ownerId }, id);
    });
  }

  /** Return the files of a revision or build; by default, of the live release or newest build. */
  async source(
    ownerId: string,
    reference: string,
    choice: SourceChoice,
  ): Promise<ArtifactSource> {
    const artifact = await this.lookup.resolve(ownerId, reference);
    const scope = { ownerId, artifactId: artifact.id };
    if (choice.revision !== undefined) {
      const revision = await this.revisions.findByNumber(
        scope,
        choice.revision,
      );
      if (!revision) throw new RevisionNotFoundError(choice.revision);
      return {
        origin: "revision",
        number: revision.number,
        release: artifact.release,
        files: revision.files,
      };
    }
    let buildNumber = choice.build;
    if (buildNumber === undefined && artifact.kind === "static") {
      if (artifact.liveRevision === null) throw new SourceNotFoundError();
      return this.source(ownerId, artifact.id, {
        revision: artifact.liveRevision,
      });
    }
    if (buildNumber === undefined) {
      const live =
        artifact.liveDeployment === null
          ? undefined
          : await this.deployments.findByRelease(
              scope,
              artifact.liveDeployment,
            );
      buildNumber = live?.build ?? (await this.builds.latestNumber(scope));
      if (!buildNumber) throw new SourceNotFoundError();
    }
    const build = await this.builds.findByNumber(scope, buildNumber);
    if (!build) throw new BuildNotFoundError(buildNumber);
    return {
      origin: "build",
      number: build.number,
      release: artifact.release,
      files: build.files,
    };
  }

  // ===========================================
  // Presentation
  // ===========================================

  /** Load history and runtime for the artifact's details. */
  private async present(artifact: Artifact): Promise<ArtifactDetails> {
    const scope = { ownerId: artifact.ownerId, artifactId: artifact.id };
    const [revisions, builds, deployment, runtimes] = await Promise.all([
      artifact.kind === "static"
        ? this.revisions.history(scope, recentHistory)
        : [],
      artifact.kind === "dynamic"
        ? this.builds.history(scope, recentHistory)
        : [],
      artifact.liveDeployment === null
        ? undefined
        : this.deployments.findByRelease(scope, artifact.liveDeployment),
      artifact.kind === "dynamic" ? this.orchestrator.runtimes() : new Map(),
    ]);
    return representDetails(
      artifact,
      { revisions, builds, deployment },
      runtimes.get(artifact.id),
      this.origins,
    );
  }
}
