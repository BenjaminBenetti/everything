import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getSystemErrorMessage } from "node:util";
import { WorkspacePathError } from "../error/workspace-errors.js";

/**
 * Where a teammate's files live. Its pod mounts its workspace and the shared folder at the same paths
 * as this process, so a path the teammate names is the path here.
 */
export interface WorkspaceLocation {
  /** The teammate's workspace directory. */
  readonly workspace: string;
  /** The folder every teammate can read and write. */
  readonly shared: string;
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
 * Resolve a directory the teammate named, relative to its workspace or absolute in it or the shared
 * folder. Refuses paths that leave both or enter the private directory, directly or through symbolic
 * links, and the workspace itself: it is also the teammate's home, holding installed tools and
 * settings that never belong in an artifact.
 */
export async function workspaceDirectory(
  location: WorkspaceLocation,
  directory: string,
  options: { readonly mustExist: boolean },
): Promise<string> {
  const areas = [location.workspace, location.shared];
  const resolved = directory.includes("\0")
    ? undefined
    : path.resolve(location.workspace, directory);
  const root = await realpath(location.workspace);
  const real = resolved === undefined ? undefined : await realTarget(resolved);
  const realAreas = await Promise.all(areas.map(realTarget));
  if (
    resolved === undefined ||
    real === undefined ||
    !areas.some((area) => isInside(area, resolved)) ||
    !realAreas.some((area) => isInside(area, real))
  )
    throw new WorkspacePathError(
      `"${directory}" is outside your workspace and the shared folder. Use a path relative to your workspace, or one under ${location.workspace} or ${location.shared}.`,
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
 * Run file work in a teammate's workspace, restating file system failures with the path that failed
 * when the teammate can see it, and without it otherwise.
 */
export async function inWorkspace<T>(
  location: WorkspaceLocation,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isSystemError(error)) throw error;
    const visible = [location.workspace, location.shared];
    const shown = (
      await Promise.all(
        visible.map(async (area) => [area, await realTarget(area)]),
      )
    )
      .flat()
      .some((area) => isInside(area, error.path))
      ? error.path
      : undefined;
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
