import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { FleetTools } from "../../fleet/interface/fleet-tools.js";
import { fleetStatusSchema } from "../../fleet/schema/fleet-status.js";
import { fleetToolName } from "./fleet-tools.js";

/** Everything's defaults for newly created fleets; explicit choices always take precedence. */
const enabledSettings = [
  "claude_code_mount",
  "codex_mount",
  "gh_mount",
  "fleet_mcp",
] as const;

/** Accept a settings object without repairing invalid inputs before Fleet validates them. */
function settingsObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Fill omitted creation settings before Pi sends the call to Fleet, including calls from forks. */
export function fleetCreationDefaults(tools: FleetTools): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const creates = event.toolName === fleetToolName("fleet_create");
      const provisions = event.toolName === fleetToolName("fleet_up");
      if (!creates && !provisions) return;
      const input = settingsObject(event.input);
      if (!input) return;
      const settings =
        input.settings === undefined ? {} : settingsObject(input.settings);
      if (
        !settings ||
        enabledSettings.every((key) => settings[key] !== undefined)
      )
        return;
      if (provisions) {
        // Only a call with a remote can create a fleet. Even with a remote, an existing fleet
        // must not receive settings: Fleet rejects them instead of changing the saved options.
        if (typeof input.remote !== "string" || !input.remote.trim()) return;
        const status = await tools.call("fleet_status", {});
        if (!Value.Check(fleetStatusSchema, status))
          throw new Error("Fleet returned an invalid fleet listing.");
        if (status.fleets.some((fleet) => fleet.fleet === input.fleet)) return;
      }
      const effective = { ...settings };
      for (const key of enabledSettings)
        if (effective[key] === undefined) effective[key] = true;
      input.settings = effective;
    });
  };
}
