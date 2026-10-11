import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryFailedError, type EntityManager } from "typeorm";
import { serializableTransaction } from "../service/serializable-transaction.js";
/** Simulate rolled-back transactions while asserting use of serializable isolation. */
function fixture(failures: Error[]) {
  let attempts = 0;
  const manager = {
    /** Fail selected attempts before running the transaction callback. */
    async transaction<T>(
      isolation: string,
      callback: (manager: EntityManager) => Promise<T>,
    ): Promise<T> {
      assert.equal(isolation, "SERIALIZABLE");
      const failure = failures[attempts++];
      if (failure) throw failure;
      return callback(manager as unknown as EntityManager);
    },
  };
  return {
    manager: manager as unknown as EntityManager,
    /** Read the number of transaction attempts. */ attempts: () => attempts,
  };
}
/** Construct the database error shape emitted by TypeORM. */
function failure(code: string): Error {
  return new QueryFailedError(
    "test operation",
    [],
    Object.assign(new Error("database conflict"), { code }),
  );
}
test("retries rolled-back serialization and deadlock conflicts", async () => {
  const f = fixture([failure("40001"), failure("40P01")]);
  assert.equal(
    await serializableTransaction(f.manager, async () => "committed"),
    "committed",
  );
  assert.equal(f.attempts(), 3);
});
test("does not replay ambiguous connection failures, constraint violations, or application errors", async () => {
  for (const error of [
    failure("08006"),
    failure("23505"),
    new Error("invalid input"),
  ]) {
    const f = fixture([error]);
    await assert.rejects(
      serializableTransaction(f.manager, async () => "must not run"),
      error,
    );
    assert.equal(f.attempts(), 1);
  }
});
