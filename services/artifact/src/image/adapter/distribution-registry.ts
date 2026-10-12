import type { ImageRegistry } from "../interface/image-registry.js";

/** Connection to the registry's HTTP API, which requires a password. */
export interface RegistrySettings {
  /** Registry API base URL inside the cluster, such as `http://registry:5000`. */
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

/** Manifest formats BuildKit may push, so the registry reports the digest of the stored form. */
const manifestTypes = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** A content digest. */
const digestPattern = /^sha256:[0-9a-f]{64}$/;

/** Reads image digests from a CNCF Distribution registry. */
export class DistributionRegistry implements ImageRegistry {
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the registry's address and credentials. */
  constructor(
    private readonly settings: RegistrySettings,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Ask for the manifest's headers and return its content digest. */
  async digest(repository: string, tag: string): Promise<string> {
    const credential = Buffer.from(
      `${this.settings.username}:${this.settings.password}`,
    ).toString("base64");
    const response = await this.fetcher(
      `${this.settings.url}/v2/${repository}/manifests/${encodeURIComponent(tag)}`,
      {
        method: "HEAD",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: manifestTypes,
          Authorization: `Basic ${credential}`,
        },
      },
    );
    if (!response.ok)
      throw new Error(
        `The registry has no image ${repository}:${tag} (${response.status})`,
      );
    const digest = response.headers.get("docker-content-digest");
    if (!digest || !digestPattern.test(digest))
      throw new Error("The registry did not report the image digest");
    return digest;
  }
}
