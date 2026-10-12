import envSchema from "env-schema";
import { Type, type Static } from "typebox";
import { WorkspaceFiles } from "../../workspace/service/workspace-files.js";
import { BashRunner } from "../../shell/service/bash-runner.js";
import { createHttpApplication } from "../factory/http-application.js";

const settingsSchema = Type.Object({
  PORT: Type.Integer({ default: 8080, minimum: 1, maximum: 65535 }),
  WORKSPACE_DIRECTORY: Type.String({ const: "/workspace" }),
  WORKSPACE_TOKEN: Type.String({ pattern: "^[a-f0-9]{64}$" }),
});

/** Start directly under the container init, which reaps orphaned commands after cleanup. */
async function main(): Promise<void> {
  if (process.ppid !== 1)
    throw new Error(
      "The teammate API must run directly under the container init.",
    );
  process.umask(0o077);
  const settings = envSchema<Static<typeof settingsSchema>>({
    schema: settingsSchema,
  });
  const files = new WorkspaceFiles(settings.WORKSPACE_DIRECTORY);
  /** Linux excludes namespace PID 1 and the caller; no other pod shares this PID namespace. */
  const reap = (): void => {
    try {
      process.kill(-1, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const bash = new BashRunner(files, reap);
  const app = createHttpApplication(files, bash, settings.WORKSPACE_TOKEN);
  /** Stop work before allowing Kubernetes to replace the pod. */
  const shutdown = (): void => {
    bash.close();
    void app.close().then(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await app.listen({ host: "0.0.0.0", port: settings.PORT });
}

main().catch(() => {
  console.error("The teammate workspace could not start.");
  process.exit(1);
});
