import envSchema from "env-schema";
import { Type, type Static } from "typebox";
import {
  fleetTokenWorkspaceFile,
  sharedWorkspacePath,
  workspaceRoot,
} from "@everything/workspace-contracts/mount";
import { WorkspaceFiles } from "../../workspace/service/workspace-files.js";
import { BashRunner } from "../../shell/service/bash-runner.js";
import { MonitorRunner } from "../../shell/service/monitor-runner.js";
import { LinuxCommandProcessFactory } from "../../shell/adapter/linux-command-process-factory.js";
import { FileOutputSecrets } from "../../shell/adapter/file-output-secrets.js";
import { commandEnvironment } from "../../shell/model/command-environment.js";
import { defaultMonitorPolicy } from "../../shell/model/monitor-policy.js";
import { createHttpApplication } from "../factory/http-application.js";

const settingsSchema = Type.Object({
  PORT: Type.Integer({ default: 8080, minimum: 1, maximum: 65535 }),
  /** The teammate's own workspace, `/workspace/<agent id>`, which Everything mounts at the same path. */
  WORKSPACE_DIRECTORY: Type.String({
    pattern: `^${workspaceRoot}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
  }),
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
  const files = new WorkspaceFiles(
    settings.WORKSPACE_DIRECTORY,
    sharedWorkspacePath,
  );
  const processes = new LinuxCommandProcessFactory();
  // Commands can read the Fleet token, which grants full control of Fleet, but their output must
  // never return it. Everything may publish it, or a new one, after the workspace starts.
  const secrets = new FileOutputSecrets([fleetTokenWorkspaceFile]);
  const environment = commandEnvironment(process.env, files.home);
  const bash = new BashRunner(files, processes, environment, secrets);
  const monitors = new MonitorRunner(
    files,
    processes,
    defaultMonitorPolicy,
    environment,
    Date.now,
    secrets,
  );
  const app = createHttpApplication(
    files,
    bash,
    monitors,
    settings.WORKSPACE_TOKEN,
  );
  /** Stop work before allowing Kubernetes to replace the pod. */
  const shutdown = (): void => {
    bash.close();
    void monitors.close();
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
