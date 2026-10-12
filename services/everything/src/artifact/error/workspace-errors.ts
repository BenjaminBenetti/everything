/** A directory or file a tool named cannot be used; the message is written for the teammate. */
export class WorkspacePathError extends Error {
  /** Keep the explanation for the tool result. */
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

/** A directory is too large or has too many files to publish or build. */
export class SnapshotLimitError extends Error {
  /** Keep the explanation for the tool result. */
  constructor(message: string) {
    super(message);
    this.name = "SnapshotLimitError";
  }
}
