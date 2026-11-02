import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createWorkspaceImageGateway } from "./workspace-image-gateway.js";

/** Main-only browser entry point, fresh owned volume and synthetic files; no live provider implementation. */
const root = process.env.WORKSPACE_IMAGES_E2E_ROOT;
if (!root || !path.isAbsolute(root))
  throw new Error("Set a fresh owned absolute WORKSPACE_IMAGES_E2E_ROOT");
await mkdir(path.join(root, "evidence"));
const port = Number(process.env.WORKSPACE_IMAGES_E2E_GATEWAY_PORT ?? 18193);
const { app } = await createWorkspaceImageGateway(
  root,
  process.env.WORKSPACE_IMAGES_E2E_ORIGIN ?? "http://localhost:5193",
);
await app.listen({ host: "127.0.0.1", port });
process.once("SIGTERM", () => void app.close().then(() => process.exit(0)));
