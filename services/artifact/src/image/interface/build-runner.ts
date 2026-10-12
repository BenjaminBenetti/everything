/** What a build runner needs to build and push one image. */
export interface BuildJob {
  readonly buildId: string;
  readonly artifactId: string;
  /** Path of the Dockerfile inside the source. */
  readonly dockerfile: string;
  readonly buildArgs: Readonly<Record<string, string>>;
  /** URL from which the job downloads the source as a tar archive. */
  readonly sourceUrl: string;
  /** Image reference, with tag, to push. */
  readonly image: string;
}

/** Where a build stands, as reported by the runner. */
export type BuildPhase =
  "pending" | "running" | "succeeded" | "failed" | "missing";

/** A build's phase and, after a failure, why it failed. */
export interface BuildProgress {
  readonly phase: BuildPhase;
  readonly reason: string | null;
}

/** Runs image builds outside this process. */
export interface BuildRunner {
  /** Start building; the build continues after this returns. */
  start(job: BuildJob): Promise<void>;
  /** Report the build's current phase. */
  progress(buildId: string): Promise<BuildProgress>;
  /** Return up to `limit` bytes from the end of the build's output. */
  log(buildId: string, limit: number): Promise<string>;
  /** Remove the build's job; a missing job is ignored. */
  remove(buildId: string): Promise<void>;
}
