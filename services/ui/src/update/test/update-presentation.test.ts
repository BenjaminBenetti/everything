import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent } from "@everything/agent-contracts";
import type { Update } from "@everything/update-contracts";
import { presentUpdate, summaryLabels } from "../model/update-presentation.js";

const message: Update = {
  id: "update-1",
  kind: "message",
  agentId: "team mate",
  messageId: "message/1",
  summary: "The release notes are ready.",
  summaryStatus: "ready",
  createdAt: "2026-10-15T10:00:00Z",
};

test("message updates open their exact source message, named by the teammate who sent it", () => {
  const agents = [
    { id: "team mate", name: "Avery", avatarId: "avatar-03" },
  ] as Agent[];
  assert.deepEqual(
    {
      ...presentUpdate(message, agents),
      icon: undefined,
    },
    {
      to: "/team/team%20mate?message=message%2F1",
      source: "Avery",
      avatarId: "avatar-03",
      icon: undefined,
      action: "Open message",
    },
  );
});

test("an update from a teammate that hasn't loaded still links to its source", () => {
  const presentation = presentUpdate(message);
  assert.equal(presentation?.source, "Teammate");
  assert.equal(presentation?.to, "/team/team%20mate?message=message%2F1");
});

test("kinds this client doesn't know yet are skipped instead of breaking the feed", () => {
  const future = { ...message, kind: "artifact" } as unknown as Update;
  assert.equal(presentUpdate(future), undefined);
});

test("only summaries that aren't ready carry a label", () => {
  assert.equal(summaryLabels.ready, undefined);
  assert.equal(summaryLabels.pending, "Summarizing…");
  assert.equal(summaryLabels.unavailable, "Message preview");
});
