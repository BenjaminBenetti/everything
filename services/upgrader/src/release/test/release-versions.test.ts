import assert from "node:assert/strict";
import { test } from "node:test";
import {
  newestUpgrade,
  upgradeCandidates,
  versionFromTag,
} from "../model/release-versions.js";

const published = [
  "0.1.0-rc6",
  "0.1.0-rc7",
  "0.1.0",
  "0.1.1",
  "0.2.0-rc.1",
  "latest",
  "0.1.1",
  "v0.3.0",
];

test("a stable installation is offered newer stable versions only, newest first", () => {
  assert.deepEqual(upgradeCandidates(published, "0.1.0"), ["0.1.1"]);
  assert.equal(newestUpgrade(published, "0.1.1"), null);
});

test("a pre-release installation is also offered newer pre-releases", () => {
  assert.deepEqual(upgradeCandidates(published, "0.1.0-rc6"), [
    "0.2.0-rc.1",
    "0.1.1",
    "0.1.0",
    "0.1.0-rc7",
  ]);
  assert.equal(newestUpgrade(published, "0.1.0-rc7"), "0.2.0-rc.1");
});

test("older, equal, and non-semantic tags are never offered", () => {
  assert.deepEqual(upgradeCandidates(published, "9.0.0"), []);
  assert.deepEqual(upgradeCandidates(["latest", "v1.0.0", "1.0"], "0.1.0"), []);
});

test("Helm's OCI tags carry build metadata with an underscore", () => {
  assert.equal(versionFromTag("1.2.3_build.4"), "1.2.3+build.4");
  assert.equal(versionFromTag("1.2.3-rc.1"), "1.2.3-rc.1");
});
