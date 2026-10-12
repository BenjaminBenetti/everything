import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "../interface/agent-session.js";
import { ReplyingAgentSession } from "../service/replying-agent-session.js";

/** Track delivery independently from successful private model completions. */
function fixture(
  onPrompt: (text: string) => Promise<void>,
  delivered: () => number,
) {
  const prompts: string[] = [];
  const session: AgentSession = {
    id: "same-session",
    compacting: false,
    /** A successful model completion may contain only private text. */
    async prompt(text) {
      prompts.push(text);
      await onPrompt(text);
    },
    /** The controllable test prompt determines when cancellation settles. */
    async abort() {},
    /** This fixture owns no external resources. */
    dispose() {},
  };
  return { session: new ReplyingAgentSession(session, delivered), prompts };
}

test("an undelivered response gets one private reminder in the same durable session", async () => {
  let delivered = 0;
  const f = fixture(
    async (text) => {
      if (text.includes("Internal delivery reminder")) delivered++;
    },
    () => delivered,
  );
  await f.session.prompt("What is the project code?");
  assert.equal(f.session.id, "same-session");
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1]!, /send_message/);
  assert.equal(delivered, 1);
});

test("already delivered replies do not trigger another request and counts are per user turn", async () => {
  let delivered = 5;
  const f = fixture(
    async () => {
      delivered++;
    },
    () => delivered,
  );
  await f.session.prompt("First");
  await f.session.prompt("Second");
  assert.deepEqual(f.prompts, ["First", "Second"]);
});

test("missing delivery fails after one correction and provider failures are never silently retried", async () => {
  const missing = fixture(
    async () => {},
    () => 0,
  );
  await assert.rejects(missing.session.prompt("Hello"), /did not deliver/);
  assert.equal(missing.prompts.length, 2);
  const failed = fixture(
    async () => {
      throw new Error("Provider failed");
    },
    () => 0,
  );
  await assert.rejects(failed.session.prompt("Hello"), /Provider failed/);
  assert.equal(failed.prompts.length, 1);
});

test("cancellation before delivery prevents a late corrective request", async () => {
  let finish!: () => void;
  const f = fixture(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    () => 0,
  );
  const running = f.session.prompt("Cancel this");
  await f.session.abort();
  finish();
  await running;
  assert.deepEqual(f.prompts, ["Cancel this"]);
});
