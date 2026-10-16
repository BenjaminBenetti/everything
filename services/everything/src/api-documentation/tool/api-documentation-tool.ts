import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ApiDocumentationReader } from "../interface/api-documentation.js";
import {
  apiDocumentationMethods,
  apiDocumentationToolName,
} from "../model/api-documentation.js";

/** Give main and private sessions read-only access to the running API's generated definition. */
export function apiDocumentationTool(
  documentation: ApiDocumentationReader,
  agentId: string,
) {
  return defineTool({
    name: apiDocumentationToolName,
    label: "Read Everything API documentation",
    description:
      "Get the current Everything OpenAPI definition generated from registered routes: authentication, paths, request parameters and bodies, response schemas, and endpoint behavior. Call before writing apps or remote-event integrations against the Everything API. Omit filters for the full definition, or select a path prefix and HTTP method. Includes the current teammate ID for apps that need to address this teammate. This only reads documentation; it does not execute API requests.",
    parameters: Type.Object(
      {
        path: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 512,
            pattern: "^/",
            description:
              "Path prefix, for example /v1/agents or /v1/agents/{agentId}/subagent/wakeup. Fastify :agentId spelling also works.",
          }),
        ),
        method: Type.Optional(
          Type.Union(
            apiDocumentationMethods.map((method) => Type.Literal(method)),
            { description: "Optional HTTP method, such as POST." },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    /** Read an isolated schema snapshot without inspecting user data or credentials. */
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              agentId,
              definition: documentation.read(input),
            }),
          },
        ],
        details: {},
      };
    },
  });
}
