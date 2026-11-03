import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import type {
  WorkspaceImageContent,
  WorkspaceImageFiles,
} from "../interface/workspace-image-content.js";
import type { WorkspaceImage } from "../interface/workspace-images.js";
import { WorkspaceImageContentError } from "../error/workspace-image-content-error.js";

/** Authorize the conversation's root teammate independently of the Markdown renderer. */
export class WorkspaceImageContentService implements WorkspaceImageContent {
  // ===========================================
  // Construction
  // ===========================================

  /** Use the owner-scoped catalog and an own-workspace-only file reader. */
  constructor(
    private readonly agents: Pick<AgentCatalog, "get">,
    private readonly files: WorkspaceImageFiles,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Forks use this root teammate's files; private fork delivery remains outside this service. */
  async read(
    ownerId: string,
    agentId: string,
    requested: string,
  ): Promise<WorkspaceImage> {
    try {
      await this.agents.get(ownerId, agentId);
      return await this.files.read(agentId, requested);
    } catch {
      throw new WorkspaceImageContentError();
    }
  }
}
