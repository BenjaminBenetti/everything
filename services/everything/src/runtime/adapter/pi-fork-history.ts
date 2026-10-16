import path from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ForkUnavailableError } from "../error/fork-errors.js";
import type { MessagePage } from "@everything/conversation-contracts";
import { SubagentNotFoundError } from "../../subagent/error/subagent-errors.js";
import type { SessionForkHistory } from "../interface/session-fork-history.js";
import { piSubagentMessages } from "./pi-subagent-messages.js";

const forkMetadataType = "everything-fork";

/** A native Pi history and its trusted parent address. */
interface StoredFork {
  readonly manager: SessionManager;
  readonly parentId: string;
}

/** Keeps private fork transcripts separate from the main conversation's resume directory. */
export class PiForkHistory implements SessionForkHistory {
  // ===========================================
  // State and construction
  // ===========================================

  private readonly managers = new Map<string, SessionManager>();
  private readonly temporary = new Set<string>();
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

  /** Persist lifetime before execution, inheriting temporary ownership through all descendants. */
  fork(parentId: string, context = false, temporary = false): SessionManager {
    const parent = this.managers.get(parentId);
    if (!parent) throw new ForkUnavailableError();
    const source = this.persistIdentity(parent);
    const manager = context
      ? SessionManager.forkFrom(source, this.cwd, this.directory)
      : SessionManager.create(this.cwd, this.directory, {
          parentSession: source,
        });
    if (context) this.completeInheritedCalls(manager);
    const expires = temporary || this.temporary.has(parentId);
    manager.appendCustomEntry(forkMetadataType, {
      rootId: this.main.getSessionId(),
      parentId,
      temporary: expires,
    });
    this.persistIdentity(manager);
    this.managers.set(manager.getSessionId(), manager);
    if (expires) this.temporary.add(manager.getSessionId());
    return manager;
  }

  /** Remove interrupted event histories and reopen retained forks without starting inference. */
  async restore(): Promise<StoredFork[]> {
    const candidates: StoredFork[] = [];
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
        | { rootId?: unknown; parentId?: unknown; temporary?: unknown }
        | undefined;
      if (
        metadata?.rootId !== this.main.getSessionId() ||
        typeof metadata.parentId !== "string"
      )
        continue;
      if (metadata.temporary === true) {
        const id = manager.getSessionId();
        this.managers.set(id, manager);
        this.temporary.add(id);
        continue;
      }
      candidates.push({ manager, parentId: metadata.parentId });
    }
    await this.remove([...this.temporary]);
    const restored: StoredFork[] = [];
    const reachable = new Set(["main"]);
    let previousSize = 0;
    while (reachable.size !== previousSize) {
      previousSize = reachable.size;
      for (const fork of candidates) {
        const id = fork.manager.getSessionId();
        if (!reachable.has(id) && reachable.has(fork.parentId)) {
          reachable.add(id);
          this.managers.set(id, fork.manager);
          restored.push(fork);
        }
      }
    }
    return restored;
  }

  /** Show only the selected fork's own text, excluding copied context before its metadata boundary. */
  messages(id: string, before?: string): MessagePage {
    const manager = id === "main" ? undefined : this.managers.get(id);
    if (!manager) throw new SubagentNotFoundError();
    const entries = manager.getEntries();
    const boundary = entries.findLastIndex(
      (entry) =>
        entry.type === "custom" && entry.customType === forkMetadataType,
    );
    return piSubagentMessages(entries.slice(boundary + 1), before);
  }

  /** Remove children before parents; every path comes from a previously opened native session. */
  async remove(ids: readonly string[]): Promise<void> {
    for (const id of [...ids].reverse()) {
      const manager = id === "main" ? undefined : this.managers.get(id);
      if (!manager) continue;
      const file = manager.getSessionFile();
      if (file) await rm(file, { force: true });
      this.managers.delete(id);
      this.temporary.delete(id);
    }
  }

  // ===========================================
  // Persistence and inherited context
  // ===========================================

  /** Pin setup-only identities so API work survives even when the main teammate has never been prompted. */
  private persistIdentity(manager: SessionManager): string {
    const file = manager.getSessionFile();
    const header = manager.getHeader();
    if (!file || !header) throw new ForkUnavailableError();
    if (!existsSync(file)) {
      // Pi normally waits for the first model prompt before flushing setup metadata.
      writeFileSync(
        file,
        [header, ...manager.getEntries()]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
        { flag: "wx", mode: 0o600 },
      );
      manager.setSessionFile(file);
    }
    return file;
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
