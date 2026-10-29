import type { DataSource } from "typeorm";
import { serializableTransaction } from "@everything/persistence/transaction";
import type { WithinArtifactScope } from "../../artifact/interface/artifact-repository.js";
import type { Artifact } from "../../artifact/model/artifact.js";
import { PostgresArtifactRepository } from "../../artifact/repository/postgres-artifact-repository.js";
import { PostgresAppApiKeyRepository } from "../../capability/repository/postgres-app-api-key-repository.js";
import { changeGrants } from "../../credential/repository/postgres-credential-grant-repository.js";
import type {
  ReleaseCommit,
  ReleaseStore,
} from "../interface/release-store.js";
import { PostgresDeploymentRepository } from "./postgres-deployment-repository.js";

/** Commit a release's records in one serializable PostgreSQL transaction. */
export class PostgresReleaseStore implements ReleaseStore {
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the app service's database. */
  constructor(private readonly database: DataSource) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Use the repositories bound to the transaction, so every write commits or none does. */
  commit(
    scope: WithinArtifactScope,
    release: ReleaseCommit,
  ): Promise<Artifact> {
    return serializableTransaction(this.database.manager, async (manager) => {
      if (release.grants) await changeGrants(manager, scope, release.grants);
      if (release.revokeApiKey)
        await new PostgresAppApiKeyRepository(manager).revoke(scope);
      await new PostgresDeploymentRepository(manager).create(
        scope,
        release.deployment,
      );
      const updated = await new PostgresArtifactRepository(manager).update(
        { ownerId: scope.ownerId },
        scope.artifactId,
        release.changes,
      );
      if (!updated)
        throw new Error("The artifact disappeared during its deployment");
      return updated;
    });
  }
}
