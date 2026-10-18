import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseAllDocuments } from "yaml";

/** The chart that deploys Everything, rendered as cluster:up and the installer render it. */
const chart = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../deployment/helm",
);

/** Where Everything reaches the speech service the chart deploys. */
const streamUrl = "ws://voice-asr.everything.svc.cluster.local:8080/v1/stream";

/** The model path the init container fills and the service reads. */
const modelPath = "/models/nemotron-speech-streaming-en-0.6b.q8_0.gguf";

/** One environment variable of a rendered container. */
interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef: { name: string; key: string } };
}

/** The parts of a rendered container these checks read. */
interface Container {
  name: string;
  image: string;
  imagePullPolicy: string;
  command?: string[];
  restartPolicy?: string;
  env?: EnvVar[];
  securityContext: Record<string, unknown>;
  volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[];
  readinessProbe?: { httpGet: { path: string } };
  livenessProbe?: { httpGet: { path: string } };
  resources?: { limits: Record<string, string> };
}

/** The parts of a rendered manifest these checks read. */
interface Manifest {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec: {
    type?: string;
    ports?: { name: string; port: number }[];
    replicas?: number;
    strategy?: { type: string };
    rules?: {
      http: { paths: { backend: { service: { name: string } } }[] };
    }[];
    template?: {
      spec: {
        automountServiceAccountToken: boolean;
        nodeSelector?: Record<string, string>;
        securityContext: Record<string, unknown>;
        initContainers?: Container[];
        containers: Container[];
        volumes: {
          name: string;
          persistentVolumeClaim?: { claimName: string };
        }[];
      };
    };
  };
}

/** Render the chart with the development credentials, then the given values files and settings. */
async function render(...args: string[]): Promise<Manifest[]> {
  const { stdout } = await promisify(execFile)(
    "helm",
    [
      "template",
      "everything",
      chart,
      "--namespace",
      "everything",
      "--values",
      path.join(chart, "values.dev.yaml"),
      ...args,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return parseAllDocuments(stdout)
    .map((document) => document.toJS() as Manifest | null)
    .filter((manifest): manifest is Manifest => !!manifest);
}

/** The manifest of a kind and name, or undefined. */
function find(manifests: Manifest[], kind: string, name: string) {
  return manifests.find(
    (manifest) => manifest.kind === kind && manifest.metadata.name === name,
  );
}

/** Every value Everything's API container is given for a variable. */
function everythingEnv(manifests: Manifest[], variable: string): EnvVar[] {
  const everything = find(manifests, "StatefulSet", "everything");
  const api = everything!.spec.template!.spec.containers.find(
    (container) => container.name === "api",
  )!;
  return (api.env ?? []).filter((entry) => entry.name === variable);
}

/** The value of a container's variable. */
function envValue(container: Container, variable: string) {
  return container.env?.find((entry) => entry.name === variable);
}

test("the chart runs one private speech service by default and connects voice input to it", async () => {
  const manifests = await render();
  const deployment = find(manifests, "Deployment", "voice-asr");
  assert.ok(deployment, "the speech service is deployed by default");
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy?.type, "Recreate");
  const pod = deployment.spec.template!.spec;
  assert.deepEqual(pod.nodeSelector, { "kubernetes.io/arch": "amd64" });
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.securityContext.runAsUser, 10001);

  // The init container downloads or checks the pinned model before the service starts.
  const [init, ...otherInits] = pod.initContainers ?? [];
  assert.equal(otherInits.length, 0);
  assert.equal(init!.name, "model");
  assert.equal(init!.image, "everything-voice-asr:foundation");
  assert.deepEqual(init!.command, ["python", "-m", "voice_asr.provision"]);
  assert.equal(init!.restartPolicy, undefined, "it runs to completion");
  assert.equal(envValue(init!, "VOICE_ASR_MODEL_PATH")?.value, modelPath);
  assert.equal(
    envValue(init!, "VOICE_ASR_MODEL_LICENSE")?.value,
    "NVIDIA-Open-Model-License",
  );
  assert.deepEqual(init!.volumeMounts, [
    { name: "models", mountPath: "/models" },
  ]);

  // The service reads the model from the same volume, which it cannot change.
  const [service] = pod.containers;
  assert.equal(service!.image, "everything-voice-asr:foundation");
  assert.equal(envValue(service!, "VOICE_ASR_MODEL_PATH")?.value, modelPath);
  assert.deepEqual(
    service!.volumeMounts?.find((mount) => mount.name === "models"),
    { name: "models", mountPath: "/models", readOnly: true },
  );
  for (const container of [init!, service!]) {
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.deepEqual(container.securityContext.capabilities, {
      drop: ["ALL"],
    });
  }
  // Its optional token stays unset rather than blank, which would stop it starting.
  assert.equal(envValue(service!, "VOICE_ASR_TOKEN"), undefined);
  assert.equal(envValue(service!, "VOICE_ASR_TOKEN_FILE"), undefined);
  assert.equal(service!.readinessProbe?.httpGet.path, "/readyz");
  assert.equal(service!.livenessProbe?.httpGet.path, "/healthz");
  assert.equal(service!.resources?.limits.memory, "3Gi");
  assert.deepEqual(
    pod.volumes.find((volume) => volume.name === "models"),
    {
      name: "models",
      persistentVolumeClaim: { claimName: "voice-asr-models" },
    },
  );
  const claim = find(manifests, "PersistentVolumeClaim", "voice-asr-models");
  assert.equal(
    claim?.metadata.annotations?.["helm.sh/resource-policy"],
    "keep",
  );

  // Reachable only inside the cluster: a ClusterIP Service and no Ingress path.
  const exposed = find(manifests, "Service", "voice-asr");
  assert.equal(exposed?.spec.type, undefined);
  assert.deepEqual(
    exposed?.spec.ports?.map(({ name, port }) => ({ name, port })),
    [{ name: "http", port: 8080 }],
  );
  const routed = manifests
    .filter((manifest) => manifest.kind === "Ingress")
    .flatMap((ingress) => ingress.spec.rules ?? [])
    .flatMap((rule) => rule.http.paths)
    .map((route) => route.backend.service.name);
  assert.ok(!routed.includes("voice-asr"));

  assert.deepEqual(everythingEnv(manifests, "VOICE_STREAM_URL"), [
    { name: "VOICE_STREAM_URL", value: streamUrl },
  ]);
  assert.deepEqual(everythingEnv(manifests, "VOICE_STREAM_TOKEN"), []);
});

