import {
  artifactLimits,
  formatByteLimit,
  type ArtifactFile,
} from "@everything/artifact-contracts";
import {
  InvalidFilesError,
  MissingContentError,
} from "../error/content-errors.js";

/** A validated file list, sorted by path, with its combined size. */
export interface Manifest {
  readonly files: readonly ArtifactFile[];
  readonly totalSize: number;
}

/** Path segments that would leave or alias a directory. */
const forbiddenSegments = new Set(["", ".", ".."]);

/** Explain why a path is not a plain relative path, or return undefined when it is. */
export function pathProblem(path: string): string | undefined {
  if (!path) return "File paths cannot be empty.";
  if (path.length > artifactLimits.pathLength)
    return `File paths can be at most ${artifactLimits.pathLength} characters.`;
  if (path.includes("\\") || path.includes("\0"))
    return `"${path}" contains a backslash or NUL character.`;
  if (path.split("/").some((segment) => forbiddenSegments.has(segment)))
    return `"${path}" must be relative, without empty, "." or ".." segments.`;
  return undefined;
}

/**
 * Validate a file list: relative paths, no duplicates, and the count and size limits. The total
 * counts every path, so content shared by several paths counts once for each.
 */
export function validateManifest(files: readonly ArtifactFile[]): Manifest {
  if (!files.length) throw new InvalidFilesError("Add at least one file.");
  if (files.length > artifactLimits.fileCount)
    throw new InvalidFilesError(
      `A revision or build can have at most ${artifactLimits.fileCount} files.`,
    );
  const paths = new Set<string>();
  let totalSize = 0;
  for (const file of files) {
    const problem = pathProblem(file.path);
    if (problem) throw new InvalidFilesError(problem);
    if (paths.has(file.path))
      throw new InvalidFilesError(`"${file.path}" is listed more than once.`);
    paths.add(file.path);
    if (file.size > artifactLimits.fileSize)
      throw new InvalidFilesError(
        `"${file.path}" is larger than ${formatByteLimit(artifactLimits.fileSize)}.`,
      );
    totalSize += file.size;
  }
  if (totalSize > artifactLimits.totalSize)
    throw new InvalidFilesError(
      `Files can total at most ${formatByteLimit(artifactLimits.totalSize)}.`,
    );
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return {
    files: sorted.map(({ path, sha256, size, executable }) => ({
      path,
      sha256,
      size,
      executable,
    })),
    totalSize,
  };
}

/** A number of bytes, such as `1 byte` or `20 bytes`. */
function byteCount(count: number): string {
  return `${count} ${count === 1 ? "byte" : "bytes"}`;
}

/**
 * Require each listed file's content to be stored at its listed size, so the limits count the bytes
 * that are served and built rather than the sizes the caller listed.
 */
export function requireStoredContent(
  manifest: Manifest,
  stored: ReadonlyMap<string, number>,
): void {
  const missing = new Set(
    manifest.files
      .filter((file) => !stored.has(file.sha256))
      .map((file) => file.sha256),
  );
  if (missing.size) throw new MissingContentError(missing.size);
  const mismatched = manifest.files.find(
    (file) => stored.get(file.sha256) !== file.size,
  );
  if (mismatched)
    throw new InvalidFilesError(
      `"${mismatched.path}" is listed as ${byteCount(mismatched.size)}, but its uploaded content is ${byteCount(stored.get(mismatched.sha256)!)}.`,
    );
}
