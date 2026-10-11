import assert from "node:assert/strict";
import { test } from "node:test";
import { DataSource, EntitySchema, type FindOptionsWhere } from "typeorm";
import type { BaseEntity } from "../../entity/model/base-entity.js";
import { BaseRepository } from "../repository/base-repository.js";
const entity = new EntitySchema<BaseEntity>({
  name: "TestEntity",
  columns: { id: { type: "text", primary: true }, createdAt: { type: "text" } },
});
const database = new DataSource({ type: "postgres", entities: [entity] });
/** Exercise fail-closed guards against an ORM data source that has no open connection. */
class GuardedRepository extends BaseRepository<
  BaseEntity,
  FindOptionsWhere<BaseEntity>
> {
  /** Bind ORM metadata only; rejected calls must not require a database connection. */
  constructor() {
    super(database.getRepository(entity), {});
  }
  /** Supply the deliberately empty scope or test identity. */
  protected scopeWhere(
    scope: FindOptionsWhere<BaseEntity>,
  ): FindOptionsWhere<BaseEntity> {
    return scope;
  }
  /** No internal fields exist in this test entity. */
  protected toEntity(record: BaseEntity): BaseEntity {
    return record;
  }
}
test("all inherited operations reject an omitted ownership scope", async () => {
  const repository = new GuardedRepository();
  await assert.rejects(repository.getById({}, "entity"), /explicit scope/);
  await assert.rejects(repository.list({}), /explicit scope/);
  await assert.rejects(repository.delete({}, "entity"), /explicit scope/);
});
test("lookup and deletion reject missing identifiers instead of broadening the query", async () => {
  const repository = new GuardedRepository();
  for (const id of [undefined, null, ""] as unknown as string[]) {
    await assert.rejects(
      repository.getById({ createdAt: "date" }, id),
      /identifier/,
    );
    await assert.rejects(
      repository.delete({ createdAt: "date" }, id),
      /identifier/,
    );
  }
});
