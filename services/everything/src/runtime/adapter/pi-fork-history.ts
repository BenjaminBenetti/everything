import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ForkUnavailableError } from "../error/fork-errors.js";

const forkMetadataType = "everything-fork";

/** A native Pi history and its trusted parent address. */
interface StoredFork {
  readonly manager: SessionManager;
  readonly parentId: string;
}

/** Keeps private fork transcripts separate from the main conversation's resume directory. */
export class PiForkHistory {
  // ===========================================
  // State and construction
  // ===========================================

  private readonly managers = new Map<string, SessionManager>();
  private readonly directory: string;

  /** Scope every history lookup to this teammate's current main session. */
  constructor(
    private readonly cwd: string,
    agentDir: string,
    private readonly main: SessionManager,
  ) {
    this.directory = path.join(agentDir, "forks", main.getSessionId());
    this.managers.set("main", main);
  }

  // ===========================================
  // Native history
  // ===========================================

  /** Create a fresh history by default, repairing inherited pending calls only when copying context. */
  fork(parentId: string, context = false): SessionManager {
    const source = this.managers.get(parentId)?.getSessionFile();
    if (!source) throw new ForkUnavailableError();
    const manager = context
      ? SessionManager.forkFrom(source, this.cwd, this.directory)
      : SessionManager.create(this.cwd, this.directory, {
          parentSession: source,
        });
    if (context) this.completeInheritedCalls(manager);
    manager.appendCustomEntry(forkMetadataType, {
      rootId: this.main.getSessionId(),
      parentId,
    });
    this.managers.set(manager.getSessionId(), manager);
    return manager;
  }

  /** Reopen saved fork histories without starting any inference or changing the main session. */
  async restore(): Promise<StoredFork[]> {
    const restored: StoredFork[] = [];
    for (const info of await SessionManager.list(this.cwd, this.directory)) {
      const manager = SessionManager.open(info.path, this.directory, this.cwd);
      const entry = manager
        .getEntries()
        .findLast(
          (item) =>
            item.type === "custom" && item.customType === forkMetadataType,
        );
      if (entry?.type !== "custom") continue;
      const metadata = entry.data as
        { rootId?: unknown; parentId?: unknown } | undefined;
      if (
        metadata?.rootId !== this.main.getSessionId() ||
        typeof metadata.parentId !== "string"
      )
        continue;
      this.managers.set(manager.getSessionId(), manager);
      restored.push({ manager, parentId: metadata.parentId });
    }
    return restored;
  }

  /**
   * A fork tool executes before its parent receives the tool result. Add results only in the copy,
   * including any sibling calls still pending, so provider replay never sees dangling tool calls.
   */
  private completeInheritedCalls(manager: SessionManager): void {
    const pending = new Map<string, string>();
    for (const message of manager.buildSessionContext().messages) {
      if (message.role === "assistant") {
        for (const content of message.content)
          if (content.type === "toolCall")
            pending.set(content.id, content.name);
      } else if (message.role === "toolResult")
        pending.delete(message.toolCallId);
    }
    for (const [toolCallId, toolName] of pending) {
      manager.appendMessage({
        role: "toolResult",
        toolCallId,
        toolName,
        content: [
          {
            type: "text",
            text: `This call continues in the parent session. You are fork ${manager.getSessionId()}; do not repeat the parent's pending tool calls.`,
          },
        ],
        isError: false,
        timestamp: Date.now(),
      });
    }
  }
}
