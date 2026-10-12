import { ApplicationError } from "@everything/errors";

/** The requested revision does not exist, or was pruned. */
export class RevisionNotFoundError extends ApplicationError {
  /** Report the revision as absent. */
  constructor(number: number) {
    super(404, "REVISION_NOT_FOUND", `Revision ${number} was not found.`);
  }
}
