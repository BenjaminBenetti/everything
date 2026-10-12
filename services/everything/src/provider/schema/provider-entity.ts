import { EntitySchema } from "typeorm";
import { baseColumns } from "@everything/persistence/schema";
import type { StoredProvider } from "../model/stored-provider.js";

/** One independently managed connection of each kind per owner. */
export const ProviderEntity = new EntitySchema<StoredProvider>({
  name: "StoredProvider",
  tableName: "provider_connections",
  columns: {
    ...baseColumns,
    ownerId: { name: "owner_id", type: "text" },
    provider: { type: "text" },
    configured: { type: "boolean" },
    baseUrl: { name: "base_url", type: "text", nullable: true },
    model: { type: "text", nullable: true },
    account: { type: "text", nullable: true },
    encryptedCredential: { name: "encrypted_credential", type: "text" },
    encryptedPending: {
      name: "encrypted_pending",
      type: "text",
      nullable: true,
    },
    verifiedAt: { name: "verified_at", type: "timestamptz", nullable: true },
    lastCheckedAt: {
      name: "last_checked_at",
      type: "timestamptz",
      nullable: true,
    },
    verificationError: {
      name: "verification_error",
      type: "text",
      nullable: true,
    },
  },
  uniques: [
    {
      name: "provider_connections_owner_provider",
      columns: ["ownerId", "provider"],
    },
  ],
  indices: [
    {
      name: "provider_connections_due_check",
      columns: ["configured", "lastCheckedAt"],
    },
  ],
  checks: [
    {
      name: "provider_connections_provider_check",
      expression: "provider IN ('chatgpt', 'anthropic', 'openai-compatible')",
    },
  ],
});
