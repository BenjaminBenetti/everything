import { Type } from "typebox";
import type { FastifyInstance } from "fastify";
import type { ApiDocumentationReader } from "../interface/api-documentation.js";

/** Serve the same generated definition to authenticated app backends and API consumers. */
export async function apiDocumentationController(
  app: FastifyInstance,
  documentation: ApiDocumentationReader,
): Promise<void> {
  app.get(
    "/openapi.json",
    {
      schema: {
        summary: "Read the generated Everything API definition",
        response: {
          200: Type.Record(Type.String(), Type.Unknown(), {
            description:
              "OpenAPI 3.0.3 definition generated from registered routes.",
          }),
        },
      },
    },
    async () => documentation.read(),
  );
}
