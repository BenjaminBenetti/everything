import type { EntitySchemaColumnOptions, ValueTransformer } from "typeorm";

/** Preserve public ISO timestamps while TypeORM maps timestamptz to Date; null stays null. */
export const timestampTransformer: ValueTransformer = {
  /** Convert a supplied public timestamp to a native Date. */
  to(value: string | null | undefined): Date | null | undefined {
    return value === undefined || value === null ? value : new Date(value);
  },
  /** Convert a loaded timestamp to the public entity representation. */
  from(value: Date | null): string | null {
    return value === null ? null : value.toISOString();
  },
};

/** Shared column mappings composed into service-owned EntitySchemas. */
export const baseColumns = {
  id: { type: "uuid", primary: true },
  createdAt: {
    name: "created_at",
    type: "timestamptz",
    createDate: true,
    transformer: timestampTransformer,
  },
} satisfies Record<string, EntitySchemaColumnOptions>;
