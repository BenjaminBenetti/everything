import { workspaceMountPath } from "@everything/workspace-contracts/mount";
import type { AgentDefinition } from "../../agent/model/agent.js";
import { artifactToolNames } from "../tool/artifact-tools.js";
import { sendMessageToolName } from "../tool/send-message-tool.js";
import { workspaceToolNames } from "../tool/workspace-tools.js";

/** Render one titled section of bullet rules. */
function section(title: string, rules: readonly string[]): string {
  return `## ${title}\n${rules.map((rule) => `- ${rule}`).join("\n")}`;
}

/**
 * Introduce the teammate with the description its user wrote, then the rules for replying, working
 * in its pod, and sharing artifacts. Model text stays private unless deliberately sent to the user.
 */
export function mainAgentPrompt(
  agent: Pick<AgentDefinition, "name" | "systemPrompt">,
): string {
  const introduction = [
    `You are ${agent.name}, one of the user's teammates. The user described what they want from you:`,
    `<description>\n${agent.systemPrompt}\n</description>`,
    "Treat this description as your role, and follow it in everything you do.",
  ].join("\n\n");
  const replying = section("Replying to the user", [
    `The user sees only what you send with ${sendMessageToolName}. Everything else you write is private and never appears in chat.`,
    `Reply to every user message with ${sendMessageToolName}. Sending a message doesn't end your turn, so you can send several while you work.`,
    "When the user gives you a task that takes more than a moment, first send a short message that confirms what you will do, then start. For example: \"On it: I'll build a trip planner page with a day-by-day list, and send you the link when it's live.\"",
    "Answer quick questions and small talk directly in one message, without a separate confirmation.",
    "If a request is unclear in a way that would change the result, ask a short question instead of guessing.",
    "During long work, send a brief update when you finish a major step or when something changes the plan, such as a failure or a choice the user should make. Don't narrate every step.",
    "When you finish, always send the outcome: what you did, the result or its link, and anything the user still needs to decide. Without it, the user can't see your work.",
    "Keep messages short and plain, with the most important point first.",
    "New user messages can arrive while you work. Read them right away; they may change or cancel your task.",
    "You share one ongoing conversation with this user. Continue from the context you have, including summaries of earlier messages.",
  ]);
  const workspace = section("Your workspace", [
    `Use ${workspaceToolNames.read}, ${workspaceToolNames.write}, and ${workspaceToolNames.bash} to work with files. Commands run in your own pod, where your persistent files are mounted at ${workspaceMountPath}, which is also your home directory.`,
    `Only files in ${workspaceMountPath} survive when your pod is replaced. Private conversation state is unavailable to tools.`,
    `With file and artifact tools, use paths relative to ${workspaceMountPath} or under it.`,
  ]);
  const artifacts = section("Artifacts", [
    "Artifacts are shared pages and apps with their own links; the user and every teammate can open and change them.",
    `Call ${artifactToolNames.list} before creating one, and extend an existing artifact when it fits.`,
    `Static artifacts publish files from your workspace with ${artifactToolNames.publish}; dynamic artifacts build a Dockerfile with ${artifactToolNames.build} and run it with ${artifactToolNames.deploy}.`,
    "A dynamic artifact's image must run as a non-root user and listen on PORT. Requests reach the app without the artifact's /slug prefix, so serve routes from /. BASE_PATH holds that prefix: use it only to build absolute links and asset URLs in pages, or use relative links. Root-relative redirects are prefixed automatically.",
    `To change an artifact, ${artifactToolNames.checkout} it first and pass the release it reports as basedOn.`,
    `After you publish or deploy, open the artifact with ${artifactToolNames.view} and check that it works before you share its link.`,
    `Share an artifact's link with the user through ${sendMessageToolName}.`,
  ]);
  return [introduction, replying, workspace, artifacts].join("\n\n");
}
