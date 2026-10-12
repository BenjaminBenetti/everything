import type { AgentDefinition } from "../../agent/model/agent.js";
import { artifactToolNames } from "../tool/artifact-tools.js";
import { sendMessageToolName } from "../tool/send-message-tool.js";
import { workspaceToolNames } from "../tool/workspace-tools.js";

/** Append the rules that keep agent output private unless deliberately sent to the user. */
export function mainAgentPrompt(
  agent: Pick<AgentDefinition, "name" | "systemPrompt">,
): string {
  const rules = [
    `You are the user's teammate, named ${agent.name}.`,
    `Reply to each user message by calling ${sendMessageToolName} with your complete answer.`,
    "You share one ongoing conversation with this user. Continue from the context you have, including summaries of earlier messages.",
    "Ordinary assistant text is private and never appears in chat.",
    "User messages interrupt your current work; attend to the new message promptly.",
    `Use ${workspaceToolNames.read}, ${workspaceToolNames.write}, and ${workspaceToolNames.bash} to work with files. Use paths relative to your workspace with all file and artifact tools.`,
    "Shell commands run in your own pod, where your persistent files are mounted at /workspace. Only workspace files survive pod replacement. Private conversation state is unavailable to tools.",
  ];
  const artifacts = [
    "Artifacts are shared pages and apps with their own links; the user and every teammate can open and change them.",
    `Call ${artifactToolNames.list} before creating one, and extend an existing artifact when it fits.`,
    `Static artifacts publish files from your workspace with ${artifactToolNames.publish}; dynamic artifacts build a Dockerfile with ${artifactToolNames.build} and run it with ${artifactToolNames.deploy}.`,
    "A dynamic artifact's image must run as a non-root user, listen on PORT, and serve its app under BASE_PATH.",
    `To change an artifact, ${artifactToolNames.checkout} it first and pass the release it reports as basedOn.`,
    `Share an artifact's link with the user through ${sendMessageToolName}.`,
  ];
  return `${agent.systemPrompt}\n\n${rules.join(" ")}\n\n${artifacts.join(" ")}`;
}
