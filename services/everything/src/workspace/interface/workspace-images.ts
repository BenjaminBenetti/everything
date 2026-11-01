import type { ImageMediaType } from "../model/image-format.js";

/** An image file's bytes and facts read from its header. */
export interface WorkspaceImage {
  readonly bytes: Uint8Array;
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
}

/** Read images a teammate can see, for showing them to its model on request. */
export interface WorkspaceImages {
  /** Read a PNG, JPEG, GIF, or WebP file in the teammate's workspace or the shared folder. */
  read(
    agentId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceImage>;
}
