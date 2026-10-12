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
import {
  workspaceResourceName,
  workspaceToken,
} from "../model/workspace-access.js";
import {
  WorkspaceOperationError,
  WorkspaceUnavailableError,
} from "../error/workspace-errors.js";

/** Send tools to the teammate's stable internal Service, never a model-provided URL. */
export class HttpWorkspaceTools implements WorkspaceTools {
  // ===========================================
  // Construction
  // ===========================================

  /** Inject only the namespace, controller key, and replaceable HTTP transport. */
  constructor(
    private readonly namespace: string,
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Read a bounded file slice from the tools pod. */
  read(
    agentId: string,
    input: FileReadInput,
    signal?: AbortSignal,
  ): Promise<FileReadResult> {
    return this.request(agentId, "/files/read", input, 30_000, signal);
  }

  /** Write once; ambiguous network failures are never retried automatically. */
  write(
    agentId: string,
    input: FileWriteInput,
    signal?: AbortSignal,
  ): Promise<FileWriteResult> {
    return this.request(agentId, "/files/write", input, 30_000, signal);
  }

  /** Forward interruption by closing the active HTTP request. */
  bash(
    agentId: string,
    input: BashInput,
    signal?: AbortSignal,
  ): Promise<BashResult> {
    return this.request(
      agentId,
      "/bash",
      input,
      ((input.timeoutSeconds ?? workspaceLimits.defaultTimeoutSeconds) + 10) *
        1000,
      signal,
    );
  }

  /** Authenticate a single request and hide infrastructure errors from the model. */
  private async request<T>(
    agentId: string,
    route: string,
    body: unknown,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const abort = AbortSignal.any([
      AbortSignal.timeout(timeout),
      ...(signal ? [signal] : []),
    ]);
    try {
      const response = await this.fetcher(
        `http://${workspaceResourceName(agentId)}.${this.namespace}.svc.cluster.local:8080${route}`,
        {
          method: "POST",
          redirect: "error",
          signal: abort,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${workspaceToken(this.key, agentId)}`,
          },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        if (response.status >= 500) throw new WorkspaceUnavailableError();
        const failure = (await this.readResponse(response)) as {
          message?: unknown;
        };
        throw new WorkspaceOperationError(
          typeof failure.message === "string"
            ? failure.message
            : "The workspace operation failed.",
        );
      }
      return (await this.readResponse(response)) as T;
    } catch (error) {
      signal?.throwIfAborted();
      if (
        error instanceof WorkspaceOperationError ||
        error instanceof WorkspaceUnavailableError
      )
        throw error;
      throw new WorkspaceUnavailableError();
    }
  }

  /** Keep a faulty tools pod from exhausting Everything's memory with an oversized response. */
  private async readResponse(response: Response): Promise<unknown> {
    if (!response.body) throw new WorkspaceUnavailableError();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > workspaceLimits.readBytes * 6 + 4096)
          throw new WorkspaceUnavailableError();
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
}
