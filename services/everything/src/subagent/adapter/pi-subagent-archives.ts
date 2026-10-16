import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Subagent } from "@everything/agent-contracts/subagent";
import type { AgentWorkspaces } from "../../workspace/interface/agent-workspaces.js";
import { PiForkHistory } from "../../runtime/adapter/pi-fork-history.js";
import { SubagentNotFoundError } from "../error/subagent-errors.js";
import type { SubagentScope } from "../interface/subagent-operations.js";
import type {
  SubagentArchive,
  SubagentArchives,
} from "../interface/subagent-sessions.js";
import { subagentDescendants } from "../model/subagent-tree.js";

/** Read native private sessions without loading provider credentials, tools, or model runtimes. */
export class PiSubagentArchives implements SubagentArchives {
  // ===========================================
  // Construction
  // ===========================================

  /** Resolve only the authorized teammate's existing workspace directory. */
  constructor(
    private readonly workspaces: Pick<AgentWorkspaces, "directory">,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Reopen the same main identity as the runtime and expose its reachable background histories. */
  async open(scope: SubagentScope): Promise<SubagentArchive> {
    const cwd = this.workspaces.directory(scope.agentId);
    const agentDir = path.join(cwd, ".pi");
    const sessionDir = path.join(agentDir, "sessions");
    if ((await SessionManager.list(cwd, sessionDir)).length === 0) {
      return {
        list: () => [],
        messages: () => {
          throw new SubagentNotFoundError();
        },
        delete: async () => {
          throw new SubagentNotFoundError();
        },
      };
    }
    const histories = new PiForkHistory(
      cwd,
      agentDir,
      SessionManager.continueRecent(cwd, sessionDir),
    );
    const sessions = new Map<string, Subagent>(
      (await histories.restore()).map(({ manager, parentId }) => [
        manager.getSessionId(),
        { id: manager.getSessionId(), parentId, status: "stopped" },
      ]),
    );
    return {
      list: () => [...sessions.values()],
      messages: (id, before) => histories.messages(id, before),
      /** Delete descendants as one authorized operation, retaining unrelated sessions. */
      delete: async (id) => {
        const ids = subagentDescendants([...sessions.values()], id);
        await histories.remove(ids);
        for (const target of ids) sessions.delete(target);
      },
    };
  }
}
