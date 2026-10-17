import type { AgentSession } from "../interface/agent-session.js";
import type {
  ForkableSession,
  SessionFork,
  SessionForkFactory,
  SessionForkOperations,
} from "../interface/session-forks.js";
import { ForkUnavailableError, ForkLimitError } from "../error/fork-errors.js";
import { SessionMailbox } from "./session-mailbox.js";
import type { SubagentSession } from "../../subagent/interface/subagent-sessions.js";
import { SubagentNotFoundError } from "../../subagent/error/subagent-errors.js";
import { subagentDescendants } from "../../subagent/model/subagent-tree.js";
import type { SessionForkHistory } from "../interface/session-fork-history.js";
import { sendMessageToolName } from "../model/message-delivery.js";
import {
  backgroundActivityGraceMs,
  concurrentForkLimit,
  forkToolNames,
} from "../model/fork-policy.js";

/** One private branch and the generation used to suppress late replies after stopping. */
interface ForkMember {
  readonly parentId: string;
  readonly mailbox: SessionMailbox;
  readonly deleteOnCompletion: boolean;
  deletion: Promise<void> | undefined;
  generation: number;
  delivered: number;
  reported: number;
  accepting: boolean;
  stopping: boolean;
  activeUntil: number | undefined;
}

/** Owns a teammate's private session family, routing messages without creating visible conversations. */
export class ForkingAgentSession implements AgentSession {
  // ===========================================
  // State and construction
  // ===========================================

  private readonly root: SessionMailbox;
  private readonly forks = new Map<string, ForkMember>();
  private creating = 0;
  private generation = 0;
  private stopped = false;
  private disposed = false;
  private lastPromptTool: string | undefined;

  /** Receive session creation and a monotonic clock for the background indicator's idle grace period. */
  constructor(
    private readonly session: ForkableSession,
    private readonly factory: SessionForkFactory,
    private readonly now: () => number = () => performance.now(),
    private readonly history?: SessionForkHistory,
  ) {
    this.root = new SessionMailbox(session);
  }

  // ===========================================
  // Session state
  // ===========================================

  /** Preserve the main conversation's durable identity. */
  get id(): string {
    return this.session.id;
  }

  /** Show compaction only for the main conversation. */
  get compacting(): boolean {
    return this.session.compacting;
  }

  /** Expose the main conversation's active compaction timestamp through the session family. */
  get compactionStartedAt(): string | null {
    return this.session.compactionStartedAt;
  }

  /** Preserve explicit reply delivery tracking for user turns. */
  get lastToolName(): string | undefined {
    return this.lastPromptTool;
  }

  /** Private fork messages never show a typing indicator in the user's chat. */
  get typing(): boolean {
    return this.session.typing;
  }

  /** API consumers operate on the same family as tools, with explicit resumption after Stop. */
  get subagents(): SubagentSession | undefined {
    const history = this.history;
    if (!history) return undefined;
    return {
      /** API-created work is parented to main and keeps incoming requests labeled as API input. */
      create: async (input) => {
        this.resumeFromApi();
        return this.fork(
          "main",
          input.task,
          input.context ?? false,
          "API consumer",
        );
      },
      /** Event work uses the normal tool loop and parent routing, with automatic subtree cleanup. */
      wakeup: async (input) => {
        this.resumeFromApi();
        return this.fork(
          "main",
          input.task,
          input.context ?? false,
          "API event",
          true,
        );
      },
      list: () => this.list(),
      /** Validate the target before waking a stopped family. */
      send: (id, text) => {
        this.requireFork(id);
        this.resumeFromApi();
        this.deliver(id, `Private message from API consumer:\n${text}`);
        return this.list().find((fork) => fork.id === id)!;
      },
      /** Read only a known background history; main is never an API subagent address. */
      messages: (id, before) => {
        this.requireFork(id);
        return history.messages(id, before);
      },
      /** Reject external deletion after disposal while allowing internal shutdown cleanup to finish. */
      delete: (id) => {
        if (this.disposed) throw new ForkUnavailableError();
        return this.deleteFork(id);
      },
    };
  }

