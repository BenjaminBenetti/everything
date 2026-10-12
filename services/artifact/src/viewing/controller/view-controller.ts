import type { FastifyInstance } from "fastify";
import {
  ownerParams,
  type OwnerParams,
} from "../../artifact/schema/artifact-request.js";
import { viewBody, type ViewBody } from "../schema/view-request.js";
import type { ViewAccess } from "../service/view-access.js";

/** Register the internal endpoint issuing links that open artifacts for the signed-in user. */
export async function viewController(
  app: FastifyInstance,
  access: Pick<ViewAccess, "grant">,
): Promise<void> {
  app.post<{ Params: OwnerParams; Body: ViewBody }>(
    "/owners/:ownerId/views",
    { schema: { params: ownerParams, body: viewBody } },
    async (request) =>
      access.grant(request.params.ownerId, {
        slug: request.body.slug,
        ...(request.body.path !== undefined ? { path: request.body.path } : {}),
      }),
  );
}
