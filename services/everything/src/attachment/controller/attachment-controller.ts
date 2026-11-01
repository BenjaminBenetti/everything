import type { FastifyInstance, FastifyRequest } from "fastify";
import { subject } from "@everything/security/fastify";
import {
  agentParams,
  type AgentParams,
} from "../../agent/schema/agent-request.js";
import { noContentResponse } from "../../http/schema/http-response.js";
import {
  AttachmentNotFoundError,
  AttachmentTooLargeError,
} from "../error/attachment-errors.js";
import type { AttachmentOperations } from "../interface/attachment-operations.js";
import { attachmentLimits } from "../model/attachment.js";
import {
  attachmentParams,
  attachmentPartQuery,
  createAttachmentBody,
  type AttachmentParams,
  type AttachmentPartQuery,
  type CreateAttachmentBody,
} from "../schema/attachment-request.js";
import {
  attachmentContentResponse,
  attachmentUploadListResponse,
  attachmentUploadResponse,
} from "../schema/attachment-response.js";

/** Media type of an uploaded part: raw bytes, whatever the file is. */
const partMediaType = "application/octet-stream";

/**
 * A Content-Disposition value the file's name can't break: an ASCII fallback of plain characters and
 * the exact name percent-encoded, so quotes, line breaks, and separators never reach the header.
 */
export function contentDisposition(
  disposition: "inline" | "attachment",
  name: string,
): string {
  const fallback = name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 100);
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback || "file"}"; filename*=UTF-8''${encoded}`;
}

/**
 * Browsers report where a request came from. A signed-in browser loads files only from Everything's
 * own pages or an address the user opened directly, so other sites, including apps on the artifact
 * host, can't embed the owner's files. Bearer clients are not browsers and aren't affected.
 */
function requireOwnPage(request: FastifyRequest): void {
  const site = request.headers["sec-fetch-site"];
  if (
    request.headers.authorization === undefined &&
    site !== undefined &&
    site !== "same-origin" &&
    site !== "none"
  )
    throw new AttachmentNotFoundError();
}

/** Register uploads into a teammate's workspace, their listing, download, and removal. */
export async function attachmentController(
  app: FastifyInstance,
  attachments: AttachmentOperations,
): Promise<void> {
  app.get<{ Params: AgentParams }>(
    "/agents/:agentId/attachments",
    {
      schema: {
        summary: "List the files waiting to be sent to the teammate",
        description:
          "Returns attachments that are uploading or uploaded but not yet sent, oldest first. Sent attachments appear on their messages instead.",
        params: agentParams,
        response: { 200: attachmentUploadListResponse },
      },
    },
    async (request) =>
      attachments.unsent(subject(request), request.params.agentId),
  );

  app.post<{ Params: AgentParams; Body: CreateAttachmentBody }>(
    "/agents/:agentId/attachments",
    {
      schema: {
        summary: "Begin uploading a file for the teammate",
        description: `Reserves a file of the given size, up to ${attachmentLimits.maxFileBytes} bytes, and returns its upload with a server-chosen path in the teammate's workspace. Send its bytes in parts with POST …/content. A teammate holds up to ${attachmentLimits.maxFiles} unsent files totalling ${attachmentLimits.maxTotalBytes} bytes. An empty file is ready at once. Files that are never sent are removed after ${attachmentLimits.unsentRetentionMs / 3_600_000} hours.`,
        params: agentParams,
        body: createAttachmentBody,
        response: { 201: attachmentUploadResponse },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await attachments.create(
            subject(request),
            request.params.agentId,
            request.body,
          ),
        ),
  );

  app.get<{ Params: AttachmentParams }>(
    "/agents/:agentId/attachments/:attachmentId/content",
    {
      schema: {
        summary: "Download an attached file",
        description:
          "Returns a complete attachment's file as it is now in the teammate's workspace; a file the teammate moved or deleted is no longer available.",
        produces: [
          partMediaType,
          "image/png",
          "image/jpeg",
          "image/gif",
          "image/webp",
        ],
        params: attachmentParams,
        response: { 200: attachmentContentResponse },
      },
    },
    async (request, reply) => {
      requireOwnPage(request);
      const file = await attachments.content(
        subject(request),
        request.params.agentId,
        request.params.attachmentId,
      );
      const inline = file.kind === "image";
      return reply
        .header("Content-Type", inline ? file.mediaType : partMediaType)
        .header("Content-Length", file.size)
        .header(
          "Content-Disposition",
          contentDisposition(inline ? "inline" : "attachment", file.name),
        )
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .header("X-Content-Type-Options", "nosniff")
        .send(file.stream);
    },
  );

  app.delete<{ Params: AttachmentParams }>(
    "/agents/:agentId/attachments/:attachmentId",
    {
      schema: {
        summary: "Cancel an upload or remove an unsent file",
        description:
          "Removes the upload and its file from the teammate's workspace. A file already sent in the conversation stays with its message (409).",
        params: attachmentParams,
        response: { 204: noContentResponse },
      },
    },
    async (request, reply) => {
      await attachments.remove(
        subject(request),
        request.params.agentId,
        request.params.attachmentId,
      );
      return reply.code(204).send();
    },
  );

  // Parts are the only streamed bodies the API reads, so their parser stays in this scope; the
  // handler writes bytes to disk as they arrive instead of buffering the part.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(partMediaType, (_request, payload, done) =>
      done(null, payload),
    );
    scope.post<{
      Params: AttachmentParams;
      Querystring: AttachmentPartQuery;
      Body: AsyncIterable<Uint8Array>;
    }>(
      "/agents/:agentId/attachments/:attachmentId/content",
      {
        bodyLimit: attachmentLimits.maxChunkBytes,
        schema: {
          summary: "Upload the next part of a file",
          description: `Send up to ${attachmentLimits.maxChunkBytes} bytes as ${partMediaType}, starting at the upload's received count. A part that ends early or fails is discarded, so it can be sent again from the same offset. The part that completes the file places it at its path in the teammate's workspace.`,
          consumes: [partMediaType],
          params: attachmentParams,
          querystring: attachmentPartQuery,
          response: { 200: attachmentUploadResponse },
        },
      },
      async (request, reply) => {
        if (
          Number(request.headers["content-length"]) >
          attachmentLimits.maxChunkBytes
        )
          throw new AttachmentTooLargeError();
        const abort = new AbortController();
        // The response's close before it finishes means the caller left mid-part.
        reply.raw.once("close", () => {
          if (!reply.raw.writableFinished) abort.abort();
        });
        return attachments.append(
          subject(request),
          request.params.agentId,
          request.params.attachmentId,
          Number(request.query.offset),
          request.body,
          abort.signal,
        );
      },
    );
  });
}
