/** An image a tool named can't be viewed; the message is written for the teammate. */
export class WorkspaceImageError extends Error {
  /** Keep the explanation for the tool result. */
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceImageError";
  }
}
