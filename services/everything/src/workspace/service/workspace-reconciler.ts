import { mkdir } from "node:fs/promises";
import path from "node:path";
import AsyncLock from "async-lock";
import type { AgentWorkspaces } from "../interface/agent-workspaces.js";
import type { WorkspacePods } from "../interface/workspace-pods.js";
import type { WorkspaceTargetSource } from "../interface/workspace-target-repository.js";

/** Reconcile durable teammate records to always-running pods and recover after partial failures. */
export class WorkspaceReconciler implements AgentWorkspaces {
  // ===========================================
  // Construction and state
  // ===========================================

  private readonly locks = new AsyncLock();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  /** Receive desired identities, infrastructure operations, durable files, and safe reporting. */
  constructor(
    private readonly targets: WorkspaceTargetSource,
    private readonly pods: WorkspacePods,
    private readonly files: AgentWorkspaces & {
      list(): Promise<readonly string[]>;
    },
    private readonly reportFailure: (agentId?: string) => void,
  ) {}

  // ===========================================
  // Lifecycle
  // ===========================================

  /** Reconcile immediately and every five seconds without overlapping passes. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.refresh(), 5000);
    this.timer.unref();
    void this.refresh();
  }

  /** Drain maintenance; teammate pods intentionally keep running across controller restarts. */
  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }

  /** Coalesce startup, periodic, and explicit reconciliation requests. */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.reconcileAll()
      .catch(() => this.reportFailure())
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  // ===========================================
  // Workspace lifecycle
  // ===========================================

  /** The folder every agent shares, beside their workspaces. */
  get shared(): string {
    return this.files.shared;
  }

  /** Keep the model session and artifact tools on the existing durable workspace path. */
  directory(agentId: string): string {
    return this.files.directory(agentId);
  }

  /** Remove infrastructure before deleting files, serialized against stale reconciliation snapshots. */
  async remove(agentId: string): Promise<void> {
    await this.locks
      .acquire(agentId, async () => {
        await this.pods.remove(agentId);
        await this.files.remove(agentId);
      })
      .catch(() => this.reportFailure(agentId));
  }

  /** Re-read desired state under each lock so deleted teammates cannot be resurrected by old listings. */
  private async reconcileAll(): Promise<void> {
    const desired = await this.targets.list({ ownership: "all" });
    const observed = await this.pods.list();
    const directories = await this.files.list();
    const identities = new Set([
      ...desired.map((target) => target.id),
      ...observed,
      ...directories,
    ]);
    for (const agentId of identities) {
      if (this.stopped) break;
      try {
        await this.locks.acquire(agentId, async () => {
          const target = await this.targets.getById(
            { ownership: "all" },
            agentId,
          );
          if (target) {
            await mkdir(path.join(this.files.directory(agentId), ".pi"), {
              recursive: true,
              mode: 0o700,
            });
            await this.pods.ensure(agentId);
          } else {
            await this.pods.remove(agentId);
            await this.files.remove(agentId);
          }
        });
      } catch {
        this.reportFailure(agentId);
      }
    }
  }
}