test("a released installation runs the speech service's released image", async () => {
  const manifests = await render(
    "--values",
    path.join(chart, "values.prod.yaml"),
  );
  const pod = find(manifests, "Deployment", "voice-asr")!.spec.template!.spec;
  for (const container of [...pod.initContainers!, ...pod.containers]) {
    assert.match(
      container.image,
      /^ghcr\.io\/benjaminbenetti\/everything\/everything-voice-asr:\d+\.\d+\.\d+/,
    );
    assert.equal(container.imagePullPolicy, "IfNotPresent");
  }
});

test("turning the speech service off removes it and turns streaming voice input off", async () => {
  const manifests = await render("--set", "services.voice-asr.enabled=false");
  for (const kind of ["Deployment", "Service"]) {
    assert.equal(find(manifests, kind, "voice-asr"), undefined);
  }
  assert.equal(
    find(manifests, "PersistentVolumeClaim", "voice-asr-models"),
    undefined,
  );
  // Empty means unavailable, so the composer falls back to uploads when they are configured.
  assert.deepEqual(everythingEnv(manifests, "VOICE_STREAM_URL"), [
    { name: "VOICE_STREAM_URL", value: "" },
  ]);
});

test("operators can point voice input elsewhere and add a token without duplicate settings", async () => {
  const manifests = await render(
    "--set",
    "services.everything.env.VOICE_STREAM_URL=ws://speech.example.test:8080/v1/stream",
    "--set",
    "services.everything.env.VOICE_STREAM_TOKEN.secretName=voice-auth",
    "--set",
    "services.everything.env.VOICE_STREAM_TOKEN.key=token",
    "--set",
    "services.voice-asr.env.VOICE_ASR_TOKEN.secretName=voice-auth",
    "--set",
    "services.voice-asr.env.VOICE_ASR_TOKEN.key=token",
  );
  assert.deepEqual(everythingEnv(manifests, "VOICE_STREAM_URL"), [
    {
      name: "VOICE_STREAM_URL",
      value: "ws://speech.example.test:8080/v1/stream",
    },
  ]);
  const token = { secretKeyRef: { name: "voice-auth", key: "token" } };
  assert.deepEqual(everythingEnv(manifests, "VOICE_STREAM_TOKEN"), [
    { name: "VOICE_STREAM_TOKEN", valueFrom: token },
  ]);
  const [service] = find(manifests, "Deployment", "voice-asr")!.spec.template!
    .spec.containers;
  assert.deepEqual(envValue(service!, "VOICE_ASR_TOKEN"), {
    name: "VOICE_ASR_TOKEN",
    valueFrom: token,
  });
});
