import assert from "node:assert/strict";
import { test } from "node:test";
import {
  everythingAppClaims,
  everythingAppClientId,
} from "@everything/artifact-contracts/everything-api";
import { appIdentity } from "../service/app-identity.js";

const appId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";
const identity = { subject: "app-service-account" };
const claims = {
  azp: everythingAppClientId(appId),
  [everythingAppClaims.owner]: "owner",
  [everythingAppClaims.app]: appId,
};

test("provisioned app tokens use their signed owner's scope", () => {
  assert.deepEqual(appIdentity(identity, claims), { subject: "owner" });
  assert.deepEqual(
    appIdentity(identity, {
      ...claims,
      [everythingAppClaims.owner]: "other-owner",
    }),
    { subject: "other-owner" },
  );
});

test("ordinary user and service tokens preserve their identity", () => {
  assert.equal(appIdentity(identity, { azp: "everything-web" }), identity);
  assert.equal(appIdentity(identity, {}), identity);
});

test("missing, malformed, and mismatched delegation claims fail closed", () => {
  for (const overrides of [
    { [everythingAppClaims.owner]: undefined },
    { [everythingAppClaims.owner]: " " },
    { [everythingAppClaims.owner]: { sub: "owner" } },
    { [everythingAppClaims.app]: undefined },
    { [everythingAppClaims.app]: "not-a-uuid" },
    { [everythingAppClaims.app]: "7f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11" },
    { azp: "everything-web" },
    { azp: undefined },
  ])
    assert.throws(() => appIdentity(identity, { ...claims, ...overrides }));
  assert.throws(() => appIdentity(identity, { azp: claims.azp }));
});
