import type {
  FileReadInput,
  FileReadResult,
  FileWriteInput,
  FileWriteResult,
} from "@everything/workspace-contracts";

/** File operations needed by the internal control API. */
export interface WorkspaceFileAccess {
  /** Read a bounded slice of a workspace file. */
  read(input: FileReadInput): Promise<FileReadResult>;
  /** Create or replace a workspace file. */
  write(input: FileWriteInput): Promise<FileWriteResult>;
}

/** The shell needs path resolution without direct file access. */
export interface WorkspaceDirectories {
  /** The teammate's own workspace, which is also its home. */
  readonly home: string;
  /** Resolve a directory in the teammate's workspace or the shared folder. */
  directory(value?: string): Promise<string>;
}
