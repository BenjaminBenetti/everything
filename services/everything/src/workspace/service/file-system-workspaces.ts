import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentWorkspaces } from "../interface/agent-workspaces.js";

/** Keeps every agent's working directory as a child, named by agent ID, of one root directory. */
export class FileSystemWorkspaces implements AgentWorkspaces {
  // ===========================================
  // State
  // ===========================================

  private readonly root: string;

  // ===========================================
  // Construction
  // ===========================================

  /** Use the given root, typically a mounted volume shared by all agents. */
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Resolve the agent's directory, refusing IDs that would escape the root or name the root itself. */
  directory(agentId: string): string {
    const directory = path.resolve(this.root, agentId);
    if (path.dirname(directory) !== this.root)
      throw new Error("An agent ID must name a directory inside the root");
    return directory;
  }

  /** Discover retained workspace directories so cleanup survives interruption after pod deletion. */
  async list(): Promise<string[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
            entry.name,
          ),
      )
      .map((entry) => entry.name);
  }

  /** Delete the agent's directory and its contents. */
  async remove(agentId: string): Promise<void> {
    await rm(this.directory(agentId), { recursive: true, force: true });
  }
}
