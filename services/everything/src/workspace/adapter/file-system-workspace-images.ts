import { constants } from "node:fs";
import { open, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import type { AgentWorkspaces } from "../interface/agent-workspaces.js";
import type {
  WorkspaceImage,
  WorkspaceImages,
} from "../interface/workspace-images.js";
import { WorkspaceImageError } from "../error/workspace-image-errors.js";
import {
  imageDimensions,
  imageMediaType,
  maxImagePixels,
} from "../model/image-format.js";

/** Largest image file read for viewing. */
export const maxImageBytes = 25 * 1024 * 1024;

/**
 * Read images from the workspace volume Everything shares with teammate pods, allowing only what the
 * teammate's own pod could open: its workspace, outside its private runtime state, and the shared
 * folder. The file is opened without following a final link, and the place it was actually opened
 * from is checked through its descriptor, so no link can reach another teammate's files.
 */
export class FileSystemWorkspaceImages implements WorkspaceImages {
  // ===========================================
  // Construction
  // ===========================================

  /** Use the teammates' workspace directories and the shared folder. */
  constructor(
    private readonly workspaces: Pick<AgentWorkspaces, "directory" | "shared">,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Read a bounded image file and its size, refusing anything that isn't a supported raster image. */
  async read(
    agentId: string,
    requested: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceImage> {
    const workspace = this.workspaces.directory(agentId);
    const shared = this.workspaces.shared;
    const target = path.resolve(workspace, requested);
    if (requested.includes("\0") || !permits(workspace, shared, target))
      throw new WorkspaceImageError(
        `"${requested}" is outside your workspace and the shared folder. Use a path relative to your workspace, or one under ${workspace} or ${shared}.`,
      );
    const file = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch(() => {
      throw new WorkspaceImageError(
        `"${requested}" couldn't be opened. Check the path with bash, for example with ls -l.`,
      );
    });
    try {
      const opened = await readlink(`/proc/self/fd/${file.fd}`);
      const [realWorkspace, realShared] = await Promise.all([
        realpath(workspace),
        realpath(shared),
      ]);
      if (!permits(realWorkspace, realShared, opened))
        throw new WorkspaceImageError(
          `"${requested}" leads outside your workspace and the shared folder.`,
        );
      const info = await file.stat();
      if (!info.isFile())
        throw new WorkspaceImageError(`"${requested}" is not a regular file.`);
      if (info.size > maxImageBytes)
        throw new WorkspaceImageError(
          `"${requested}" is larger than ${maxImageBytes / 1024 / 1024} MB, too large to view. Make a smaller copy with a script first.`,
        );
      const bytes = Buffer.alloc(info.size);
      let read = 0;
      while (read < info.size) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(
          bytes,
          read,
          info.size - read,
          read,
        );
        if (!bytesRead) break;
        read += bytesRead;
      }
      const image = bytes.subarray(0, read);
      const mediaType = imageMediaType(image);
      if (!mediaType)
        throw new WorkspaceImageError(
          `"${requested}" isn't a PNG, JPEG, GIF, or WebP image. Read text with file_read, and inspect other files with bash.`,
        );
      const size = imageDimensions(image, mediaType);
      if (!size || !size.width || !size.height)
        throw new WorkspaceImageError(
          `"${requested}" has an image header that couldn't be read.`,
        );
      if (size.width * size.height > maxImagePixels)
        throw new WorkspaceImageError(
          `"${requested}" is ${size.width}×${size.height} pixels, too large to view. Make a smaller copy with a script first.`,
        );
      return { bytes: image, mediaType, ...size };
    } finally {
      await file.close();
    }
  }
}

/** Whether `location` is in the workspace outside its private runtime state, or in the shared folder. */
function permits(workspace: string, shared: string, location: string): boolean {
  return (
    (isInside(workspace, location) &&
      !isInside(path.join(workspace, ".pi"), location)) ||
    isInside(shared, location)
  );
}

/** Whether `location` is `directory` or inside it. */
function isInside(directory: string, location: string): boolean {
  const relative = path.relative(directory, location);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
