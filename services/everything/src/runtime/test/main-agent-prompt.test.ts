import assert from "node:assert/strict";
import { test } from "node:test";
import { mainAgentPrompt } from "../prompt/main-agent-prompt.js";
import { forkToolNames } from "../tool/fork-tools.js";
import { monitorToolNames } from "../../monitor/model/monitor-policy.js";
import { taskReceiptMonitorScript } from "../../fleet/model/fleet-task-receipt.js";

const agentId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";

const prompt = mainAgentPrompt({
  id: agentId,
  name: "Ada",
  systemPrompt: "Plan small gardening projects.",
});

test("the prompt introduces the teammate with the description its user wrote", () => {
  assert.ok(
    prompt.startsWith("You are Ada, one of the user's teammates."),
    prompt,
  );
  assert.match(
    prompt,
    /<description>\nPlan small gardening projects\.\n<\/description>/,
  );
  assert.match(prompt, /Treat this description as your role/);
});

test("the prompt asks for an early confirmation on tasks and an outcome at the end", () => {
  assert.match(prompt, /## Replying to the user/);
  assert.match(
    prompt,
    /first send a short message that confirms what you will do, then start/,
  );
  assert.match(prompt, /Sending a message doesn't end your turn/);
  assert.match(prompt, /Answer quick questions and small talk directly/);
  assert.match(prompt, /When you finish, always send the outcome/);
});

test("the prompt groups its rules into titled sections", () => {
  for (const title of [
    "Replying to the user",
    "Your workspace",
    "Apps",
    "Workers",
    "Fleet",
  ])
    assert.match(prompt, new RegExp(`^## ${title}$`, "m"), title);
});

test("the prompt states only how Fleet fits into Everything, leaving its tools to describe themselves", () => {
  const fleet = prompt.slice(prompt.indexOf("## Fleet"));
  assert.match(
    fleet,
    /Create Fleet instances on the cluster connection "everything"/,
  );
  assert.doesNotMatch(fleet, /mcp__fleet__|tmux|job/);
});

test("the prompt names the teammate's workspace, the shared folder, and Fleet templates at the paths Fleet sees", () => {
  assert.ok(
    prompt.includes(`your persistent files are at /workspace/${agentId}`),
  );
  assert.ok(prompt.includes("/workspace/shared is shared with every teammate"));
  assert.ok(
    prompt.includes(
      `Fleet sees /workspace/${agentId} and /workspace/shared at the same paths you do.`,
    ),
  );
  assert.ok(
    prompt.includes(
      "such as a template folder (file:///workspace/shared/my-app), in /workspace/shared",
    ),
  );
});

test("the prompt treats Fleet instances as workers for long-running and background tasks", () => {
  const workers = prompt.slice(
    prompt.indexOf("## Workers"),
    prompt.indexOf("## Fleet"),
  );
  assert.match(workers, /Fleet instances are your workers/);
  assert.match(workers, /more than about 10 minutes/);
  assert.ok(
    workers.includes(
      `Give shorter tasks to a fork with ${forkToolNames.fork}.`,
    ),
  );
  assert.match(workers, /a template folder/);
  assert.match(
    workers,
    /enter it in the worker's session to finish signing in/,
  );
});

test("the prompt arms a worker's receipt monitor only after confirming once that the worker began the task", () => {
  const workers = prompt.slice(
    prompt.indexOf("## Workers"),
    prompt.indexOf("## Fleet"),
  );
  const receipt = workers.indexOf("Never reuse an ID.");
  const handoff = workers.indexOf(
    "Then confirm once that the worker's agent accepted and began this task before you wait on it",
  );
  const monitor = workers.indexOf(
    `Only after that, start ${monitorToolNames.start} with this script`,
  );
  assert.ok(receipt >= 0 && receipt < handoff && handoff < monitor, workers);
  assert.ok(workers.includes(taskReceiptMonitorScript));
  const rule = workers.slice(handoff, monitor);
  assert.match(
    rule,
    /your task submitted as a user turn, followed by a reply or a first step specific to this task/,
  );
  assert.match(
    rule,
    /A live container or CLI, a send that exited successfully, text still waiting in its input, an autocomplete suggestion, or an older task finishing doesn't count\./,
  );
  assert.match(
    rule,
    /unsubmitted or waiting on an approval or sign-in, deal with that or tell the user instead of treating it as working/,
  );
  assert.match(rule, /rather than pressing Enter through a dialog/);
  assert.match(
    rule,
    /If a valid receipt for this task already exists, use its result and don't start a monitor\./,
  );
  assert.match(
    rule,
    /one-time check at handoff, not a reason to keep checking on progress/,
  );
  assert.match(
    workers.slice(monitor),
    /Once started, it waits for the result; it doesn't show that the worker is still busy\./,
  );
});
