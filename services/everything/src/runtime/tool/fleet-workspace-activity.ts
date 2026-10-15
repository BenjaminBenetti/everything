import type {
  ExtensionFactory,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { WorkspaceReference } from "@everything/workspace-contracts/instance";
import type {
  WorkspaceActivityRecorder,
  WorkspaceActivityScope,
} from "../../workspace/interface/workspace-activity.js";
import { workspaceInstanceBody } from "../../workspace/schema/workspace-instance-request.js";
import { fleetToolName } from "./fleet-tools.js";

/** Narrow untrusted tool inputs and structured results before reading instance identifiers. */
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Recognize only complete, valid Fleet instance references. */
function reference(fleet: unknown, instance: unknown): WorkspaceReference[] {
  const workspace = { type: fleet, name: instance };
  return Value.Check(workspaceInstanceBody, workspace) ? [workspace] : [];
}

/** Count explicit instance use, including both ends of a clone, without treating listings as use. */
function inputReferences(tool: string, input: unknown): WorkspaceReference[] {
  if (!tool.startsWith(fleetToolName(""))) return [];
  const args = object(input);
  if (!args) return [];
  if (tool === fleetToolName("fleet_clone")) {
    return [
      ...reference(args.fleet, args.source),
      ...reference(args.fleet, args.destination),
    ];
  }
  return reference(args.fleet, args.instance);
}

/** Job polling has only a job ID as input; Fleet returns the exact instance in structured output. */
function jobReference(event: ToolResultEvent): WorkspaceReference[] {
  if (event.toolName !== fleetToolName("fleet_job_status") || event.isError)
    return [];
  // Pi exposes the complete MCP result as structuredContent, including Fleet's structuredContent.
  const envelope = object(event.structuredContent);
  const payload = object(envelope?.structuredContent) ?? envelope;
  if (payload?.fleet && payload.instance)
    return reference(payload.fleet, payload.instance);
  for (const block of event.content) {
    if (block.type !== "text") continue;
    try {
      const result = object(JSON.parse(block.text));
      const workspace = reference(result?.fleet, result?.instance);
      if (workspace.length) return workspace;
    } catch {
      /* A non-JSON tool response does not identify a workspace. */
    }
  }
  return [];
}

/** Attribute Fleet tool activity to the saved teammate, shared by every session in its fork family. */
export function fleetWorkspaceActivity(
  activity: WorkspaceActivityRecorder,
  scope: WorkspaceActivityScope,
): ExtensionFactory {
  return (pi) => {
    /** Activity feedback must never turn a successful workspace operation into a model tool failure. */
    async function record(
      workspaces: readonly WorkspaceReference[],
    ): Promise<void> {
      const unique = new Map(
        workspaces.map((item) => [
          JSON.stringify([item.type, item.name]),
          item,
        ]),
      );
      for (const workspace of unique.values()) {
        try {
          await activity.touch(scope, workspace);
        } catch {
          console.warn("Workspace activity could not be recorded.");
        }
      }
    }
    pi.on("tool_call", async (event) => {
      await record(inputReferences(event.toolName, event.input));
    });
    pi.on("tool_result", async (event) => {
      await record([
        ...inputReferences(event.toolName, event.input),
        ...jobReference(event),
      ]);
    });
  };
}
