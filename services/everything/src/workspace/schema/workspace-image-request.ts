import { Type, type Static } from "typebox";
import { workspaceImagePathMaxLength } from "../model/workspace-image-content.js";

/** Query strings are decoded once by Fastify; the file reader never decodes them again. */
export const workspaceImageQuery = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: workspaceImagePathMaxLength }),
  },
  { additionalProperties: false },
);
export type WorkspaceImageQuery = Static<typeof workspaceImageQuery>;

/** Only validated PNG, JPEG, GIF and WebP bytes are returned. */
export const workspaceImageResponse = Type.String({ format: "binary" });
