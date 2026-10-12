import type { FastifyInstance } from "fastify";
import type { ContentStore } from "../../content/interface/content-store.js";
import { archiveSource } from "../../content/service/source-archive.js";
import {
  buildSourceParams,
  buildSourceQuery,
  type BuildSourceParams,
  type BuildSourceQuery,
} from "../schema/build-request.js";
import type { BuildService } from "../service/build-service.js";

/** Register the endpoint build jobs download their source from, authorized by the build's token. */
export async function buildSourceController(
  app: FastifyInstance,
  builds: Pick<BuildService, "source">,
  content: Pick<ContentStore, "open">,
): Promise<void> {
  app.get<{ Params: BuildSourceParams; Querystring: BuildSourceQuery }>(
    "/build-sources/:buildId",
    { schema: { params: buildSourceParams, querystring: buildSourceQuery } },
    async (request, reply) => {
      const files = await builds.source(
        request.params.buildId,
        request.query.token,
      );
      if (!files)
        return reply
          .code(404)
          .send({ code: "SOURCE_NOT_FOUND", message: "Not found." });
      return reply
        .type("application/x-tar")
        .send(archiveSource(files, content));
    },
  );
}
