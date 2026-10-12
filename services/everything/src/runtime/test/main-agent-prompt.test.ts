import assert from "node:assert/strict";
import { test } from "node:test";
import { mainAgentPrompt } from "../prompt/main-agent-prompt.js";

const prompt = mainAgentPrompt({
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
  for (const title of ["Replying to the user", "Your workspace", "Artifacts"])
    assert.match(prompt, new RegExp(`^## ${title}$`, "m"), title);
});
