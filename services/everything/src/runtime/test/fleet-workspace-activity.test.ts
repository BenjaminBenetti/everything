import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { fleetWorkspaceActivity } from "../tool/fleet-workspace-activity.js";
import { fleetToolName } from "../tool/fleet-tools.js";

test("Fleet activity counts explicit instances, clone endpoints, and job polling but never broad listings or tool output", async () => {
  const calls: unknown[] = [];
  const handlers = new Map<string, (event: unknown) => Promise<void>>();
  const scope = { ownerId: "owner", agentId: "teammate" };
  await fleetWorkspaceActivity(
    {
      touch: async (identity, workspace) => {
        calls.push({ identity, workspace });
      },
    },
    scope,
  )({
    /** Capture event subscriptions while preserving production handler behavior. */
    on: (name: string, handler: (event: unknown) => Promise<void>) => {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI);
  /** Deliver Pi's validated call and result events without a model provider. */
  async function call(
    tool: string,
    input: Record<string, unknown>,
    payload?: unknown,
  ) {
    await handlers.get("tool_call")!({
      type: "tool_call",
      toolCallId: "id",
      toolName: fleetToolName(tool),
      input,
    } satisfies ToolCallEvent);
    await handlers.get("tool_result")!({
      type: "tool_result",
      toolCallId: "id",
      toolName: fleetToolName(tool),
      input,
      isError: false,
      details: undefined,
      content: [],
      structuredContent: { structuredContent: payload },
    } as ToolResultEvent);
  }
  await call(
    "fleet_list",
    {},
    { instances: [{ fleet: "web", instance: "unrelated" }] },
  );
  await call("fleet_status", { fleet: "web" });
  await call(
    "fleet_exec",
    {
      fleet: "web",
      instance: "main",
      ownerId: "forged",
      agentId: "other-chat",
    },
    { fleet: "web", instance: "printed-by-command" },
  );
  await call("fleet_clone", {
    fleet: "web",
    source: "main",
    destination: "copy",
  });
  await call(
    "fleet_job_status",
    { job_id: "job" },
    { fleet: "web", instance: "copy", state: "running" },
  );
  await call("fleet_exec", { fleet: "web", instance: "../invalid" });
  assert.deepEqual(
    calls,
    ["main", "main", "main", "copy", "main", "copy", "copy"].map((name) => ({
      identity: scope,
      workspace: { type: "web", name },
    })),
  );
});
