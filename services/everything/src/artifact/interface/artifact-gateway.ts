import type { Readable } from "node:stream";
import type {
  ActivateRevisionInput,
  ArtifactAuthor,
  ArtifactBuild,
  ArtifactBuildDetails,
  ArtifactDetails,
  ArtifactLogs,
  ArtifactSource,
  ArtifactSummary,
  ArtifactView,
  ArtifactViewInput,
  CreateArtifactInput,
  DeployInput,
  PublishRevisionInput,
  StartBuildInput,
  UpdateArtifactInput,
} from "@everything/artifact-contracts";

/** The user whose artifacts are changed, and the teammate making the change. */
export interface ArtifactActor {
  readonly ownerId: string;
  readonly author: ArtifactAuthor;
}

/** Which source to read: a revision, a build, or by default the live release. */
export interface SourceChoice {
  readonly revision?: number;
  readonly build?: number;
}

/** Which container output to read. */
export interface LogChoice {
  readonly previous: boolean;
  readonly lines: number;
}

/** The artifact service's internal API, as Everything uses it. */
export interface ArtifactGateway {
  /** List the owner's artifacts. */
  list(ownerId: string): Promise<ArtifactSummary[]>;
  /** Create an unpublished artifact. */
  create(
    actor: ArtifactActor,
    input: CreateArtifactInput,
  ): Promise<ArtifactDetails>;
  /** Describe one artifact by ID or slug. */
  get(ownerId: string, reference: string): Promise<ArtifactDetails>;
  /** Change an artifact's title or description. */
  update(
    actor: ArtifactActor,
    reference: string,
    input: UpdateArtifactInput,
  ): Promise<ArtifactDetails>;
  /** Delete an artifact and everything it owns. */
  delete(actor: ArtifactActor, reference: string): Promise<void>;
  /** Return the hashes, from those given, that the service does not store yet. */
  missingContent(hashes: readonly string[]): Promise<string[]>;
  /** Upload one file's content under its hash. */
  uploadContent(hash: string, content: Blob): Promise<void>;
  /** Download stored content. */
  readContent(hash: string): Promise<Readable>;
  /** List the files of a revision, a build, or the live release. */
  source(
    ownerId: string,
    reference: string,
    choice: SourceChoice,
  ): Promise<ArtifactSource>;
  /** Publish uploaded files as a static artifact's next revision. */
  publish(
    actor: ArtifactActor,
    reference: string,
    input: PublishRevisionInput,
  ): Promise<ArtifactDetails>;
  /** Make an earlier revision of a static artifact live again. */
  activate(
    actor: ArtifactActor,
    reference: string,
    revision: number,
    input: ActivateRevisionInput,
  ): Promise<ArtifactDetails>;
  /** Start building an image of a dynamic artifact from uploaded files. */
  build(
    actor: ArtifactActor,
    reference: string,
    input: StartBuildInput,
  ): Promise<ArtifactBuild>;
  /** Read a build's status and log. */
  getBuild(
    ownerId: string,
    reference: string,
    number: number,
  ): Promise<ArtifactBuildDetails>;
  /** Deploy a build of a dynamic artifact as its next release. */
  deploy(
    actor: ArtifactActor,
    reference: string,
    input: DeployInput,
  ): Promise<ArtifactDetails>;
  /** Stop a dynamic artifact's app. */
  stop(actor: ArtifactActor, reference: string): Promise<ArtifactDetails>;
  /** Read recent output of a dynamic artifact's app. */
  logs(
    ownerId: string,
    reference: string,
    choice: LogChoice,
  ): Promise<ArtifactLogs>;
  /** Issue a link that signs the owner in to the artifact host and opens the artifact. */
  view(ownerId: string, input: ArtifactViewInput): Promise<ArtifactView>;
}
