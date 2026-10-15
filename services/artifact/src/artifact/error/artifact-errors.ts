import { ApplicationError } from "@everything/errors";
import type {
  ArtifactAuthor,
  ArtifactKind,
} from "@everything/artifact-contracts";

/** The app is missing or belongs to someone else; both look identical. */
export class ArtifactNotFoundError extends ApplicationError {
  /** Report the app as absent. */
  constructor() {
    super(404, "ARTIFACT_NOT_FOUND", "App not found.");
  }
}

/** Another app already uses the requested slug, which names its link. */
export class SlugTakenError extends ApplicationError {
  /** Ask for a different slug. */
  constructor(slug: string) {
    super(
      409,
      "SLUG_TAKEN",
      `Another app already uses the slug "${slug}". Choose a different slug.`,
    );
  }
}

/** The operation needs the other kind of app, which is fixed at creation. */
export class WrongKindError extends ApplicationError {
  /** Explain what the app's kind allows instead. */
  constructor(kind: ArtifactKind) {
    super(
      409,
      "WRONG_ARTIFACT_KIND",
      kind === "static"
        ? "This is a static app. Publish files to it instead of building or deploying."
        : "This is a dynamic app. Build and deploy it instead of publishing files.",
    );
  }
}

/** Another main agent released the app after the release the caller worked from. */
export class ReleaseConflictError extends ApplicationError {
  /** Name the newer release and its author so the caller can merge. */
  constructor(release: number, author: ArtifactAuthor) {
    super(
      409,
      "RELEASE_CONFLICT",
      `Release ${release} by ${author.name} is live now. Check it out, merge your changes, and try again.`,
    );
  }
}

/** A change arrived without the main agent making it. */
export class MissingActorError extends ApplicationError {
  /** Ask the caller to name the acting main agent. */
  constructor() {
    super(400, "MISSING_ACTOR", "Name the teammate making this change.");
  }
}

/** Nothing has been published or built, so there is no source to check out. */
export class SourceNotFoundError extends ApplicationError {
  /** Report the missing source. */
  constructor() {
    super(
      404,
      "SOURCE_NOT_FOUND",
      "This app has no published revision or build to check out.",
    );
  }
}

/** An app needs an existing release before it can be started. */
export class AppNotPublishedError extends ApplicationError {
  /** Ask for a release before starting the app. */
  constructor() {
    super(
      409,
      "APP_NOT_PUBLISHED",
      "Publish or deploy this app before starting it.",
    );
  }
}

/** Manual deletion refuses an app that another caller has started. */
export class AppMustBeStoppedError extends ApplicationError {
  /** Ask the user to stop the app before deleting it. */
  constructor() {
    super(409, "APP_MUST_BE_STOPPED", "Stop this app before deleting it.");
  }
}
