import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { WorkspacePathError } from "../error/workspace-errors.js";

/** Whether `candidate` is `root` or inside it. */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** The real path of `target`, or of its nearest existing ancestor joined with the rest. */
async function realTarget(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(await realTarget(parent), path.basename(target));
  }
}

/**
 * Resolve a directory named relative to the workspace (or absolute inside it), refusing paths that
 * leave the workspace directly or through symbolic links.
 */
export async function workspaceDirectory(
  workspace: string,
  directory: string,
  options: { readonly mustExist: boolean },
): Promise<string> {
  const root = await realpath(workspace);
  const resolved = path.resolve(workspace, directory);
  if (
    !isInside(path.resolve(workspace), resolved) ||
    !isInside(root, await realTarget(resolved))
  )
    throw new WorkspacePathError(`"${directory}" is outside your workspace.`);
  if (options.mustExist) {
    const info = await stat(resolved).catch(() => undefined);
    if (!info?.isDirectory())
      throw new WorkspacePathError(
        `"${directory}" is not a directory in your workspace.`,
      );
  }
  return resolved;
}
