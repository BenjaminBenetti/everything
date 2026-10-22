import { EntitySchema } from "typeorm";
import {
  baseColumns,
  timestampTransformer,
} from "@everything/persistence/schema";
import type {
  CredentialBinding,
  CredentialRecord,
} from "../model/credential-binding.js";

/** Map grants to `app_credential_bindings`; rows are removed with their app after its cleanup. */
export const CredentialBindingEntity = new EntitySchema<CredentialBinding>({
  name: "CredentialBinding",
  tableName: "app_credential_bindings",
  columns: {
    ...baseColumns,
    ownerId: { name: "owner_id", type: "text" },
    artifactId: { name: "artifact_id", type: "uuid" },
    credentialId: { name: "credential_id", type: "uuid" },
    env: { type: "text" },
    version: { type: "integer" },
  },
  uniques: [
    { name: "app_credential_bindings_env", columns: ["artifactId", "env"] },
  ],
  indices: [
    { name: "app_credential_bindings_credential", columns: ["credentialId"] },
  ],
});

/** Map each credential's delivered version and revocation to `credential_records`. */
export const CredentialRecordEntity = new EntitySchema<CredentialRecord>({
  name: "CredentialRecord",
  tableName: "credential_records",
  columns: {
    ...baseColumns,
    version: { type: "integer" },
    revokedAt: {
      name: "revoked_at",
      type: "timestamptz",
      nullable: true,
      transformer: timestampTransformer,
    },
  },
});
