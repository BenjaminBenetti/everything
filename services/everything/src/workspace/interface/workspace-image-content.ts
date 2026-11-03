import type { WorkspaceImage } from "./workspace-images.js";

/** Private browser display of a raster in an authorized teammate's own workspace. */
export interface WorkspaceImageContent {
  /** Resolve ownership before reading a root-relative or absolute own-workspace path. */
  read(
    ownerId: string,
    agentId: string,
    requested: string,
  ): Promise<WorkspaceImage>;
}

/** Read only validated raster bytes under one configured own-workspace root. */
export interface WorkspaceImageFiles {
  read(agentId: string, requested: string): Promise<WorkspaceImage>;
}