  /** Smooth the displayed fork count while reporting actual execution independently. */
  get background(): { running: boolean; failed: boolean; activeCount: number } {
    return {
      running:
        this.creating > 0 ||
        ["running", "queued"].includes(this.root.status) ||
        [...this.forks.values()].some((fork) =>
          ["running", "queued"].includes(fork.mailbox.status),
        ),
      failed: this.root.status === "error",
      activeCount: this.displayedForkCount,
    };
  }

  /** Count running forks at every depth without including queued, idle, stopped, or failed sessions. */
  private get activeForkCount(): number {
    return [...this.forks.values()].filter(
      (fork) => fork.mailbox.status === "running",
    ).length;
  }

  /** Count running forks immediately and retain each briefly idle fork without delaying execution slots. */
  private get displayedForkCount(): number {
    if (this.disposed) return 0;
    const now = this.now();
    return [...this.forks.values()].filter((fork) => {
      const status = fork.mailbox.status;
      return (
        status === "running" ||
        ((status === "idle" || status === "queued") &&
          fork.activeUntil !== undefined &&
          now < fork.activeUntil)
      );
    }).length;
  }

  // ===========================================
  // Main conversation lifecycle
  // ===========================================

  /** Prioritize new user input, then deliver private messages received during interruption. */
  async prompt(text: string): Promise<void> {
    if (this.disposed) throw new ForkUnavailableError();
    this.stopped = false;
    const completion = this.root.submit(text, "user");
    this.root.resume();
    const outcome = await completion;
    this.lastPromptTool = outcome?.lastToolName;
  }

  /** A new user turn interrupts only the main session; Stop and shutdown cancel the whole family. */
  async abort(scope: "turn" | "all" = "all"): Promise<void> {
    if (scope === "turn") {
      await this.root.stop(true);
      return;
    }
    this.stopped = true;
    this.generation++;
    for (const fork of this.forks.values()) {
      fork.generation++;
      fork.accepting = false;
      fork.activeUntil = undefined;
    }
    await Promise.all([
      this.root.stop(),
      ...[...this.forks.values()].map((fork) => fork.mailbox.stop()),
    ]);
    await this.deleteTemporaryForks();
  }

  /** Release all sessions, including idle forks retained for later messages. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopped = true;
    this.generation++;
    await this.deleteTemporaryForks();
    await Promise.all([
      this.root.dispose(),
      ...[...this.forks.values()].map((fork) => fork.mailbox.dispose()),
    ]);
  }

  // ===========================================
  // Private messaging
  // ===========================================

  /** Bind every tool to a trusted sender; model-provided IDs can address only this family. */
  operations(sender: string): SessionForkOperations {
    return {
      fork: (task, context = false) => this.fork(sender, task, context),
      send: (recipient, text) => this.send(sender, recipient, text),
      list: () => this.list(),
      stop: (id) => this.stopFork(sender, id),
    };
  }

  /** Register a session while keeping previously interrupted work stopped until explicitly prompted. */
  restore(
    session: ForkableSession,
    parentId: string,
    deleteOnCompletion = false,
  ): void {
    this.forks.set(session.id, {
      parentId,
      mailbox: new SessionMailbox(session, true),
      deleteOnCompletion,
      deletion: undefined,
      generation: 0,
      delivered: 0,
      reported: 0,
      accepting: false,
      stopping: false,
      activeUntil: undefined,
    });
  }

