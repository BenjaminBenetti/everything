import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArtifactDetails } from "@everything/artifact-contracts";
import type {
  AppCredentialGrant,
  CredentialAppUse,
} from "@everything/artifact-contracts/credential";
import { SessionCipher } from "@everything/security/session-cipher";
import { ArtifactRequestFailure } from "../../artifact/error/artifact-errors.js";
import type { GenericCredentialRepository } from "../../key/interface/generic-credential-repository.js";
import type { StoredKey } from "../../key/model/stored-key.js";
import { CredentialGrants } from "../service/credential-grants.js";

const cipher = new SessionCipher(Buffer.alloc(32, 3).toString("base64"));
const sentinel = "cg-sentinel-\nline 2 $X 🔑";
const appId = "89bb2d67-090d-405a-84f8-880d9231c9c2";

/** A stored generic credential. */
async function credential(
  id: string,
  name: string,
  ownerId: string,
  changes: Partial<StoredKey> = {},
): Promise<StoredKey> {
  return {
    id,
    name,
    ownerId,
    type: "generic",
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    encryptedMaterial: await cipher.seal(sentinel),
    description: null,
    version: 3,
    deletedAt: null,
    ...changes,
  };
}

/** Grants over credentials in memory, with the repository's scoping, and a recording gateway. */
async function fixture() {
  const records = [
    await credential(
      "11111111-1111-4111-8111-111111111111",
      "slack-bot-token",
      "owner",
    ),
    await credential(
      "22222222-2222-4222-8222-222222222222",
      "other-token",
      "other-owner",
    ),
    await credential(
      "33333333-3333-4333-8333-333333333333",
      "deleted-token",
      "owner",
      {
        encryptedMaterial: "",
        deletedAt: "2026-10-22T01:00:00.000Z",
      },
    ),
    await credential(
      "44444444-4444-4444-8444-444444444444",
      "broken",
      "owner",
      {
        encryptedMaterial: "not-a-jwe",
      },
    ),
  ];
  const repository: Pick<
    GenericCredentialRepository,
    "findByName" | "getById" | "list"
  > = {
    async findByName(scope, name) {
      return records.filter(
        (record) =>
          record.ownerId === scope.ownerId &&
          !record.deletedAt &&
          record.name.toLowerCase() === name.toLowerCase(),
      );
    },
    async getById(scope, id) {
      return records.find(
        (record) =>
          record.id === id &&
          (scope.usage === "credential-sync" ||
            (record.ownerId === scope.ownerId && !record.deletedAt)),
      );
    },
    async list(scope) {
      return records.filter(
        (record) =>
          scope.usage === "credential-sync" ||
          (record.ownerId === scope.ownerId && !record.deletedAt),
      );
    },
  };
  const attached: unknown[] = [];
  const uses: CredentialAppUse[] = [];
  const refusals: Error[] = [];
  const details = (credentials: ArtifactDetails["credentials"]) =>
    ({ credentials }) as ArtifactDetails;
  const grants = new CredentialGrants(repository, cipher, {
    async attachCredential(actor, reference, grant: AppCredentialGrant) {
      if (refusals.length) throw refusals.shift();
      attached.push([actor, reference, grant]);
      return details([
        {
          credentialId: grant.credentialId,
          name: null,
          env: grant.env,
          version: grant.version,
          status: "pending",
        },
      ]);
    },
    async detachCredential(actor, reference, env) {
      attached.push([actor, reference, env]);
      return details([]);
    },
    async credentialUses() {
      return uses;
    },
  });
  return { attached, grants, records, refusals, uses };
}

test("teammates' named requests resolve, case-insensitively, among their owner's credentials to stable IDs", async () => {
  const { grants, records } = await fixture();
  const resolved = await grants.resolve("owner", [
    { name: " Slack-Bot-Token ", env: "SLACK_BOT_TOKEN" },
  ]);
  assert.deepEqual(resolved, [
    {
      credentialId: records[0]!.id,
      env: "SLACK_BOT_TOKEN",
      version: 3,
      value: sentinel,
    },
  ]);
});

test("missing, foreign, deleted, and undecryptable credentials are refused without leaking them", async () => {
  const { grants } = await fixture();
  for (const [name, code] of [
    ["missing", "CREDENTIAL_NOT_FOUND"],
    ["other-token", "CREDENTIAL_NOT_FOUND"],
    ["deleted-token", "CREDENTIAL_NOT_FOUND"],
    ["broken", "CREDENTIAL_UNAVAILABLE"],
  ] as const) {
    const error = await grants.resolve("owner", [{ name, env: "TOKEN" }]).then(
      () => assert.fail("resolved"),
      (failure: Error & { code: string }) => failure,
    );
    assert.equal(error.code, code, name);
    assert.ok(!error.message.includes("cg-sentinel"));
    assert.ok(!error.message.includes("other-owner"));
  }
});

