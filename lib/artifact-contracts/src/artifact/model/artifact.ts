/** How an artifact is served; chosen when it is created and never changed. */
export type ArtifactKind = "static" | "dynamic";

/** Every artifact kind, for validation schemas. */
export const artifactKinds = [
  "static",
  "dynamic",
] as const satisfies readonly ArtifactKind[];

/** Limits shared by the artifact service, its API clients, and the teammate tools. */
export const artifactLimits = {
  slugLength: 63,
  titleLength: 120,
  descriptionLength: 2000,
  /** Maximum length of one file path inside a revision or build source. */
  pathLength: 1024,
  /** Maximum number of files in one revision or build source. */
  fileCount: 5000,
  /** Maximum size of one file, in bytes. */
  fileSize: 25 * 1024 * 1024,
  /** Maximum combined size of one revision or build source, in bytes. */
  totalSize: 200 * 1024 * 1024,
  buildArgCount: 32,
  envCount: 64,
  envValueLength: 4096,
  /** Largest disk a dynamic artifact can request, in GiB. */
  diskGi: 50,
  /** Longest path, with its query, that a view link or teammate pass may open inside an artifact. */
  viewPathLength: 2048,
} as const;

/** Lowercase letters, digits, and inner hyphens; slugs name an artifact's link. */
export const artifactSlugPattern = "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$";

/** A lowercase hexadecimal SHA-256 digest identifying file content. */
export const contentHashPattern = "^[0-9a-f]{64}$";

/** Environment variable names a dynamic artifact may set. */
export const environmentNamePattern = "^[A-Za-z_][A-Za-z0-9_]*$";

/** Variables the artifact service sets itself; a deployment cannot override them. */
export const reservedEnvironmentNames = [
  "PORT",
  "BASE_PATH",
  "DATABASE_URL",
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "EVERYTHING_API_URL",
  "EVERYTHING_CLIENT_ID",
  "EVERYTHING_CLIENT_SECRET",
  "EVERYTHING_TOKEN_URL",
  "APP_API_KEY",
] as const;

/** Services a dynamic app can request for its backend. */
export const artifactCapabilities = ["everything-api", "api-key"] as const;

/** A provisioned service capability available to a dynamic app. */
export type ArtifactCapability = (typeof artifactCapabilities)[number];

/**
 * Who can open an app: privately, only its owner and their teammates; publicly, anyone with its
 * link, without signing in. Every app starts private, and only its owner changes this, from Apps.
 */
export const artifactVisibilities = ["private", "public"] as const;

/** Who can open an app. */
export type ArtifactVisibility = (typeof artifactVisibilities)[number];

/** The teammate or user that made a change; the name is recorded as it was at the time. */
export interface ArtifactAuthor {
  readonly id: string;
  readonly name: string;
}

/** One file of a revision or build source, identified by the hash of its content. */
export interface ArtifactFile {
  /** Relative path using forward slashes, such as `assets/app.js`. */
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly executable: boolean;
}

/** A published snapshot of a static artifact's files. */
export interface ArtifactRevision {
  readonly number: number;
  readonly createdAt: string;
  readonly author: ArtifactAuthor;
  readonly fileCount: number;
  readonly totalSize: number;
}

/** Progress of one image build. */
export type ArtifactBuildStatus = "queued" | "running" | "succeeded" | "failed";

/** One image build of a dynamic artifact. */
export interface ArtifactBuild {
  readonly number: number;
  readonly createdAt: string;
  readonly author: ArtifactAuthor;
  readonly status: ArtifactBuildStatus;
  readonly dockerfile: string;
  readonly fileCount: number;
  readonly totalSize: number;
  readonly imageDigest: string | null;
  readonly error: string | null;
  readonly finishedAt: string | null;
}

/** A build's details with the end of its log. */
export interface ArtifactBuildDetails extends ArtifactBuild {
  readonly log: string;
}