  /** Open a fresh or copied history and return its address without waiting for the background result. */
  private async fork(
    sender: string,
    task: string,
    context: boolean,
    source = sender,
    temporary = false,
  ): Promise<SessionFork> {
    this.checkSender(sender);
    this.checkCapacity();
    const generation = this.generation;
    const parentGeneration = this.forks.get(sender)?.generation;
    this.creating++;
    try {
      const session = await this.factory.create(sender, context, temporary);
      if (
        this.stopped ||
        this.disposed ||
        generation !== this.generation ||
        parentGeneration !== this.forks.get(sender)?.generation
      ) {
        await session.dispose();
        await this.history?.remove([session.id]);
        throw new ForkUnavailableError();
      }
      this.restore(session, sender, temporary);
      this.deliver(session.id, `Background task from ${source}:\n${task}`);
      return this.list().find((fork) => fork.id === session.id)!;
    } finally {
      this.creating--;
      this.startWaitingForks();
    }
  }

  /** Queue a private message, resolving aliases against the trusted sender's parent. */
  private send(sender: string, recipient: string, text: string): void {
    this.checkSender(sender);
    const target =
      recipient === "parent" ? this.forks.get(sender)?.parentId : recipient;
    if (!target || target === sender) throw new ForkUnavailableError();
    this.deliver(target, `Private message from ${sender}:\n${text}`);
    const fork = this.forks.get(sender);
    if (fork && target === fork.parentId) fork.delivered++;
  }

  /** Wake the recipient or queue behind its active turn, catching failures without blocking the sender. */
  private deliver(recipient: string, text: string): void {
    if (recipient === "main") {
      void this.root.submit(text).catch(() => {});
      return;
    }
    const fork = this.forks.get(recipient);
    if (!fork || fork.stopping) throw new ForkUnavailableError();
    const generation = fork.generation;
    fork.accepting = true;
    if (fork.mailbox.status !== "running") fork.mailbox.hold();
    const completion = fork.mailbox.submit(text);
    this.startWaitingForks();
    void completion
      .then(
        (outcome) => {
          if (!outcome || !this.canReport(fork, generation)) return;
          fork.activeUntil = this.now() + backgroundActivityGraceMs;
          const deliveredLast =
            fork.delivered !== fork.reported &&
            [sendMessageToolName, forkToolNames.send].includes(
              outcome.lastToolName ?? "",
            );
          const output = outcome.text?.trim();
          if (!deliveredLast && output) {
            this.deliver(
              fork.parentId,
              `Fork ${recipient} finished:\n${output}`,
            );
          }
          fork.reported = fork.delivered;
        },
        () => {
          if (this.canReport(fork, generation))
            this.deliver(
              fork.parentId,
              fork.deleteOnCompletion
                ? `Temporary background work ${recipient} could not finish. Check the model provider before submitting the event again.`
                : `Fork ${recipient} could not finish. Check the model provider or send the fork another message to continue.`,
            );
        },
      )
      .finally(async () => {
        this.startWaitingForks();
        if (
          fork.deleteOnCompletion &&
          this.forks.get(recipient) === fork &&
          !["running", "queued"].includes(fork.mailbox.status)
        )
          await this.deleteFork(recipient);
      })
      // A failed filesystem cleanup retains the temporary marker for recovery on reopening.
      .catch(() => {});
  }

  /** Suppress late completion and error messages after cancellation or disposal. */
  private canReport(fork: ForkMember, generation: number): boolean {
    return !this.stopped && !this.disposed && fork.generation === generation;
  }

  /** Return addresses and lifecycle only, keeping transcripts out of tool results. */
  private list(): SessionFork[] {
    return [...this.forks].map(([id, fork]) => ({
      id,
      parentId: fork.parentId,
      status: fork.mailbox.status,
    }));
  }

  /** Distinguish unknown addresses from temporarily stopping sessions without revealing other families. */
  private requireFork(id: string): ForkMember {
    const fork = this.forks.get(id);
    if (!fork) throw new SubagentNotFoundError();
    if (fork.stopping || this.disposed) throw new ForkUnavailableError();
    return fork;
  }

  /** Explicit API work may resume after Stop without restarting unrelated stopped descendants. */
  private resumeFromApi(): void {
    if (this.disposed) throw new ForkUnavailableError();
    this.stopped = false;
    this.root.resume();
  }

