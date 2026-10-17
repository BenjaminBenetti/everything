import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** The creation and editing schemas needed to exercise Pi's real validation and MCP path. */
export const fleetCreationTools: readonly Tool[] = [
  {
    name: "fleet_create",
    description: "Create a fleet with optional settings.",
    inputSchema: {
      type: "object",
      properties: {
        fleet: { type: "string" },
        remote: { type: "string" },
        settings: { type: "object", additionalProperties: true },
      },
      required: ["fleet", "remote"],
    },
  },
  {
    name: "fleet_up",
    description:
      "Create an instance, optionally creating its fleet with settings.",
    inputSchema: {
      type: "object",
      properties: {
        fleet: { type: "string" },
        instance: { type: "string" },
        remote: { type: "string" },
        settings: { type: "object", additionalProperties: true },
      },
      required: ["fleet", "instance"],
    },
  },
  {
    name: "fleet_edit",
    description: "Patch settings on an existing fleet.",
    inputSchema: {
      type: "object",
      properties: {
        fleet: { type: "string" },
        settings: { type: "object", additionalProperties: true },
      },
      required: ["fleet", "settings"],
    },
  },
];
