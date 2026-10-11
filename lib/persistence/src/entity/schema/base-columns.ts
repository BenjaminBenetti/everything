import type { EntitySchemaColumnOptions, ValueTransformer } from "typeorm";

/** Preserve public ISO timestamps while TypeORM maps timestamptz to Date. */
const timestamp: ValueTransformer = {
  /** Convert a supplied public timestamp to a native Date. */
  to(value: string | undefined): Date | undefined {
    return value === undefined ? undefined : new Date(value);
  },
  /** Convert a loaded timestamp to the public entity representation. */
  from(value: Date): string {
    return value.toISOString();
  },
};

/** Shared column mappings composed into service-owned EntitySchemas. */
export const baseColumns = {
  id: { type: "uuid", primary: true },
  createdAt: {
    name: "created_at",
    type: "timestamptz",
    createDate: true,
    transformer: timestamp,
  },
} satisfies Record<string, EntitySchemaColumnOptions>;
