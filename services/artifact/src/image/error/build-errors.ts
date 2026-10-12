import { ApplicationError } from "@everything/errors";

/** The requested build does not exist, or was pruned. */
export class BuildNotFoundError extends ApplicationError {
  /** Report the build as absent. */
  constructor(number: number) {
    super(404, "BUILD_NOT_FOUND", `Build ${number} was not found.`);
  }
}

/** The build source has no file at the Dockerfile path. */
export class DockerfileMissingError extends ApplicationError {
  /** Name the path that was expected. */
  constructor(path: string) {
    super(
      400,
      "DOCKERFILE_MISSING",
      `The build source has no "${path}". Add a Dockerfile or name the one to use.`,
    );
  }
}

/** A deployment needs a successful build, and the requested one is not. */
export class BuildNotReadyError extends ApplicationError {
  /** Explain which build is unusable, or that none has succeeded. */
  constructor(number?: number) {
    super(
      409,
      "BUILD_NOT_READY",
      number === undefined
        ? "This artifact has no successful build yet. Build it, wait for the build to succeed, and deploy again."
        : `Build ${number} has not succeeded, so it cannot be deployed.`,
    );
  }
}
