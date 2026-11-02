import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import {
  agentParams,
  type AgentParams,
} from "../../agent/schema/agent-request.js";
import type { WorkspaceImageContent } from "../interface/workspace-image-content.js";
import { WorkspaceImageContentError } from "../error/workspace-image-content-error.js";
import {
  workspaceImageQuery,
  workspaceImageResponse,
  type WorkspaceImageQuery,
} from "../schema/workspace-image-request.js";

/** Register inside the authenticated API; renderer filtering is never authorization. */
export async function workspaceImageController(
  app: FastifyInstance,
  images: WorkspaceImageContent,
): Promise<void> {
  app.get<{ Params: AgentParams; Querystring: WorkspaceImageQuery }>(
    "/agents/:agentId/workspace-image",
    {
      schema: {
        summary: "Display an image from this teammate's workspace",
        params: agentParams,
        querystring: workspaceImageQuery,
        produces: ["image/png", "image/jpeg", "image/gif", "image/webp"],
        response: { 200: workspaceImageResponse },
      },
      async onSend(_request, reply) {
        reply.header("Cache-Control", "private, no-store");
      },
    },
    async (request, reply) => {
      const site = request.headers["sec-fetch-site"];
      if (
        request.headers.authorization === undefined &&
        site !== undefined &&
        site !== "same-origin" &&
        site !== "none"
      )
        throw new WorkspaceImageContentError();
      const image = await images.read(
        subject(request),
        request.params.agentId,
        request.query.path,
      );
      return reply
        .header("Content-Type", image.mediaType)
        .header("Content-Length", image.bytes.byteLength)
        .header("Content-Disposition", "inline")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .send(
          Buffer.from(
            image.bytes.buffer,
            image.bytes.byteOffset,
            image.bytes.byteLength,
          ),
        );
    },
  );
}
