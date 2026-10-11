import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Open Pi's persistent provider credentials and model catalog, shared by every agent. */
export async function createModelRuntime(
  stateDirectory: string,
): Promise<ModelRuntime> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  return ModelRuntime.create({
    authPath: path.join(stateDirectory, "auth.json"),
    modelsPath: path.join(stateDirectory, "models.json"),
    modelsStorePath: path.join(stateDirectory, "model-catalog.json"),
    allowModelNetwork: false,
  });
}
