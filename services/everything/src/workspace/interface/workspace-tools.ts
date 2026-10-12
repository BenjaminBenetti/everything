import type {
  BashInput,
  BashResult,
  FileReadInput,
  FileReadResult,
  FileWriteInput,
  FileWriteResult,
} from "@everything/workspace-contracts";

/** Operations offered by a teammate's tools pod, independent of its transport. */
export interface WorkspaceTools {
  /** Read only this teammate's files. */
  read(
    agentId: string,
    input: FileReadInput,
    signal?: AbortSignal,
  ): Promise<FileReadResult>;
  /** Replace a file in this teammate's workspace. */
  write(
    agentId: string,
    input: FileWriteInput,
    signal?: AbortSignal,
  ): Promise<FileWriteResult>;
  /** Run an interruptible command in this teammate's container. */
  bash(
    agentId: string,
    input: BashInput,
    signal?: AbortSignal,
  ): Promise<BashResult>;
}
