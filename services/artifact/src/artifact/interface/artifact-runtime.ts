import type { Artifact } from "../model/artifact.js";

/** Apply an app's saved running state to its hosting runtime. */
export interface ArtifactRuntime {
  /** Reconcile a saved app; static apps need no container workload. */
  reconcile(artifact: Artifact): Promise<void>;
}
