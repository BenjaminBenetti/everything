import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** The chart, rendered as cluster:up, the installer, and in-app upgrades render it. */
const chart = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../deployment/helm",
);

/** Development values; a remote cluster's production values and settings; and an upgrade of it. */
const layouts: { name: string; args: string[] }[] = [
  { name: "development", args: ["--values", "values.dev.yaml"] },
  {
    name: "remote cluster",
    args: [
      "--values",
      "values.dev.yaml",
      "--values",
      "values.prod.yaml",
      "--values",
      "ci/remote-cluster-settings.yaml",
    ],
  },
  {
    name: "remote cluster upgrade",
    args: [
      "--values",
      "values.dev.yaml",
      "--values",
      "values.prod.yaml",
      "--values",
      "ci/remote-cluster-settings.yaml",
      "--is-upgrade",
    ],
  },
];

/** The rendered documents, as text; the checks read only lines Helm's toYaml writes the same way. */
async function render(args: string[]): Promise<string[]> {
  const { stdout } = await promisify(execFile)(
    "helm",
    [
      "template",
      "everything",
      chart,
      "--namespace",
      "everything",
      ...args.map((arg) =>
        arg.endsWith(".yaml") ? path.join(chart, arg) : arg,
      ),
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout.split(/^---$/m).filter((document) => /^kind: /m.test(document));
}

/** The one document of a kind and name. */
function find(documents: string[], kind: string, name: string): string {
  const found = documents.filter(
    (document) =>
      document.includes(`\nkind: ${kind}\n`) &&
      new RegExp(`^metadata:\\n(?:  #.*\\n)*  name: ${name}\\n`, "m").test(
        document,
      ),
  );
  assert.equal(found.length, 1, `the chart renders one ${kind} ${name}`);
  return found[0]!;
}

/** A realm client, as far as these checks read it. */
interface Client {
  clientId: string;
  defaultClientScopes?: string[];
  optionalClientScopes?: string[];
}

/** The realm Keycloak imports on a fresh installation. */
function realm(documents: string[]): {
  clients: Client[];
  users: { username: string; clientRoles?: Record<string, string[]> }[];
  [setting: string]: unknown;
} {
  const encoded = find(documents, "Secret", "keycloak-realm").match(
    /^  everything-realm\.json: "([A-Za-z0-9+/=]+)"$/m,
  );
  assert.ok(encoded, "the realm Secret holds the realm import");
  return JSON.parse(Buffer.from(encoded[1]!, "base64").toString("utf8"));
}

for (const layout of layouts)
  test(`a fresh realm gives only the app provisioner the Admin REST API scope, keeping its other scopes (${layout.name})`, async () => {
    const imported = realm(await render(layout.args));
    const provisioner = imported.clients.find(
      (client) => client.clientId === "everything-app-provisioner",
    );
    assert.ok(provisioner);
    // Keycloak 26.8.2's import replaces a client's scopes with the lists it names, so they keep the
    // defaults Keycloak gives every other client, plus kc-admin-api.
    assert.deepEqual(provisioner.defaultClientScopes, [
      "web-origins",
      "acr",
      "profile",
      "roles",
      "basic",
      "email",
      "kc-admin-api",
    ]);
    assert.deepEqual(provisioner.optionalClientScopes, [
      "address",
      "phone",
      "organization",
      "offline_access",
      "microprofile-jwt",
    ]);
    for (const client of imported.clients.filter(
      (other) => other !== provisioner,
    )) {
      assert.equal(
        client.defaultClientScopes,
        undefined,
        `${client.clientId} keeps Keycloak's default scopes`,
      );
      assert.equal(
        client.optionalClientScopes,
        undefined,
        `${client.clientId} keeps Keycloak's optional scopes`,
      );
    }
    // No realm-wide default scope, and no copy of Keycloak's built-in scopes or their mappers.
    for (const setting of [
      "clientScopes",
      "defaultDefaultClientScopes",
      "defaultOptionalClientScopes",
    ])
      assert.equal(imported[setting], undefined, setting);
    // The scope adds an audience; what the provisioner may do is still only manage-clients.
    assert.deepEqual(
      imported.users.find(
        (user) =>
          user.username === "service-account-everything-app-provisioner",
      )?.clientRoles,
      { "realm-management": ["manage-clients"] },
    );
  });

for (const layout of layouts)
  test(`each Keycloak start gives an existing realm's provisioner the scope, from Keycloak's own container (${layout.name})`, async () => {
    const documents = await render(layout.args);
    const keycloak = find(documents, "Deployment", "keycloak");
    assert.ok(
      keycloak.includes(
        [
          "          lifecycle:",
          "            postStart:",
          "              exec:",
          "                command:",
          "                - /opt/keycloak/bin/provision-app-client.sh",
          "                - --admin-api-scope",
          "                - --post-start",
          "",
        ].join("\n"),
      ),
      "Keycloak's container runs the scope migration when it starts",
    );
    // It uses the container's own environment: no Kubernetes API token, account, or new Secret.
    assert.match(keycloak, /^      automountServiceAccountToken: false$/m);
    assert.doesNotMatch(keycloak, /serviceAccountName:/);
    assert.equal(
      documents.filter((document) => /^ *lifecycle:$/m.test(document)).length,
      1,
      "only Keycloak has a lifecycle hook",
    );
    // In-app upgrades may create Jobs but not delete or watch them, so the chart has no Helm hooks.
    for (const document of documents) {
      assert.doesNotMatch(document, /helm\.sh\/hook/);
      assert.doesNotMatch(document, /^kind: (Job|CronJob)$/m);
    }
  });
