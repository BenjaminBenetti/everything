import type { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { artifactLimits } from "@everything/artifact-contracts";
import type { ContentStore } from "../interface/content-store.js";
import {
  contentParams,
  missingContentBody,
  type ContentParams,
  type MissingContentBody,
} from "../schema/content-request.js";

/** Register content upload and download endpoints, addressed by SHA-256 hash. */
export async function contentController(
  app: FastifyInstance,
  content: ContentStore,
): Promise<void> {
  app.post<{ Body: MissingContentBody }>(
    "/content/missing",
    { schema: { body: missingContentBody } },
    async (request) => ({
      missing: await content.missing(request.body.hashes),
    }),
  );

  app.get<{ Params: ContentParams }>(
    "/content/:sha256",
    { schema: { params: contentParams } },
    async (request, reply) =>
      reply
        .type("application/octet-stream")
        .send(await content.open(request.params.sha256)),
  );

  // Uploads stream to disk instead of being buffered by a body parser.
  await app.register(async (uploads) => {
    uploads.addContentTypeParser(
      "application/octet-stream",
      (_request, payload, done) => done(null, payload),
    );
    uploads.put<{ Params: ContentParams }>(
      "/content/:sha256",
      { schema: { params: contentParams } },
      async (request, reply) => {
        await content.write(
          request.params.sha256,
          request.body as Readable,
          artifactLimits.fileSize,
        );
        return reply.code(204).send();
      },
    );
  });
}
