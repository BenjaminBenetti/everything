import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getHeapSnapshot } from "node:v8";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { HttpRequestError } from "../../http/model/http-request-error.js";
import { WriteOnlySubmission } from "../service/write-only-submission.js";

/**
 * A fake secret made at run time, so no copy of it is part of this file's source. The test keeps
 * only its reversed spelling and reverses it back after a heap snapshot has been taken.
 */
function sentinel(): { readonly value: string; readonly reversed: string } {
  const value = `wos-${randomUUID()}-${randomUUID()}`;
  return { value, reversed: [...value].reverse().join("") };
}

/** Whether the JavaScript heap, after a full garbage collection, still holds the string. */
async function heapHolds(reversed: string): Promise<boolean> {
  const chunks: string[] = [];
  for await (const chunk of getHeapSnapshot()) chunks.push(String(chunk));
  const needle = [...reversed].reverse().join("");
  return chunks.join("").includes(needle);
}

/** A request that fails like an unreachable API and keeps nothing it was given. */
async function failingSend(secret: string): Promise<never> {
  void secret.length;
  throw new HttpRequestError(
    503,
    "Apps are unavailable",
    "ARTIFACTS_UNAVAILABLE",
  );
}

/**
 * The pattern the dialogs used before: a mutation whose function closes over the value from one
 * render. Two attempts fail, then the dialog clears its state; only the reversed spelling returns.
 */
async function cachedMutationAttempts(client: QueryClient): Promise<string> {
  const secret = sentinel();
  const material = secret.value;
  const observer = new MutationObserver(client, {
    mutationFn: () => failingSend(material),
  });
  await observer.mutate().catch(() => undefined);
  await observer.mutate().catch(() => undefined);
  // Later renders pass a function without the secret, and the dialog unmounts.
  observer.setOptions({ mutationFn: () => failingSend("") });
  observer.reset();
  return secret.reversed;
}

/**
 * The cached mutations' variables, which hold nothing secret; read in a function of its own so no
 * reference to the mutations outlives it.
 */
function cachedVariables(client: QueryClient): unknown[] {
  return client
    .getMutationCache()
    .getAll()
    .map((mutation) => mutation.state.variables);
}

/** Put a fresh sentinel in a submission's draft and return only its reversed spelling. */
function typeSentinel(submission: WriteOnlySubmission<unknown>): string {
  const secret = sentinel();
  submission.edit(secret.value);
  return secret.reversed;
}

test("a failed attempt keeps the draft for a retry, and closing or succeeding erases it", async () => {
  const submission = new WriteOnlySubmission<string>();
  submission.edit("draft value");
  const sent: string[] = [];
  const failed = await submission.submit(async (secret) => {
    sent.push(secret);
    throw new Error("unavailable");
  });
  assert.equal(failed.status, "failed");
  assert.equal(submission.draft, "draft value");
  const succeeded = await submission.submit(async (secret) => {
    sent.push(secret);
    return "saved";
  });
  assert.deepEqual(succeeded, { status: "succeeded", result: "saved" });
  assert.equal(submission.draft, "", "success erases the draft");
  assert.deepEqual(sent, ["draft value", "draft value"]);

  submission.edit("another");
  submission.close();
  assert.equal(submission.draft, "");
  submission.edit("ignored after close");
  assert.equal(submission.draft, "");
});

test("an attempt that answers after the form closed is ignored, and one at a time is sent", async () => {
  const submission = new WriteOnlySubmission<string>();
  submission.edit("secret");
  let release!: (value: string) => void;
  const pending = submission.submit(
    () => new Promise<string>((resolve) => (release = resolve)),
  );
  let second = 0;
  await submission.submit(async () => {
    second++;
    return "second";
  });
  assert.equal(second, 0, "a second attempt waits for the first");
  submission.close();
  release("late");
  const outcome = await pending;
  assert.notEqual(outcome.status, "succeeded");
  assert.equal(submission.draft, "");
});

test("the old cached-mutation pattern keeps a failed secret reachable; the submission keeps none", async () => {
  // Control: React Query keeps settled mutations' options, and their function closes over the secret.
  const client = new QueryClient();
  const controlReversed = await cachedMutationAttempts(client);
  assert.deepEqual(cachedVariables(client), [undefined, undefined]);
  assert.equal(
    await heapHolds(controlReversed),
    true,
    "the cached mutation functions still reach the secret",
  );
  client.getMutationCache().clear();
  client.clear();
  assert.equal(
    await heapHolds(controlReversed),
    false,
    "the cache was what kept it",
  );

  // The submission: two failed attempts, then the form closes.
  const submission = new WriteOnlySubmission<never>();
  const reversed = typeSentinel(submission);
  await submission.submit(failingSend);
  await submission.submit(failingSend);
  assert.equal(submission.state.status, "failed");
  submission.close();
  assert.equal(
    await heapHolds(reversed),
    false,
    "nothing keeps the secret after the form closes",
  );

  // And after a successful attempt, without closing.
  const saving = new WriteOnlySubmission<string>();
  const savedReversed = typeSentinel(saving);
  await saving.submit(async (secret) => `saved ${secret.length} characters`);
  assert.equal(saving.state.status, "succeeded");
  assert.equal(await heapHolds(savedReversed), false);
});
