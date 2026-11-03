import type { WorkspaceImageFiles } from "../interface/workspace-image-content.js";
import { workspaceImagePathMaxLength } from "../model/workspace-image-content.js";
import { constants } from "node:fs";
import { lstat, open, readlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import AsyncLock from "async-lock";
import sharp from "sharp";
import { workspacePath } from "@everything/workspace-contracts/mount";
import type { AgentWorkspaces } from "../interface/agent-workspaces.js";
import type { WorkspaceImage } from "../interface/workspace-images.js";
import { WorkspaceImageContentError } from "../error/workspace-image-content-error.js";
import { maxImageBytes } from "./file-system-workspace-images.js";
import {
  imageDimensions,
  imageMediaType,
  maxImagePixels,
} from "../model/image-format.js";

/** Read-only, own-root display boundary; model image_view retains its separate shared-folder policy. */
export class FileSystemWorkspaceImageContent implements WorkspaceImageFiles {
  // ===========================================
  // State
  // ===========================================

  private readonly reads = new AsyncLock({ maxPending: 4, timeout: 5_000 });

  // ===========================================
  // Construction
  // ===========================================

  /** Workspace roots come from deployment configuration, never a request-supplied teammate ID/path. */
  constructor(
    private readonly workspaces: Pick<AgentWorkspaces, "directory">,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Bound concurrent byte buffers and raster validation, without keeping a file cache or writing copies. */
  async read(agentId: string, requested: string): Promise<WorkspaceImage> {
    return this.reads
      .acquire("image", () => this.readFile(agentId, requested))
      .catch(() => {
        throw new WorkspaceImageContentError();
      });
  }

  /** Walk through held directory descriptors, refusing links at every step and changed roots/files. */
  private async readFile(
    agentId: string,
    requested: string,
  ): Promise<WorkspaceImage> {
    const root = path.resolve(this.workspaces.directory(agentId));
    const parts = imagePath(root, workspacePath(agentId), requested);
    const handles: FileHandle[] = [];
    try {
      let parent = await open(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(parent);
      const rootInfo = await parent.stat({ bigint: true });
      for (const part of parts.slice(0, -1)) {
        parent = await open(
          `/proc/self/fd/${parent.fd}/${part}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        handles.push(parent);
      }
      const file = await open(
        `/proc/self/fd/${parent.fd}/${parts.at(-1)!}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      handles.push(file);
      const before = await file.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size === 0n ||
        before.size > BigInt(maxImageBytes)
      )
        throw new WorkspaceImageContentError();
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!bytesRead) throw new WorkspaceImageContentError();
        offset += bytesRead;
      }
      const mediaType = imageMediaType(bytes);
      const dimensions = mediaType && imageDimensions(bytes, mediaType);
      if (
        !mediaType ||
        !dimensions ||
        !dimensions.width ||
        !dimensions.height ||
        dimensions.width * dimensions.height > maxImagePixels
      )
        throw new WorkspaceImageContentError();
      // Decode validation only: stats returns no encoded pixels; the original file bytes are served unchanged.
      const image = sharp(bytes, {
        animated: true,
        limitInputPixels: maxImagePixels,
        failOn: "warning",
      }).timeout({ seconds: 5 });
      const metadata = await image.metadata();
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width * metadata.height > maxImagePixels
      )
        throw new WorkspaceImageContentError();
      await image.stats();
      const [after, currentRoot, currentFile, opened] = await Promise.all([
        file.stat({ bigint: true }),
        lstat(root, { bigint: true }),
        lstat(path.join(root, ...parts), { bigint: true }),
        readlink(`/proc/self/fd/${file.fd}`),
      ]);
      if (
        currentRoot.isSymbolicLink() ||
        currentRoot.dev !== rootInfo.dev ||
        currentRoot.ino !== rootInfo.ino ||
        currentFile.isSymbolicLink() ||
        currentFile.dev !== before.dev ||
        currentFile.ino !== before.ino ||
        opened !== path.join(root, ...parts) ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        after.nlink !== 1n
      )
        throw new WorkspaceImageContentError();
      return { bytes, mediaType, ...dimensions };
    } finally {
      for (const handle of handles.reverse()) await handle.close();
    }
  }
}

/** One query decoding at HTTP transport only; percent sequences here are literal filename characters. */
function imagePath(
  root: string,
  visibleRoot: string,
  requested: string,
): string[] {
  if (
    !requested ||
    requested.length > workspaceImagePathMaxLength ||
    /[\u0000-\u001f\u007f\\]/u.test(requested) ||
    /^[a-z][a-z0-9+.-]*:/i.test(requested) ||
    requested.startsWith("//")
  )
    throw new WorkspaceImageContentError();
  let relative = requested;
  if (path.isAbsolute(requested)) {
    const prefix = [root, visibleRoot].find((candidate) =>
      requested.startsWith(candidate + "/"),
    );
    if (!prefix) throw new WorkspaceImageContentError();
    relative = requested.slice(prefix.length + 1);
  }
  const parts = relative.split("/").filter((part) => part !== ".");
  if (!parts.length || parts.some((part) => !part || part.startsWith(".")))
    throw new WorkspaceImageContentError();
  return parts;
}
