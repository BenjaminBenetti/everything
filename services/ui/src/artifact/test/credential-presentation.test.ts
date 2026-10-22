import assert from "node:assert/strict";
import { test } from "node:test";
import type { SavedKey } from "@everything/key-contracts";
import {
  appCredentialStatuses,
  type CredentialUse,
} from "@everything/artifact-contracts/credential";
import {
  attachableCredentials,
  credentialFailureMessage,
  credentialStatusLabels,
  credentialVariableMessage,
  deletionOutcome,
  isSettledUsage,
  replacementOutcome,
  suggestedVariable,
} from "../model/credential-presentation.js";
import { HttpRequestError } from "../../http/model/http-request-error.js";

/** A saved key with the given fields. */
function key(changes: Partial<SavedKey>): SavedKey {
  return {
    id: changes.name ?? "key",
    name: "key",
    type: "generic",
    createdAt: "2026-10-22T00:00:00Z",
    ...changes,
  };
}

/** One app's use of a credential. */
function use(status: CredentialUse["status"]): CredentialUse {
  return { appId: "app", slug: "app", title: "App", env: "TOKEN", status };
}

test("every credential status has its own plain label", () => {
  const labels = appCredentialStatuses.map(
    (status) => credentialStatusLabels[status],
  );
  assert.equal(new Set(labels).size, appCredentialStatuses.length);
  assert.equal(credentialStatusLabels.applied, "In use");
  assert.equal(credentialStatusLabels.removing, "Removing");
});

test("only the user's own generic credentials that aren't being deleted can be attached, by name", () => {
  const keys = [
    key({ name: "zeta", owned: true }),
    key({ name: "alpha", owned: true }),
    key({ name: "theirs", owned: false }),
    key({ name: "gone", owned: true, status: "removing" }),
    key({ name: "ssh", type: "ssh", owned: true }),
  ];
  assert.deepEqual(
    attachableCredentials(keys).map(({ name }) => name),
    ["alpha", "zeta"],
  );
});

test("variable names are checked for syntax, length, and reserved names before sending", () => {
  assert.equal(credentialVariableMessage("SLACK_BOT_TOKEN"), undefined);
  assert.equal(credentialVariableMessage("_private"), undefined);
  assert.match(credentialVariableMessage("")!, /Enter the environment/);
  for (const invalid of ["1TOKEN", "SLACK-TOKEN", "A B", `T${"A".repeat(128)}`])
    assert.match(credentialVariableMessage(invalid)!, /letters, digits/);
  for (const reserved of [
    "PORT",
    "BASE_PATH",
    "DATABASE_URL",
    "APP_API_KEY",
    "PGPASSWORD",
    "EVERYTHING_TOKEN",
    "KUBERNETES_SERVICE_HOST",
  ])
    assert.match(credentialVariableMessage(reserved)!, /Everything sets/);
});

test("suggested variable names follow the credential's name and avoid reserved ones", () => {
  assert.equal(suggestedVariable("slack-bot-token"), "SLACK_BOT_TOKEN");
  assert.equal(suggestedVariable("  Stripe key (live) "), "STRIPE_KEY_LIVE");
  assert.equal(suggestedVariable("3scale"), "_3SCALE");
  assert.equal(suggestedVariable("pg password"), "");
  assert.equal(suggestedVariable("---"), "");
});

test("failures are described from the error code only, never the server's text", () => {
  assert.match(
    credentialFailureMessage(
      new HttpRequestError(409, "generic", "KEY_NAME_TAKEN"),
    ),
    /already uses this name/,
  );
  assert.match(
    credentialFailureMessage(
      new HttpRequestError(400, "generic", "RESERVED_CREDENTIAL_VARIABLE"),
    ),
    /sets this variable name/,
  );
  assert.match(
    credentialFailureMessage(new HttpRequestError(403, "generic")),
    /Only the account that added it/,
  );
  assert.equal(
    credentialFailureMessage(new HttpRequestError(500, "Please try again.")),
    "Please try again.",
  );
  assert.doesNotMatch(
    credentialFailureMessage(new Error("sentinel-secret leaked")),
    /sentinel/,
  );
});

test("outcomes never claim an app is done while it is still restarting or unreachable", () => {
  assert.equal(isSettledUsage([use("applied"), use("stopped")]), true);
  assert.equal(isSettledUsage([use("applied"), use("pending")]), false);
  assert.match(
    replacementOutcome({
      complete: true,
      usage: { apps: [use("pending")], otherApps: 0 },
    }),
    /restarting/,
  );
  assert.match(
    replacementOutcome({
      complete: true,
      usage: { apps: [use("applied")], otherApps: 0 },
    }),
    /Every app now uses/,
  );
  assert.match(
    replacementOutcome({ complete: false, usage: null }),
    /couldn’t reach your apps/,
  );
  assert.match(
    deletionOutcome({ complete: true, usage: { apps: [], otherApps: 0 } }),
    /No app receives it/,
  );
  assert.match(
    deletionOutcome({
      complete: false,
      usage: { apps: [use("removing")], otherApps: 1 },
    }),
    /still being removed from 2 apps/,
  );
  assert.match(
    deletionOutcome({ complete: false, usage: null }),
    /keeps trying/,
  );
});
