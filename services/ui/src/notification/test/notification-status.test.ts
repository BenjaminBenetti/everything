import assert from "node:assert/strict";
import { test } from "node:test";
import { notificationStatus } from "../model/notification-status.js";

test("unsupported browsers and blocked permission explain what to do instead", () => {
  const unsupported = notificationStatus("unsupported", false, "idle", false);
  assert.match(unsupported.message, /desktop browser/);
  assert.equal(unsupported.problem, false);
  const denied = notificationStatus("denied", false, "idle", false);
  assert.match(denied.message, /blocking notifications/);
  assert.match(denied.message, /browser’s settings/);
});

test("before permission is decided, turning the switch on asks the browser", () => {
  assert.match(
    notificationStatus("default", false, "idle", false).message,
    /ask for permission when you turn this on/,
  );
  assert.match(
    notificationStatus("default", false, "pending", false).message,
    /Choose Allow/,
  );
  const dismissed = notificationStatus("default", false, "dismissed", false);
  assert.match(dismissed.message, /ask again/);
  assert.equal(dismissed.problem, true);
  const failed = notificationStatus("default", false, "failed", false);
  assert.match(failed.message, /couldn’t ask/);
  assert.equal(failed.problem, true);
});

test("allowed notifications distinguish the user's choice from the browser's permission", () => {
  assert.match(
    notificationStatus("granted", false, "idle", false).message,
    /won’t send any on this device/,
  );
  const on = notificationStatus("granted", true, "idle", false);
  assert.match(on.message, /unless you’re already looking at their chat/);
  assert.equal(on.problem, false);
  const refused = notificationStatus("granted", true, "idle", true);
  assert.match(refused.message, /couldn’t show the last notification/);
  assert.equal(refused.problem, true);
});

test("product copy says teammate, never agent", () => {
  for (const permission of [
    "unsupported",
    "default",
    "denied",
    "granted",
  ] as const)
    for (const request of ["idle", "pending", "dismissed", "failed"] as const)
      for (const enabled of [false, true])
        for (const failed of [false, true])
          assert.doesNotMatch(
            notificationStatus(permission, enabled, request, failed).message,
            /agent/i,
          );
});
