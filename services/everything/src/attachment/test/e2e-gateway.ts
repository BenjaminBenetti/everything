import { rm } from "node:fs/promises";
import path from "node:path";
import { createAttachmentGateway, e2eAgentId } from "./attachment-gateway.js";

const port = Number(process.env.ATTACHMENTS_E2E_GATEWAY_PORT ?? 18184);
const origin = process.env.ATTACHMENTS_E2E_ORIGIN ?? "http://localhost:5184";
const root = path.resolve(
  process.env.ATTACHMENTS_E2E_ROOT ?? ".local/attachments-e2e",
);
// Preserve the existing harness cleanup of only its own run's two named folders.
await rm(path.join(root, "workspace-volume"), { recursive: true, force: true });
await rm(path.join(root, "evidence"), { recursive: true, force: true });
const { app } = await createAttachmentGateway(root, origin);
await app.listen({ port, host: "127.0.0.1" });
console.log("ready " + port + " agent " + e2eAgentId);
process.once("SIGTERM", () => void app.close().then(() => process.exit(0)));
