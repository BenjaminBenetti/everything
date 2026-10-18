import { randomUUID } from "node:crypto";
import type { ArtifactCapability } from "@everything/artifact-contracts";
import type { WithinArtifactScope } from "../../artifact/interface/artifact-repository.js";
import type { Artifact } from "../../artifact/model/artifact.js";
import { ArtifactLookup } from "../../artifact/service/artifact-lookup.js";
import {
  ada,
  MemoryArtifacts,
  MemoryDeployments,
} from "../../artifact/test/artifact-fixture.js";
import type { AppApiKeyRepository } from "../interface/app-api-key-repository.js";
import type { CapabilitySecrets } from "../interface/artifact-capabilities.js";
import type { CapabilitySecretReader } from "../interface/capability-secret-reader.js";
import { newAppApiKey, type AppApiKeyRecord } from "../model/app-api-key.js";
import { AppApiKeys } from "../service/app-api-keys.js";
import { HashedAppApiKeyStore } from "../service/hashed-app-api-key-store.js";

/** Whether a record belongs to the scope's app. */
function within(scope: WithinArtifactScope, record: AppApiKeyRecord): boolean {
  return (
    record.ownerId === scope.ownerId && record.artifactId === scope.artifactId
  );
}

/** In-memory verification records with the PostgreSQL repository's scoping and one record per app. */
export class MemoryAppApiKeyRecords implements AppApiKeyRepository {
  readonly records: AppApiKeyRecord[] = [];

  async getById(scope: WithinArtifactScope, id: string) {
    return this.records.find(
      (record) => record.id === id && within(scope, record),
    );
  }
  async list(scope: WithinArtifactScope) {
    return this.records.filter((record) => within(scope, record));
  }
  async delete(scope: WithinArtifactScope, id: string) {
    const index = this.records.findIndex(
      (record) => record.id === id && within(scope, record),
    );
    if (index >= 0) this.records.splice(index, 1);
  }
  async find(scope: WithinArtifactScope) {
    return this.records.find((record) => within(scope, record));
  }
  async replace(scope: WithinArtifactScope, keyHash: string) {
    if (
      this.records.some(
        (record) =>
          record.artifactId === scope.artifactId && !within(scope, record),
      )
    )
      throw new Error("duplicate key value violates unique constraint");
    await this.revoke(scope);
    this.records.push({
      ...scope,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      keyHash,
    });
  }
  async revoke(scope: WithinArtifactScope) {
    this.records.splice(
      0,
      this.records.length,
      ...this.records.filter((record) => !within(scope, record)),
    );
  }
}

/** In-memory capability Secrets, keyed like the Kubernetes adapter, with an optional write failure. */
export class MemoryCapabilitySecrets
  implements CapabilitySecrets, CapabilitySecretReader
{
  readonly secrets = new Map<string, Readonly<Record<string, string>>>();
  failWrites = false;

  async write(
    appId: string,
    capability: ArtifactCapability,
    values: Readonly<Record<string, string>>,
  ) {
    if (this.failWrites) throw new Error("the cluster is unavailable");
    const name = `${appId}-${capability}`;
    this.secrets.set(name, { ...values });
    return name;
  }
  async remove(appId: string, capability: ArtifactCapability) {
    this.secrets.delete(`${appId}-${capability}`);
  }
  async read(appId: string, capability: ArtifactCapability) {
    return this.secrets.get(`${appId}-${capability}`);
  }
}

/** Synthetic apps with keys provisioned the way reconciliation stores them. */
export async function apiKeyApps() {
  const artifacts = new MemoryArtifacts();
  const deployments = new MemoryDeployments();
  const records = new MemoryAppApiKeyRecords();
  const secrets = new MemoryCapabilitySecrets();
  const store = new HashedAppApiKeyStore(records, secrets);
  const keys = new Map<string, string>();

  /** Deploy release 1 of a dynamic app with the given capabilities. */
  async function deployed(
    slug: string,
    capabilities: readonly ArtifactCapability[],
    changes: Partial<Artifact> = {},
  ): Promise<Artifact> {
    const app = artifacts.add("dynamic", slug, {
      liveDeployment: 1,
      release: 1,
      running: true,
      ...changes,
    });
    const scope = { ownerId: app.ownerId, artifactId: app.id };
    await deployments.create(scope, {
      release: 1,
      author: ada,
      build: 1,
      imageDigest: "sha256:abc",
      port: 8080,
      env: {},
      database: false,
      capabilities,
      diskGi: null,
      healthPath: null,
    });
    const key = newAppApiKey();
    await store.replace(scope, key);
    await secrets.write(app.id, "api-key", { APP_API_KEY: key });
    keys.set(slug, key);
    return app;
  }

  return {
    artifacts,
    deployments,
    records,
    secrets,
    store,
    keys,
    deployed,
    apiKeys: new AppApiKeys(
      artifacts,
      deployments,
      new ArtifactLookup(artifacts),
      store,
    ),
  };
}