  /** Share overlapping cleanup so automatic deletion, API deletion, and shutdown dispose each session once. */
  private deleteFork(id: string): Promise<void> {
    const target = this.forks.get(id);
    if (!target) throw new SubagentNotFoundError();
    if (target.deletion) return target.deletion;
    const ids = subagentDescendants(this.list(), id);
    const members = ids.map((target) => ({
      id: target,
      fork: this.forks.get(target)!,
    }));
    const pending = members.flatMap(({ fork }) =>
      fork.deletion ? [fork.deletion] : [],
    );
    const owned = members.filter(({ fork }) => !fork.deletion);
    for (const { fork } of owned) {
      fork.generation++;
      fork.accepting = false;
      fork.stopping = true;
      fork.activeUntil = undefined;
    }
    const deletion = Promise.resolve()
      .then(async () => {
        await Promise.all([
          ...pending,
          ...owned.map(({ fork }) => fork.mailbox.stop()),
        ]);
        await Promise.all(owned.map(({ fork }) => fork.mailbox.dispose()));
        await this.history!.remove(owned.map(({ id }) => id));
        for (const { id } of owned) this.forks.delete(id);
      })
      .finally(() => {
        for (const { fork } of owned) fork.deletion = undefined;
        this.startWaitingForks();
      });
    for (const { fork } of owned) fork.deletion = deletion;
    return deletion;
  }

  /** Await event cleanup during cancellation and shutdown, including already-started deletion. */
  private async deleteTemporaryForks(): Promise<void> {
    await Promise.all(
      [...this.forks]
        .filter(([, fork]) => fork.deleteOnCompletion)
        .map(([id]) => this.deleteFork(id)),
    );
  }

  /** Stop descendants only, avoiding a tool waiting for its own session to abort. */
  private async stopFork(sender: string, id: string): Promise<void> {
    this.checkSender(sender);
    let ancestor = this.forks.get(id)?.parentId;
    while (ancestor && ancestor !== sender && ancestor !== "main")
      ancestor = this.forks.get(ancestor)?.parentId;
    if (ancestor !== sender || id === sender) throw new ForkUnavailableError();
    const targets = new Set([id]);
    let previousSize = 0;
    while (previousSize !== targets.size) {
      previousSize = targets.size;
      for (const [forkId, fork] of this.forks)
        if (targets.has(fork.parentId)) targets.add(forkId);
    }
    const members = [...targets].map((target) => this.forks.get(target)!);
    for (const fork of members) {
      fork.generation++;
      fork.accepting = false;
      fork.stopping = true;
      fork.activeUntil = undefined;
    }
    try {
      await Promise.all(members.map((fork) => fork.mailbox.stop()));
    } finally {
      for (const fork of members) if (!fork.deletion) fork.stopping = false;
    }
    await Promise.all(
      [...targets]
        .filter((target) => this.forks.get(target)?.deleteOnCompletion)
        .map((target) => this.deleteFork(target)),
    );
    this.startWaitingForks();
  }

  /** Reject unknown senders and tool calls arriving after the family has stopped. */
  private checkSender(sender: string): void {
    if (
      this.stopped ||
      this.disposed ||
      (sender !== "main" && !this.forks.get(sender)?.accepting)
    )
      throw new ForkUnavailableError();
  }

  /** Bound simultaneous model work for one teammate, including forks still being opened. */
  private checkCapacity(): void {
    if (this.activeForkCount + this.creating >= concurrentForkLimit)
      throw new ForkLimitError();
  }

  /** Queue wakeups at capacity, including parent notifications, so private results are never dropped. */
  private startWaitingForks(): void {
    if (this.stopped || this.disposed) return;
    let available = concurrentForkLimit - this.creating - this.activeForkCount;
    for (const fork of this.forks.values()) {
      if (available <= 0) return;
      if (fork.accepting && fork.mailbox.status === "queued") {
        available--;
        fork.mailbox.resume();
      }
    }
  }
}