/** Runtime settings of a dynamic artifact's deployment. */
export interface ArtifactDeploymentSettings {
  /** Port the container listens on; also passed to it as `PORT`. */
  readonly port: number;
  readonly env: Readonly<Record<string, string>>;
  /** Whether the artifact gets its own PostgreSQL role and schema. */
  readonly database: boolean;
  /** Requested backend capabilities; credentials are never part of deployment history. */
  readonly capabilities: readonly ArtifactCapability[];
  /** Size of the disk mounted at `/data`, in GiB, or null for none. */
  readonly diskGi: number | null;
  /** Path checked for readiness, or null to check only that the port accepts connections. */
  readonly healthPath: string | null;
}

/** The build and settings a dynamic artifact runs. */
export interface ArtifactDeployment extends ArtifactDeploymentSettings {
  /** Release number this deployment created. */
  readonly release: number;
  readonly createdAt: string;
  readonly author: ArtifactAuthor;
  readonly build: number;
}

/** Observed state of a dynamic artifact's pod. */
export type ArtifactRuntimeState =
  "stopped" | "starting" | "running" | "failing";

/** Runtime status, derived from Kubernetes rather than stored. */
export interface ArtifactRuntime {
  readonly state: ArtifactRuntimeState;
  readonly restarts: number;
  /** Why the pod is not running, such as `CrashLoopBackOff`, or null. */
  readonly reason: string | null;
}

/**
 * What a viewer can see now: nothing published yet, live static files, or a dynamic artifact's
 * runtime state.
 */
export type ArtifactStatus = "unpublished" | "live" | ArtifactRuntimeState;

/** An artifact as listed for the user and for main agents. */
export interface ArtifactSummary {
  readonly id: string;
  readonly slug: string;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly description: string;
  /** Whether the current deployment is configured with a database, including while stopped. */
  readonly database: boolean;
  /** Capabilities enabled for the current deployment; empty before deployment and for static apps. */
  readonly capabilities: readonly ArtifactCapability[];
  /** Link that opens the app on the artifact host, where the owner and teammates sign in. */
  readonly url: string;
  /**
   * Stable, token-free link on the public apps origin. It opens the app for anyone only while the
   * app is public; while private it is not anonymously reachable. This is the link to share.
   */
  readonly publicUrl: string;
  /** Who can open the app; teammates can read it, and only the owner changes it, from Apps. */
  readonly visibility: ArtifactVisibility;
  readonly status: ArtifactStatus;
  /** Number of the live release; 0 before anything is published or deployed. */
  readonly release: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: ArtifactAuthor;
  readonly updatedBy: ArtifactAuthor;
}

/** An artifact with its recent history and live release. */
export interface ArtifactDetails extends ArtifactSummary {
  /** Live revision number of a static artifact, or null. */
  readonly liveRevision: number | null;
  /** Most recent revisions first. */
  readonly revisions: readonly ArtifactRevision[];
  /** Most recent builds first. */
  readonly builds: readonly ArtifactBuild[];
  /** Live deployment of a dynamic artifact, or null. */
  readonly deployment: ArtifactDeployment | null;
  /** Runtime of a dynamic artifact, or null for static artifacts. */
  readonly runtime: ArtifactRuntime | null;
}

/** Envelope returned by artifact listings. */
export interface ArtifactList {
  readonly artifacts: readonly ArtifactSummary[];
}

/** The files of one revision or build, for checking an artifact's source out. */
export interface ArtifactSource {
  readonly origin: "revision" | "build";
  readonly number: number;
  /** Release that was live when the source was read, to pass as `basedOn` when publishing again. */
  readonly release: number;
  readonly files: readonly ArtifactFile[];
}

/** A link that signs the viewer in to the artifact host and opens the artifact. */
export interface ArtifactView {
  readonly url: string;
}

/** A dynamic app's API key, revealed only to its owner and never included in listings. */
export interface ArtifactApiKey {
  readonly apiKey: string;
}

/** Input for creating an artifact; nothing is published until a revision or deployment exists. */
export interface CreateArtifactInput {
  readonly slug: string;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly description: string;
}

