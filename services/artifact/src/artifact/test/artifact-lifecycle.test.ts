import assert from "node:assert/strict";
import { test } from "node:test";
import { ArtifactLifecycleService } from "../service/artifact-lifecycle-service.js";
import { ArtifactLookup } from "../service/artifact-lookup.js";
import { ArtifactLock } from "../service/artifact-lock.js";
import type { Artifact } from "../model/artifact.js";
import { representSummary } from "../presenter/artifact-presenter.js";
import { MemoryArtifacts, ada, owner } from "./artifact-fixture.js";

/** Supply scoped storage and record every runtime reconciliation. */
function fixture() {
  const artifacts = new MemoryArtifacts();
  const reconciled: Artifact[] = [];
  const lifecycle = new ArtifactLifecycleService(
    artifacts,
    new ArtifactLookup(artifacts),
    new ArtifactLock(),
    {
      /** Record the saved desired state applied to the runtime. */
      async reconcile(app) {
        reconciled.push(app);
      },
    },
  );
  return { artifacts, reconciled, lifecycle };
}

test("pause and resume preserve the deployed release, disk, and revision history", async () => {
  const { artifacts, lifecycle, reconciled } = fixture();
  const original = artifacts.add("dynamic", "planner", {
    release: 7,
    liveDeployment: 7,
    diskGi: 2,
    running: true,
  });
  const stopped = await lifecycle.stop(owner, ada, original.id);
  assert.equal(stopped.running, false);
  const user = { id: owner, name: "You" };
  const started = await lifecycle.start(owner, user, original.id);
  assert.equal(started.running, true);
  assert.equal(started.release, 7);
  assert.equal(started.liveDeployment, 7);
  assert.equal(started.diskGi, 2);
  assert.deepEqual(started.updatedBy, user);
  assert.deepEqual(
    reconciled.map((app) => app.running),
    [false, true],
  );
  const repeated = await lifecycle.start(owner, ada, original.id);
  assert.equal(repeated, started, "retries do not create edits or releases");
});

test("published pages pause and resume without losing their published revision", async () => {
  const { artifacts, lifecycle } = fixture();
  artifacts.add("static", "report", {
    liveRevision: 3,
    release: 5,
    running: true,
  });
  const stopped = await lifecycle.stop(owner, ada, "report");
  assert.equal(
    representSummary(stopped, undefined, "http://apps.test", undefined).status,
    "stopped",
  );
  const started = await lifecycle.start(owner, ada, "report");
  assert.equal(
    representSummary(started, undefined, "http://apps.test", undefined).status,
    "live",
  );
  assert.equal(started.liveRevision, 3);
  assert.equal(started.release, 5);
});

test("unpublished apps cannot start and missing or inaccessible apps behave identically", async () => {
  const { artifacts, lifecycle, reconciled } = fixture();
  for (const kind of ["static", "dynamic"] as const) {
    const app = artifacts.add(kind, kind);
    await assert.rejects(lifecycle.start(owner, ada, app.id), {
      code: "APP_NOT_PUBLISHED",
    });
    for (const action of ["start", "stop"] as const) {
      await assert.rejects(lifecycle[action]("other-owner", ada, app.id), {
        code: "ARTIFACT_NOT_FOUND",
      });
      await assert.rejects(lifecycle[action](owner, ada, "missing"), {
        code: "ARTIFACT_NOT_FOUND",
      });
    }
  }
  assert.equal(reconciled.length, 0);
});
