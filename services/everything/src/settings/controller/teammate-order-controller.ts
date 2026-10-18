import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import type { TeammateOrderOperations } from "../interface/teammate-order.js";
import {
  teammateOrderBody,
  type TeammateOrderBody,
} from "../schema/settings-request.js";

/** Expose the teammate order using only the authenticated identity as its owner. */
export async function teammateOrderController(
  app: FastifyInstance,
  order: TeammateOrderOperations,
): Promise<void> {
  app.get(
    "/settings/teammate-order",
    {
      schema: {
        summary: "Read the order of your teammates",
        response: { 200: teammateOrderBody },
      },
    },
    async (request) => order.read(subject(request)),
  );
  app.put<{ Body: TeammateOrderBody }>(
    "/settings/teammate-order",
    {
      schema: {
        summary: "Replace the order of your teammates",
        body: teammateOrderBody,
        response: { 200: teammateOrderBody },
      },
    },
    async (request) =>
      order.update(subject(request), {
        teammateIds: request.body.teammateIds,
      }),
  );
}
