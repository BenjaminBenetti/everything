import { fileURLToPath } from "node:url";
import envSchema from "env-schema";
import {
  environmentSchema,
  type ServerEnvironment,
} from "../../server/schema/environment.js";
import { createStaticServer } from "../../server/factory/static-server.js";

/** Assemble the stateless UI host and drain its requests during pod replacement. */
async function main(): Promise<void> {
  const config = envSchema<ServerEnvironment>({ schema: environmentSchema });
  const root = fileURLToPath(new URL("../../../client/", import.meta.url));
  const app = await createStaticServer(root);
  /** Stop accepting requests before the process exits. */
  async function shutdown(): Promise<void> {
    await app.close();
  }
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await app.listen({ host: "0.0.0.0", port: config.PORT });
}

main().catch(() => {
  console.error("The UI server could not start.");
  process.exitCode = 1;
});
