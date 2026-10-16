import swagger from "@fastify/swagger";
import type { FastifyInstance } from "fastify";
import type { ApiDocumentationPublisher } from "../interface/api-documentation.js";
import type { ApiDefinition } from "../model/api-documentation.js";
import { errorResponse } from "../../http/schema/http-response.js";

/** Reflect routes in the authenticated scope before its controllers register any endpoints. */
export async function registerApiDocumentation(
  app: FastifyInstance,
  publisher: ApiDocumentationPublisher,
): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Everything API",
        version: "1.0.0",
        description:
          "Generated from the running service's registered authenticated routes and JSON schemas. Apps request the everything-api capability. Their backend receives EVERYTHING_API_URL, EVERYTHING_TOKEN_URL, EVERYTHING_CLIENT_ID, and EVERYTHING_CLIENT_SECRET. POST grant_type=client_credentials, client_id, and client_secret as application/x-www-form-urlencoded to EVERYTHING_TOKEN_URL, then use the returned access_token as Authorization: Bearer for these routes under EVERYTHING_API_URL. App tokens act as the app owner. Keep credentials and tokens on the backend. Browser sessions are also accepted by these routes. Resource ownership is enforced by each endpoint; workspaces and worker settings are installation-wide. Browser sign-in, OAuth callbacks, health probes, and internal service routes are outside this definition. Expected errors return {code, message}.",
      },
      servers: [
        {
          url: "/",
          description:
            "Use the app backend's EVERYTHING_API_URL as the base URL.",
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    /** Preserve route schemas and document the common error envelope without changing serialization. */
    transform({ schema, url }) {
      return {
        url,
        schema: {
          ...schema,
          response: {
            default: errorResponse,
            ...(schema?.response as Record<string, unknown> | undefined),
          },
        },
      };
    },
  });
  app.addHook("onReady", async () => {
    publisher.publish(app.swagger() as ApiDefinition);
  });
}
