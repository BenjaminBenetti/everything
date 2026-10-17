import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceStatefulSet } from "../adapter/kubernetes-workspace-pods.js";
import { HttpWorkspaceTools } from "../adapter/http-workspace-tools.js";
import { workspaceToken } from "../model/workspace-access.js";
import { workspaceLimits } from "@everything/workspace-contracts";

const id = "00000000-0000-4000-8000-000000000001";
const key = Buffer.alloc(32, 1).toString("base64");

test("oversized tools responses are cancelled before they can exhaust Everything's memory", async () => {
  let cancelled = false;
  const gateway = new HttpWorkspaceTools(
    "everything",
    key,
    async () =>
      new Response(
        new ReadableStream({
          /** Simulate a faulty pod ignoring the API's output limit. */
          start(controller) {
            controller.enqueue(
              new Uint8Array(workspaceLimits.readBytes * 6 + 4097),
            );
          },
          /** Observe that the gateway releases the upstream response. */
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await assert.rejects(gateway.read(id, { path: "note" }), {
    code: "WORKSPACE_UNAVAILABLE",
  });
  assert.equal(cancelled, true);
});

test("tools pods mount their workspace, shared folder and read-only SSH socket from one claim volume, preserve limits and receive no controller credential", () => {
  const source = {
    metadata: { labels: { "app.kubernetes.io/name": "teammate" } },
    spec: {
      containers: [
        {
          name: "teammate",
          image: "everything-teammate:test",
          resources: { limits: { memory: "512Mi", cpu: "1" } },
          env: [{ name: "WORKSPACE_DIRECTORY", value: "/workspace" }],
          volumeMounts: [
            { name: "workspace", mountPath: "/workspace" },
            { name: "shared", mountPath: "/workspace/shared" },
            { name: "ssh-agent", mountPath: "/run/ssh-agent", readOnly: true },
            { name: "private", mountPath: "/workspace/.pi", readOnly: true },
          ],
        },
      ],
      volumes: [
        { name: "workspace", emptyDir: {} },
        { name: "shared", emptyDir: {} },
        { name: "ssh-agent", emptyDir: {} },
        { name: "private", emptyDir: {} },
      ],
    },
  };
  const workload = workspaceStatefulSet(id, source, {
    namespace: "everything",
    templateName: "teammate",
    claimName: "everything-agents",
    key,
  });
  const spec = workload.spec!.template.spec!;
  assert.equal(workload.spec!.replicas, 1);
  assert.equal(spec.automountServiceAccountToken, false);
  assert.deepEqual(spec.containers[0]!.volumeMounts, [
    { name: "workspace", mountPath: `/workspace/${id}`, subPath: id },
    { name: "workspace", mountPath: "/workspace/shared", subPath: "shared" },
    {
      name: "workspace",
      mountPath: "/run/ssh-agent",
      subPath: ".ssh-agent",
      readOnly: true,
    },
    { name: "private", mountPath: `/workspace/${id}/.pi`, readOnly: true },
    {
      name: "account",
      mountPath: "/etc/passwd",
      subPath: "passwd",
      readOnly: true,
    },
  ]);
  const account = spec.initContainers![0]!;
  assert.equal(account.image, "everything-teammate:test");
  assert.deepEqual(account.env, [
    { name: "HOME_DIRECTORY", value: `/workspace/${id}` },
  ]);
  assert.match(account.command!.at(-1)!, /\/etc\/passwd > \/account\/passwd$/);
  // A single volume names the claim; a second one naming it can leave the pod waiting to mount.
  assert.deepEqual(spec.volumes, [
    {
      name: "workspace",
      persistentVolumeClaim: { claimName: "everything-agents" },
    },
    { name: "private", emptyDir: {} },
    { name: "account", emptyDir: { sizeLimit: "1Mi" } },
  ]);
  assert.deepEqual(
    spec.containers[0]!.env!.filter(
      (variable) => variable.name === "SSH_AUTH_SOCK",
    ),
    [{ name: "SSH_AUTH_SOCK", value: "/run/ssh-agent/agent.sock" }],
  );
  assert.deepEqual(
    spec.containers[0]!.env!.find(
      (variable) => variable.name === "WORKSPACE_DIRECTORY",
    ),
    { name: "WORKSPACE_DIRECTORY", value: `/workspace/${id}` },
  );
  assert.deepEqual(
    spec.containers[0]!.resources,
    source.spec.containers[0]!.resources,
  );
  assert.ok(!JSON.stringify(spec).includes(key));
  assert.notEqual(workspaceToken(key, id), workspaceToken(key, "different"));
  assert.equal(
    source.spec.containers[0]!.env.length,
    1,
    "template is not mutated",
  );
  assert.throws(() =>
    workspaceStatefulSet("../escape", source, {
      namespace: "everything",
      templateName: "teammate",
      claimName: "everything-agents",
      key,
    }),
  );
});

test("gateway fixes the destination and credential, propagates cancellation, and does not retry mutations", async () => {
  const abort = new AbortController();
  let calls = 0;
  const gateway = new HttpWorkspaceTools(
    "everything",
    key,
    async (url, init) => {
      calls++;
      assert.equal(
        String(url),
        `http://teammate-${id}.everything.svc.cluster.local:8080/files/write`,
      );
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${workspaceToken(key, id)}`,
      );
      assert.equal(init?.redirect, "error");
      assert.equal(init?.signal?.aborted, false);
      abort.abort();
      assert.equal(init?.signal?.aborted, true);
      throw new Error("connection closed");
    },
  );
  await assert.rejects(
    gateway.write(id, { path: "note", content: "one" }, abort.signal),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
  await assert.rejects(
    new HttpWorkspaceTools("everything", key, async () => {
      throw new Error("private transport error");
    }).read(id, { path: "note" }),
    { code: "WORKSPACE_UNAVAILABLE" },
  );
});
