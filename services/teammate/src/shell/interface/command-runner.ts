import type { BashInput, BashResult } from "@everything/workspace-contracts";

/** Command execution and lifecycle operations consumed by the HTTP server. */
export interface CommandRunner {
  /** Execute one interruptible command. */
  run(input: BashInput, signal?: AbortSignal): Promise<BashResult>;
  /** Interrupt active execution before server shutdown. */
  close(): void;
}
