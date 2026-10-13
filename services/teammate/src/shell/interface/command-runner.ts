import type { BashInput, BashResult } from "@everything/workspace-contracts";

/** Command execution and lifecycle operations consumed by the HTTP server. */
export interface CommandRunner {
  /** Execute an interruptible command independently of other active commands. */
  run(input: BashInput, signal?: AbortSignal): Promise<BashResult>;
  /** Interrupt all active commands before server shutdown. */
  close(): void;
}
