import assert from "node:assert/strict";
import { test } from "node:test";
import type { PodMetricsList } from "@kubernetes/client-node";
import { KubernetesFleetResources } from "../adapter/kubernetes-fleet-resources.js";

test("reads only the installation namespace and sums CPU and memory across containers", async () => {
  const metrics: PodMetricsList = {
    kind: "PodMetricsList",
    apiVersion: "metrics.k8s.io/v1beta1",
    metadata: { selfLink: "" },
    items: [
      {
        metadata: {
          name: "fi-web-dev-0",
          namespace: "everything-fleet",
          selfLink: "",
          creationTimestamp: "",
        },
        timestamp: "",
        window: "30s",
        containers: [
          { name: "workspace", usage: { cpu: "125000000n", memory: "512Mi" } },
          { name: "sync", usage: { cpu: "25m", memory: "32768Ki" } },
        ],
      },
    ],
  };
  const resources = new KubernetesFleetResources(
    {
      /** Verify that the adapter never makes cluster-wide metrics requests. */
      async getPodMetrics(namespace) {
        assert.equal(namespace, "everything-fleet");
        return metrics;
      },
    },
    "everything-fleet",
  );
  const id = "k8s:cluster/everything-fleet/fi-web-dev@g2";
  const usage = await resources.read([
    id,
    "k8s:cluster/another-namespace/fi-web-dev@g1",
    "docker-id",
    "k8s:cluster/everything-fleet/missing@g1",
  ]);
  assert.deepEqual(
    [...usage],
    [[id, { cpuCores: 0.15, memoryBytes: 570425344 }]],
  );
});

test("unavailable metrics and unsupported backends remain unknown", async () => {
  let reads = 0;
  const resources = new KubernetesFleetResources(
    {
      /** Simulate a cluster without metrics-server. */
      async getPodMetrics() {
        reads++;
        throw new Error("metrics unavailable");
      },
    },
    "everything-fleet",
  );
  assert.equal(
    (await resources.read(["docker-id", "k8s:cluster/elsewhere/pod@g1"])).size,
    0,
  );
  assert.equal(reads, 0);
  assert.equal(
    (await resources.read(["k8s:cluster/everything-fleet/pod@g1"])).size,
    0,
  );
  assert.equal(reads, 1);
});
