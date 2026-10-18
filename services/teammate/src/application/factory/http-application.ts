import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { errorHandler } from "@everything/errors/fastify";
import {
  fileReadInput,
  fileWriteInput,
  bashInput,
  workspaceLimits,
  type FileReadInput,
  type FileWriteInput,
  type BashInput,
} from "@everything/workspace-contracts";
import type { WorkspaceFileAccess } from "../../workspace/interface/workspace-files.js";
import {
  monitorInput,
  monitorLimits,
  monitorParams,
  type MonitorInput,
  type MonitorParams,
} from "@everything/workspace-contracts/monitor";
import type { CommandRunner } from "../../shell/interface/command-runner.js";
import type { CommandMonitors } from "../../shell/interface/command-monitors.js";
import { WorkspaceUnauthorizedError } from "../../workspace/error/workspace-errors.js";

/** Build the private control API; no model, provider, database, or Kubernetes credentials enter it. */
export function createHttpApplication(
  files: WorkspaceFileAccess,
  bash: CommandRunner,
  monitors: CommandMonitors,
  token: string,
) {
  const app = Fastify({
    bodyLimit: workspaceLimits.writeBytes * 6 + 8192,
    logger: false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.setErrorHandler(errorHandler);
  app.get("/health", async () => ({ ready: true }));
  app.register(async (control) => {
    control.addHook("onRequest", async (request) => {
      const supplied = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        throw new WorkspaceUnauthorizedError();
    });
    control.post<{ Body: FileReadInput }>(
      "/files/read",
      { schema: { body: fileReadInput } },
      async (request) => files.read(request.body),
    );
    control.post<{ Body: FileWriteInput }>(
      "/files/write",
      { schema: { body: fileWriteInput } },
      async (request) => files.write(request.body),
    );
    control.post<{ Body: BashInput }>(
      "/bash",
      { schema: { body: bashInput } },
      async (request, reply) => {
        const cancellation = new AbortController();
        /** Client disconnects cancel execution, including commands with no output. */
        const disconnected = (): void => {
          if (!reply.raw.writableEnded) cancellation.abort();
        };
        reply.raw.once("close", disconnected);
        try {
          return await bash.run(request.body, cancellation.signal);
        } finally {
          reply.raw.removeListener("close", disconnected);
        }
      },
    );
    control.post<{ Body: MonitorInput }>(
      "/monitors",
      { schema: { body: monitorInput } },
      async (request) => monitors.start(request.body),
    );
    /** Long-poll for completion; Everything repeats this request, which keeps the monitor's lease. */
    control.post<{ Params: MonitorParams }>(
      "/monitors/:id/wait",
      { schema: { params: monitorParams } },
      async (request) =>
        monitors.wait(request.params.id, monitorLimits.waitSeconds * 1000),
    );
    control.post<{ Params: MonitorParams }>(
      "/monitors/:id/cancel",
      { schema: { params: monitorParams } },
      async (request) => monitors.cancel(request.params.id),
    );
  });
  app.addHook("preClose", async () => {
    bash.close();
    await monitors.close();
  });
  return app;
}
