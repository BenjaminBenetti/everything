import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAttachmentGateway } from "./attachment-gateway.js";
import { screenshot } from "./synthetic-screenshot.js";

/** Main-only focused browser gateway: fresh owned paths, real upload/codec/storage/conversation HTTP. */
const root = process.env.ATTACHMENTS_E2E_ROOT;
if (!root || !path.isAbsolute(root))
  throw new Error("Supply a fresh absolute ATTACHMENTS_E2E_ROOT");
await mkdir(path.join(root, "fixtures"));
await mkdir(path.join(root, "workspace-volume"));
await writeFile(
  path.join(root, "fixtures", "upload.png"),
  await screenshot(1280, 720, 64),
  { flag: "wx" },
);
const origin = process.env.ATTACHMENTS_E2E_ORIGIN ?? "http://localhost:5188";
const port = Number(process.env.ATTACHMENTS_E2E_GATEWAY_PORT ?? 18188);
const { app } = await createAttachmentGateway(root, origin);
await app.listen({ port, host: "127.0.0.1" });
console.log("PNG/WebP gateway ready " + port);
process.once("SIGTERM", () => void app.close().then(() => process.exit(0)));
