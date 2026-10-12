import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { FileSystemWorkspaces } from "../service/file-system-workspaces.js";
import { WorkspaceReconciler } from "../service/workspace-reconciler.js";
import type { WorkspaceTarget } from "../model/workspace-target.js";

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";

/** Model durable desired state independently from a disposable cluster. */
async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-reconcile-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const desired = new Map<string, WorkspaceTarget>(
    [first, second].map((id) => [
      id,
      { id, ownerId: "owner", createdAt: new Date().toISOString() },
    ]),
  );
  const pods = new Set<string>();
  const failures: unknown[] = [];
  const files = new FileSystemWorkspaces(root);
  let broken: string | undefined;
  let lists = 0;
  const source = {
    /** Read persisted teammate identities. */
    async list() {
      lists++;
      return [...desired.values()];
    },
    /** Recheck existence after obtaining the per-teammate lock. */
    async getById(_scope: unknown, id: string) {
      return desired.get(id);
    },
  };
  const orchestrator = {
    /** Observe only controller-owned workloads. */
    async list() {
      return [...pods];
    },
    /** Simulate idempotent creation and transient per-teammate failures. */
    async ensure(id: string) {
      if (id === broken) throw new Error("cluster unavailable");
      pods.add(id);
    },
    /** Remove infrastructure before files. */
    async remove(id: string) {
      if (id === broken) throw new Error("cluster unavailable");
      pods.delete(id);
    },
  };
  const reconciler = new WorkspaceReconciler(
    source,
    orchestrator,
    files,
    (id) => failures.push(id),
  );
  context.after(() => reconciler.close());
  return {
    desired,
    pods,
    files,
    failures,
    reconciler,
    source,
    orchestrator,
    /** Choose the identity whose infrastructure calls fail. */
    fail(id?: string) {
      broken = id;
    },
    /** Observe pass coalescing. */
    lists() {
      return lists;
    },
  };
}

test("creates pods for all saved teammates, restores missing workloads, and preserves files on shutdown", async (context) => {
  const f = await fixture(context);
  await Promise.all([f.reconciler.refresh(), f.reconciler.refresh()]);
  assert.equal(f.lists(), 1);
  assert.deepEqual(f.pods, new Set([first, second]));
  f.pods.delete(first);
  await f.reconciler.refresh();
  assert.ok(f.pods.has(first));
  await f.reconciler.close();
  assert.deepEqual(f.pods, new Set([first, second]));
  assert.deepEqual((await f.files.list()).sort(), [first, second]);
});

test("one failure does not block other teammates and later passes retry both creation and deletion", async (context) => {
  const f = await fixture(context);
  f.fail(first);
  await f.reconciler.refresh();
  assert.deepEqual(f.pods, new Set([second]));
  f.fail();
  await f.reconciler.refresh();
  f.desired.delete(first);
  f.fail(first);
  await f.reconciler.remove(first);
  assert.ok(f.pods.has(first));
  f.fail();
  await f.reconciler.refresh();
  assert.deepEqual(f.pods, new Set([second]));
  assert.deepEqual(await f.files.list(), [second]);
});

test("stale listings do not recreate deleted teammates and directory-only orphans are cleaned", async (context) => {
  const f = await fixture(context);
  await f.reconciler.refresh();
  const originalList = f.orchestrator.list;
  f.orchestrator.list = async () => {
    f.desired.delete(first);
    f.pods.delete(first);
    return originalList();
  };
  await f.reconciler.refresh();
  assert.equal(f.pods.has(first), false);
  assert.deepEqual(await f.files.list(), [second]);
});
