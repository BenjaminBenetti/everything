import type { AgentDefinition } from "../../agent/model/agent.js";
import { sendMessageToolName } from "../tool/send-message-tool.js";

/** Append the rules that keep agent output private unless deliberately sent to the user. */
export function mainAgentPrompt(
  agent: Pick<AgentDefinition, "name" | "systemPrompt">,
): string {
  const rules = [
    `You are the user's main agent, named ${agent.name}.`,
    `To communicate with the user, call ${sendMessageToolName}.`,
    "Ordinary assistant text is private and never appears in chat.",
    "User messages interrupt your current work; attend to the new message promptly.",
  ];
  return `${agent.systemPrompt}\n\n${rules.join(" ")}`;
}
