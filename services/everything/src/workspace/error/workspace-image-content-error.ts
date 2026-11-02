import { ApplicationError } from "@everything/errors";

/** Missing, inaccessible, unsafe and unsupported images have the same public response. */
export class WorkspaceImageContentError extends ApplicationError {
  /** Never expose a server path or whether another teammate owns a file. */
  constructor() {
    super(404, "WORKSPACE_IMAGE_UNAVAILABLE", "This image is unavailable.");
  }
}
