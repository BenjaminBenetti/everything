import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getSystemErrorMessage } from "node:util";
import { workspaceMountPath } from "@everything/workspace-contracts/mount";
import { WorkspacePathError } from "../error/workspace-errors.js";

/** Where a teammate's files live in this process; its pod mounts `workspace` at `workspaceMountPath`. */
export interface WorkspaceLocation {
  /** The teammate's workspace directory in this process. */
  readonly workspace: string;
  /** The teammate's private runtime state inside its workspace, which tools never read or write. */
  readonly privateDirectory: string;
}

/** Explain why a path that is, or leads into, the private directory was refused. */
export function privatePathMessage(name: string): string {
  return `"${name}" can't be used. Private conversation files are unavailable.`;
}

/** Whether `candidate` is `root` or inside it. */
export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** The real path of `target`, or of its nearest existing ancestor joined with the rest. */
export async function realTarget(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(await realTarget(parent), path.basename(target));
  }
}

/** Whether `target` is one of `directories` or inside one, by name or after resolving symbolic links. */
export async function isInsideAny(
  directories: readonly string[],
  target: string,
): Promise<boolean> {
  const real = await realTarget(target);
  for (const directory of directories)
    if (
      isInside(directory, target) ||
      isInside(await realTarget(directory), real)
    )
      return true;
  return false;
}

/**
 * A directory's path relative to the workspace. Absolute paths are read as the teammate's pod sees
 * them, so only `/workspace` and paths under it are inside; any other absolute path is undefined.
 */
function workspaceRelative(directory: string): string | undefined {
  if (!path.posix.isAbsolute(directory)) return directory;
  const absolute = path.posix.resolve(directory);
  return isInside(workspaceMountPath, absolute)
    ? path.posix.relative(workspaceMountPath, absolute)
    : undefined;
}

/**
 * Resolve a directory the teammate named, relative to its workspace or absolute under `/workspace`.
 * Refuses paths that leave the workspace or enter its private directory, directly or through
 * symbolic links, and the workspace itself: it is also the teammate's home, holding installed tools
 * and settings that never belong in an artifact.
 */
export async function workspaceDirectory(
  location: WorkspaceLocation,
  directory: string,
  options: { readonly mustExist: boolean },
): Promise<string> {
  const relative = directory.includes("\0")
    ? undefined
    : workspaceRelative(directory);
  const resolved =
    relative === undefined
      ? undefined
      : path.resolve(location.workspace, relative);
  const root = await realpath(location.workspace);
  const real = resolved === undefined ? undefined : await realTarget(resolved);
  if (
    resolved === undefined ||
    real === undefined ||
    !isInside(location.workspace, resolved) ||
    !isInside(root, real)
  )
    throw new WorkspacePathError(
      `"${directory}" is outside your workspace. Use a path relative to it, or one under ${workspaceMountPath}.`,
    );
  if (real === root)
    throw new WorkspacePathError(
      `"${directory}" is your whole workspace, which also holds your installed tools and settings. Use a directory inside it, such as "site".`,
    );
  if (await isInsideAny([location.privateDirectory], resolved))
    throw new WorkspacePathError(privatePathMessage(directory));
  const info = await stat(resolved).catch(() => undefined);
  if (info ? !info.isDirectory() : options.mustExist)
    throw new WorkspacePathError(
      `"${directory}" is not a directory in your workspace.`,
    );
  return resolved;
}

/** Name a path in this process as the teammate's pod sees it, or undefined outside the workspace. */
function teammatePath(
  roots: readonly string[],
  local: string,
): string | undefined {
  const root = roots.find((candidate) => isInside(candidate, local));
  return root === undefined
    ? undefined
    : path.posix.join(workspaceMountPath, path.relative(root, local));
}

/** A file system failure from Node, which names the local path it was working on. */
function isSystemError(error: unknown): error is NodeJS.ErrnoException & {
  path: string;
} {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    typeof (error as NodeJS.ErrnoException).path === "string"
  );
}

/**
 * Run file work in a teammate's workspace, restating file system failures with paths as the
 * teammate sees them, so tool results never reveal where the workspace lives in this process.
 */
export async function inWorkspace<T>(
  location: WorkspaceLocation,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isSystemError(error)) throw error;
    const roots = [
      location.workspace,
      await realpath(location.workspace).catch(() => location.workspace),
    ];
    const shown = teammatePath(roots, error.path);
    const reason =
      typeof error.errno === "number"
        ? getSystemErrorMessage(error.errno)
        : error.code;
    throw new WorkspacePathError(
      shown === undefined
        ? `A file outside your workspace couldn't be used: ${reason}.`
        : `Couldn't use "${shown}": ${reason}.`,
    );
  }
}
