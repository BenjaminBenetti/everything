import assert from "node:assert/strict";
import { test } from "node:test";
import type { V1Job, V1Pod } from "@kubernetes/client-node";
import { upgradeAttempt } from "../model/upgrade-attempt.js";
import {
  toVersionAnnotation,
  upgradeJobManifest,
  upgradeJobSelector,
} from "../model/upgrade-job-manifest.js";

/** The upgrader's pod as the API server returns it, with its injected service account volume. */
const upgrader: V1Pod = {
  metadata: {
    name: "upgrader-abc",
    labels: {
      app: "upgrader",
      "app.kubernetes.io/name": "upgrader",
      "app.kubernetes.io/part-of": "everything",
    },
  },
  spec: {
    serviceAccountName: "upgrader",
    securityContext: { runAsNonRoot: true, runAsUser: 1000 },
    containers: [
      {
        name: "upgrader",
        image: "ghcr.io/owner/everything/everything-upgrader:0.1.0",
        imagePullPolicy: "IfNotPresent",
        env: [
          {
            name: "CHART",
            value: "oci://ghcr.io/owner/everything/charts/everything",
          },
          { name: "UPGRADE_VERSION", value: "stale" },
        ],
        resources: { limits: { memory: "512Mi" } },
        securityContext: { readOnlyRootFilesystem: true },
        volumeMounts: [
          { name: "settings", mountPath: "/settings", readOnly: true },
          { name: "tmp", mountPath: "/tmp" },
          {
            name: "kube-api-access-x1",
            mountPath: "/var/run/secrets/kubernetes.io/serviceaccount",
            readOnly: true,
          },
        ],
      },
    ],
    volumes: [
      { name: "settings", secret: { secretName: "upgrade-settings" } },
      { name: "tmp", emptyDir: {} },
      { name: "kube-api-access-x1", projected: { sources: [] } },
    ],
  },
};

test("an upgrade Job runs the upgrader's image, account, and volumes with the version to install", () => {
  const job = upgradeJobManifest(
    upgrader,
    { fromVersion: "0.1.0", toVersion: "0.2.0" },
    "everything",
  );
  const pod = job.spec!.template.spec!;
  const container = pod.containers[0]!;
  assert.equal(job.metadata!.generateName, "everything-upgrade-");
  assert.equal(job.metadata!.annotations![toVersionAnnotation], "0.2.0");
  assert.equal(job.spec!.backoffLimit, 0);
  assert.equal(pod.restartPolicy, "Never");
  assert.equal(pod.serviceAccountName, "upgrader");
  assert.deepEqual(pod.securityContext, upgrader.spec!.securityContext);
  assert.equal(container.image, upgrader.spec!.containers[0]!.image);
  assert.equal(container.imagePullPolicy, "IfNotPresent");
  assert.deepEqual(container.command, [
    "node",
    "build/application/bootstrap/upgrade-job.js",
  ]);
  assert.deepEqual(container.env, [
    {
      name: "CHART",
      value: "oci://ghcr.io/owner/everything/charts/everything",
    },
    { name: "UPGRADE_VERSION", value: "0.2.0" },
  ]);
  assert.deepEqual(container.resources, { limits: { memory: "512Mi" } });
  assert.deepEqual(container.securityContext, { readOnlyRootFilesystem: true });
  // The API server gives the Job's pod its own token volume.
  assert.deepEqual(
    container.volumeMounts!.map((mount) => mount.name),
    ["settings", "tmp"],
  );
  assert.deepEqual(
    pod.volumes!.map((volume) => volume.name),
    ["settings", "tmp"],
  );
});

test("upgrade Jobs carry no app label, so the upgrader's Service never routes to them", () => {
  const job = upgradeJobManifest(
    upgrader,
    { fromVersion: "0.1.0", toVersion: "0.2.0" },
    "everything",
  );
  const labels = job.spec!.template.metadata!.labels!;
  assert.equal(labels.app, undefined);
  assert.equal(labels["app.kubernetes.io/name"], undefined);
  assert.equal(
    upgradeJobSelector("everything"),
    "app.kubernetes.io/instance=everything,app.kubernetes.io/component=upgrade",
  );
  assert.deepEqual(job.metadata!.labels, labels);
});

/** A recorded upgrade Job with the given status. */
function recorded(status: V1Job["status"]): V1Job {
  return {
    metadata: {
      creationTimestamp: new Date("2026-10-17T10:00:00Z"),
      annotations: {
        "everything/upgrade-from": "0.1.0",
        "everything/upgrade-to": "0.2.0",
      },
    },
    ...(status ? { status } : {}),
  };
}

test("a Job's conditions give the upgrade's outcome, with Helm's error when it failed", () => {
  assert.deepEqual(upgradeAttempt(recorded({ active: 1 }), undefined), {
    fromVersion: "0.1.0",
    toVersion: "0.2.0",
    state: "running",
    startedAt: "2026-10-17T10:00:00.000Z",
    finishedAt: null,
    failure: null,
  });
  const succeeded = upgradeAttempt(
    recorded({
      completionTime: new Date("2026-10-17T10:04:00Z"),
      conditions: [{ type: "Complete", status: "True" }],
    }),
    undefined,
  );
  assert.equal(succeeded!.state, "succeeded");
  assert.equal(succeeded!.finishedAt, "2026-10-17T10:04:00.000Z");
  const failed = upgradeAttempt(
    recorded({
      conditions: [
        {
          type: "Failed",
          status: "True",
          reason: "BackoffLimitExceeded",
          lastTransitionTime: new Date("2026-10-17T10:16:00Z"),
        },
      ],
    }),
    "\u001b[31mError: UPGRADE FAILED: context deadline exceeded\u001b[0m\n",
  );
  assert.equal(failed!.state, "failed");
  assert.equal(
    failed!.failure,
    "Error: UPGRADE FAILED: context deadline exceeded",
  );
  assert.match(
    upgradeAttempt(
      recorded({
        conditions: [
          { type: "Failed", status: "True", reason: "DeadlineExceeded" },
        ],
      }),
      undefined,
    )!.failure!,
    /longer than 30 minutes/,
  );
  assert.equal(upgradeAttempt({ metadata: {} }, undefined), null);
});
