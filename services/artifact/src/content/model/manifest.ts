import {
  artifactLimits,
  type ArtifactFile,
} from "@everything/artifact-contracts";
import { InvalidFilesError } from "../error/content-errors.js";

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

/** Validate a file list: relative paths, no duplicates, and the count and size limits. */
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
        `"${file.path}" is larger than ${artifactLimits.fileSize / (1024 * 1024)} MiB.`,
      );
    totalSize += file.size;
  }
  if (totalSize > artifactLimits.totalSize)
    throw new InvalidFilesError(
      `Files can total at most ${artifactLimits.totalSize / (1024 * 1024)} MiB.`,
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