/** Partial changes to an artifact's descriptive fields. */
export interface UpdateArtifactInput {
  readonly title?: string;
  readonly description?: string;
}

/**
 * The owner's choice of who can open an app. It is a separate request from every create, edit, and
 * release, so no teammate change can carry it; Everything accepts it only from the signed-in owner.
 */
export interface ArtifactVisibilityInput {
  readonly visibility: ArtifactVisibility;
}

/** Publish uploaded files as a new revision of a static artifact. */
export interface PublishRevisionInput {
  readonly files: readonly ArtifactFile[];
  /** Release the change was based on; a newer live release is a conflict. */
  readonly basedOn?: number;
}

/** Make an earlier revision of a static artifact live again. */
export interface ActivateRevisionInput {
  readonly basedOn?: number;
}

/** Build an image of a dynamic artifact from uploaded files. */
export interface StartBuildInput {
  readonly files: readonly ArtifactFile[];
  /** Path of the Dockerfile inside the build source. */
  readonly dockerfile: string;
  readonly buildArgs: Readonly<Record<string, string>>;
}

/**
 * Make a build of a dynamic artifact live. Omitted settings keep the live deployment's values, or
 * the defaults for a first deployment: port 8080, no variables, no database, no disk, and no health
 * path. A null disk or health path removes it.
 */
export interface DeployInput {
  /** Build number to deploy; the latest successful build when omitted. */
  readonly build?: number;
  readonly port?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly database?: boolean;
  /** Omit to retain current capabilities; an empty list removes them. */
  readonly capabilities?: readonly ArtifactCapability[];
  readonly diskGi?: number | null;
  readonly healthPath?: string | null;
  readonly basedOn?: number;
}

/** Settings of a dynamic artifact's first deployment, where the request omits them. */
export const defaultDeploymentSettings: ArtifactDeploymentSettings = {
  port: 8080,
  env: {},
  database: false,
  capabilities: [],
  diskGi: null,
  healthPath: null,
};

/** Hashes of uploaded content the artifact service does not have yet. */
export interface MissingContent {
  readonly missing: readonly string[];
}

/** Recent output of a dynamic artifact's container. */
export interface ArtifactLogs {
  readonly text: string;
}

/** Request to open an artifact, optionally at a path inside it. */
export interface ArtifactViewInput {
  readonly slug: string;
  /** Path inside the artifact, starting with `/`; the artifact's root when omitted. */
  readonly path?: string;
}

/** Request for a teammate's pass to view one artifact. */
export interface ArtifactViewPassInput {
  /** Path inside the artifact, starting with `/`; the artifact's root when omitted. */
  readonly path?: string;
}

/**
 * How a teammate views one artifact from inside the cluster, as the user sees it: a pass for a
 * private artifact on the artifact host, or a public artifact's page on the public apps host, which
 * needs no pass. The caller knows how its teammates reach each host.
 */
export type ArtifactViewPass = PrivateArtifactViewPass | PublicArtifactView;

/** A short-lived pass with which a teammate views one private artifact on the artifact host. */
export interface PrivateArtifactViewPass {
  readonly visibility: "private";
  /** Secret to send as `Authorization: Bearer`; it opens only this artifact, until `expiresAt`. */
  readonly token: string;
  /** Path of the requested page on the artifact host, such as `/report/docs/`. */
  readonly path: string;
  /** Path on the artifact host that stores the pass in a browser cookie, then opens `path`. */
  readonly signInPath: string;
  readonly expiresAt: string;
}

/**
 * A public artifact's page, which anyone opens on the public apps host without a pass. The artifact
 * host never serves a public artifact, so no pass is issued for one.
 */
export interface PublicArtifactView {
  readonly visibility: "public";
  /** Path of the requested page on the public apps host, such as `/report/docs/`. */
  readonly path: string;
}

/** A failure body returned by the artifact service and the Everything API. */
export interface ArtifactFailure {
  readonly code: string;
  readonly message: string;
}
