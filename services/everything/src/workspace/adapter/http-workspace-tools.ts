import {
  workspaceLimits,
  type BashInput,
  type BashResult,
  type FileReadInput,
  type FileReadResult,
  type FileWriteInput,
  type FileWriteResult,
} from "@everything/workspace-contracts";
import type { WorkspaceTools } from "../interface/workspace-tools.js";
import { WorkspaceHttpClient } from "./workspace-http-client.js";

/** Send tools to the teammate's stable internal Service, never a model-provided URL. */
export class HttpWorkspaceTools implements WorkspaceTools {
  // ===========================================
  // Construction
  // ===========================================

  private readonly client: WorkspaceHttpClient;

  /** Inject only the namespace, controller key, and replaceable HTTP transport. */
  constructor(namespace: string, key: string, fetcher: typeof fetch = fetch) {
    this.client = new WorkspaceHttpClient(namespace, key, fetcher);
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Read a bounded file slice from the tools pod. */
  read(
    agentId: string,
    input: FileReadInput,
    signal?: AbortSignal,
  ): Promise<FileReadResult> {
    return this.client.request(agentId, "/files/read", input, 30_000, signal);
  }

  /** Write once; ambiguous network failures are never retried automatically. */
  write(
    agentId: string,
    input: FileWriteInput,
    signal?: AbortSignal,
  ): Promise<FileWriteResult> {
    return this.client.request(agentId, "/files/write", input, 30_000, signal);
  }

  /** Forward interruption by closing the active HTTP request. */
  bash(
    agentId: string,
    input: BashInput,
    signal?: AbortSignal,
  ): Promise<BashResult> {
    return this.client.request(
      agentId,
      "/bash",
      input,
      ((input.timeoutSeconds ?? workspaceLimits.defaultTimeoutSeconds) + 10) *
        1000,
      signal,
    );
  }
}
