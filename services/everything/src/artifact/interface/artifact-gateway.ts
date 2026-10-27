import type { Readable } from "node:stream";
import type {
  ActivateRevisionInput,
  ArtifactApiKey,
  ArtifactAuthor,
  ArtifactBuild,
  ArtifactBuildDetails,
  ArtifactDetails,
  ArtifactLogs,
  ArtifactSource,
  ArtifactSummary,
  ArtifactView,
  ArtifactViewInput,
  ArtifactViewPassInput,
  ArtifactVisibilityInput,
  CreateArtifactInput,
  DeployInput,
  PublishRevisionInput,
  StartBuildInput,
  UpdateArtifactInput,
} from "@everything/artifact-contracts";

/** The owner whose apps are changed, and the teammate or user making the change. */
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

/**
 * How a teammate opens one artifact from its pod, as the user sees it: with a short-lived pass on the
 * artifact host for a private app, or on the public apps host, without a pass, for a public app.
 */
export type TeammateArtifactView = TeammatePassView | TeammatePublicView;

/**
 * A teammate's short-lived pass to one private artifact, with links on the artifact host as teammate
 * pods reach it inside the cluster.
 */
export interface TeammatePassView {
  readonly visibility: "private";
  /** The requested page, for clients that send the token, such as curl. */
  readonly url: string;
  /** Stores the pass in a browser cookie, then opens `url`; it works until the pass expires. */
  readonly browserUrl: string;
  /** Secret to send as `Authorization: Bearer`; it opens only this artifact. */
  readonly token: string;
  readonly expiresAt: string;
}

/** A public artifact's page on the public apps host, as teammate pods reach it; anyone can open it. */
export interface TeammatePublicView {
  readonly visibility: "public";
  /** The requested page, for curl and Chromium alike. */
  readonly url: string;
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
  /** Delete an app and its data, optionally requiring it to remain stopped. */
  delete(
    actor: ArtifactActor,
    reference: string,
    requireStopped?: boolean,
  ): Promise<void>;
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
  /** Resume an app's saved release and runtime settings. */
  start(actor: ArtifactActor, reference: string): Promise<ArtifactDetails>;
  /** Stop a published app while preserving its release and data. */
  stop(actor: ArtifactActor, reference: string): Promise<ArtifactDetails>;
  /** Read recent output of a dynamic artifact's app. */
  logs(
    ownerId: string,
    reference: string,
    choice: LogChoice,
  ): Promise<ArtifactLogs>;
  /** Issue a link that signs the owner in to the artifact host and opens the artifact. */
  view(ownerId: string, input: ArtifactViewInput): Promise<ArtifactView>;
  /** Read the current API key of the owner's dynamic app. */
  apiKey(ownerId: string, reference: string): Promise<ArtifactApiKey>;
  /** Issue a short-lived pass with which a teammate views one artifact from its pod. */
  viewPass(
    ownerId: string,
    reference: string,
    input: ArtifactViewPassInput,
  ): Promise<TeammateArtifactView>;
}

/**
 * The owner's change of who can open an app. It is kept apart from ArtifactGateway, which teammate
 * tools use, so only the owner's own browser requests can reach it.
 */
export interface ArtifactVisibilityGateway {
  /** Make the owner's app private or public, as the owner. */
  setVisibility(
    actor: ArtifactActor,
    reference: string,
    input: ArtifactVisibilityInput,
  ): Promise<ArtifactDetails>;
}
