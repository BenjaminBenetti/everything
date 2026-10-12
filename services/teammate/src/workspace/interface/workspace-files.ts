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
  /** Resolve a directory under the teammate's workspace. */
  directory(value?: string): Promise<string>;
}
