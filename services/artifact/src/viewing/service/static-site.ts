import type { ArtifactFile } from "@everything/artifact-contracts";
import type { Artifact } from "../../artifact/model/artifact.js";
import type { RevisionRepository } from "../../revision/interface/revision-repository.js";

/** What to send for a request to a static artifact. */
export type StaticResolution =
  | {
      readonly kind: "file";
      readonly file: ArtifactFile;
      readonly status: 200 | 404;
    }
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "missing" };

/** Number of revision file indexes kept in memory. */
const cachedRevisions = 32;

/** Maps request paths to the files of a static artifact's live revision. */
export class StaticSite {
  // ===========================================
  // State
  // ===========================================

  /** File indexes by artifact and revision, oldest first so the oldest is evicted. */
  private readonly indexes = new Map<
    string,
    ReadonlyMap<string, ArtifactFile>
  >();

  // ===========================================
  // Construction
  // ===========================================

  /** Read revisions through the repository. */
  constructor(
    private readonly revisions: Pick<RevisionRepository, "findByNumber">,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /**
   * Resolve a decoded path inside the artifact. Directories serve their `index.html`, a directory
   * requested without its trailing slash is redirected so relative links work, and a missing file
   * serves the artifact's `404.html` when it has one.
   */
  async resolve(artifact: Artifact, path: string): Promise<StaticResolution> {
    if (artifact.liveRevision === null) return { kind: "missing" };
    const files = await this.index(artifact, artifact.liveRevision);
    const relative = path.replace(/^\/+/, "");
    if (
      relative.split("/").some((segment) => segment === "." || segment === "..")
    )
      return { kind: "missing" };
    const requested =
      !relative || relative.endsWith("/") ? `${relative}index.html` : relative;
    const file = files.get(requested);
    if (file) return { kind: "file", file, status: 200 };
    if (files.has(`${relative}/index.html`))
      return { kind: "redirect", location: `/${artifact.slug}/${relative}/` };
    const notFound = files.get("404.html");
    return notFound
      ? { kind: "file", file: notFound, status: 404 }
      : { kind: "missing" };
  }

  // ===========================================
  // Revision indexes
  // ===========================================

  /** Index a revision's files by path, keeping recently used revisions in memory. */
  private async index(
    artifact: Artifact,
    revision: number,
  ): Promise<ReadonlyMap<string, ArtifactFile>> {
    const key = `${artifact.id}:${revision}`;
    const cached = this.indexes.get(key);
    if (cached) {
      this.indexes.delete(key);
      this.indexes.set(key, cached);
      return cached;
    }
    const found = await this.revisions.findByNumber(
      { ownerId: artifact.ownerId, artifactId: artifact.id },
      revision,
    );
    const index = new Map(
      (found?.files ?? []).map((file) => [file.path, file]),
    );
    this.indexes.set(key, index);
    if (this.indexes.size > cachedRevisions)
      this.indexes.delete(this.indexes.keys().next().value!);
    return index;
  }
}
