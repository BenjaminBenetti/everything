/** The registry that build jobs push to. */
export interface ImageRegistry {
  /** Return the content digest of a pushed image, such as `sha256:...`. */
  digest(repository: string, tag: string): Promise<string>;
}
