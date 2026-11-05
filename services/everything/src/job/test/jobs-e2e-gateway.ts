import { rm } from "node:fs/promises";
import path from "node:path";
import { createJobGateway, e2eAgentId } from "./job-gateway.js";

const port = Number(process.env.JOBS_E2E_GATEWAY_PORT ?? 18185);
const origin = process.env.JOBS_E2E_ORIGIN ?? "http://localhost:5185";
const root = path.resolve(process.env.JOBS_E2E_ROOT ?? ".local/jobs-e2e");
// Remove only this harness's own evidence folder from an earlier run.
await rm(path.join(root, "evidence"), { recursive: true, force: true });
const { app, scheduler } = await createJobGateway(root, origin);
await app.listen({ port, host: "127.0.0.1" });
// The scheduler checks on its own as it does in production; the test also advances the clock.
scheduler.start();
console.log("ready " + port + " agent " + e2eAgentId);
process.once("SIGTERM", () => void app.close().then(() => process.exit(0)));