test("variables are checked before any credential is looked up or decrypted", async () => {
  const { grants } = await fixture();
  for (const [env, code] of [
    ["PORT", "RESERVED_CREDENTIAL_VARIABLE"],
    ["PGPASSWORD", "RESERVED_CREDENTIAL_VARIABLE"],
    ["EVERYTHING_TOKEN", "RESERVED_CREDENTIAL_VARIABLE"],
    ["KUBERNETES_PORT", "RESERVED_CREDENTIAL_VARIABLE"],
    ["9LIVES", "INVALID_CREDENTIAL_VARIABLE"],
  ] as const)
    await assert.rejects(grants.resolve("owner", [{ name: "missing", env }]), {
      code,
    });
  await assert.rejects(
    grants.resolve("owner", [
      { name: "slack-bot-token", env: "TOKEN" },
      { name: "slack-bot-token", env: "TOKEN" },
    ]),
    { code: "DUPLICATE_CREDENTIAL_VARIABLE" },
  );
  await assert.rejects(
    grants.resolve(
      "owner",
      Array.from({ length: 17 }, (_, index) => ({
        name: "slack-bot-token",
        env: `TOKEN_${index}`,
      })),
    ),
    { code: "TOO_MANY_CREDENTIALS" },
  );
});

test("users attach only credentials they added, never through an app's own token", async () => {
  const { attached, grants, records, refusals } = await fixture();
  const owner = { subject: "owner" };
  const list = await grants.attach(owner, appId, {
    credentialId: records[0]!.id,
    env: "SLACK_BOT_TOKEN",
  });
  assert.deepEqual(list.credentials, [
    {
      credentialId: records[0]!.id,
      name: "slack-bot-token",
      env: "SLACK_BOT_TOKEN",
      version: 3,
      status: "pending",
    },
  ]);
  assert.ok(!JSON.stringify(list).includes("cg-sentinel"));
  assert.deepEqual(attached[0], [
    { ownerId: "owner", author: { id: "owner", name: "You" } },
    appId,
    {
      credentialId: records[0]!.id,
      env: "SLACK_BOT_TOKEN",
      version: 3,
      value: sentinel,
    },
  ]);
  await assert.rejects(
    grants.attach({ subject: "other-owner" }, appId, {
      credentialId: records[0]!.id,
      env: "TOKEN",
    }),
    { code: "CREDENTIAL_OWNER_ONLY" },
  );
  await assert.rejects(
    grants.attach({ subject: "owner", app: appId }, appId, {
      credentialId: records[0]!.id,
      env: "TOKEN",
    }),
    { code: "APP_CREDENTIAL_ACCESS_FORBIDDEN" },
  );
  await assert.rejects(
    grants.detach({ subject: "owner", app: appId }, appId, "TOKEN"),
    { code: "APP_CREDENTIAL_ACCESS_FORBIDDEN" },
  );
  await assert.rejects(
    grants.attach(owner, appId, { credentialId: records[2]!.id, env: "TOKEN" }),
    { code: "KEY_NOT_FOUND" },
  );
  refusals.push(
    new ArtifactRequestFailure(
      409,
      "CREDENTIAL_VARIABLE_CONFLICT",
      "TOKEN is both an ordinary variable and a credential of this app.",
    ),
    new ArtifactRequestFailure(409, "SOMETHING_ELSE", "Refused."),
    new ArtifactRequestFailure(404, "ARTIFACT_NOT_FOUND", "App not found."),
    new ArtifactRequestFailure(502, "BAD_GATEWAY", "Down."),
  );
  for (const code of [
    "CREDENTIAL_VARIABLE_CONFLICT",
    "CREDENTIAL_CHANGE_REFUSED",
    "ARTIFACT_NOT_FOUND",
    "ARTIFACTS_UNAVAILABLE",
  ])
    await assert.rejects(
      grants.attach(owner, appId, {
        credentialId: records[0]!.id,
        env: "TOKEN",
      }),
      { code },
    );
});

test("usage shows the caller's own apps and only counts other accounts' apps", async () => {
  const { grants, records, uses } = await fixture();
  uses.push(
    {
      ownerId: "owner",
      artifactId: appId,
      slug: "bot",
      title: "Bot",
      env: "SLACK_BOT_TOKEN",
      version: 3,
      status: "applied",
    },
    {
      ownerId: "other-owner",
      artifactId: "99999999-9999-4999-8999-999999999999",
      slug: "secret-project",
      title: "Secret project",
      env: "TOKEN",
      version: 3,
      status: "applied",
    },
  );
  const usage = await grants.usage({ subject: "owner" }, records[0]!.id);
  assert.deepEqual(usage, {
    apps: [
      {
        appId,
        slug: "bot",
        title: "Bot",
        env: "SLACK_BOT_TOKEN",
        status: "applied",
      },
    ],
    otherApps: 1,
  });
  assert.ok(!JSON.stringify(usage).includes("secret-project"));
});
