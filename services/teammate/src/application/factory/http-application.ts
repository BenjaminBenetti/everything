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
import type { CommandRunner } from "../../shell/interface/command-runner.js";
import { WorkspaceUnauthorizedError } from "../../workspace/error/workspace-errors.js";

/** Build the private control API; no model, provider, database, or Kubernetes credentials enter it. */
export function createHttpApplication(
  files: WorkspaceFileAccess,
  bash: CommandRunner,
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
  });
  app.addHook("preClose", async () => bash.close());
  return app;
}
