import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import type { GeneralSettingsOperations } from "../interface/general-settings.js";
import {
  generalSettingsBody,
  type GeneralSettingsBody,
} from "../schema/settings-request.js";

/** Expose general preferences using only the authenticated identity as their owner. */
export async function generalSettingsController(
  app: FastifyInstance,
  settings: GeneralSettingsOperations,
): Promise<void> {
  app.get(
    "/settings/general",
    {
      schema: {
        summary: "Read your general preferences",
        response: { 200: generalSettingsBody },
      },
    },
    async (request) => settings.read(subject(request)),
  );
  app.put<{ Body: GeneralSettingsBody }>(
    "/settings/general",
    {
      schema: {
        summary: "Replace your general preferences",
        body: generalSettingsBody,
        response: { 200: generalSettingsBody },
      },
    },
    async (request) => settings.update(subject(request), request.body),
  );
}
