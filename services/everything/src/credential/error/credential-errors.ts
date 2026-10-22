import { ApplicationError } from "@everything/errors";
import { appCredentialLimits } from "@everything/artifact-contracts/credential";

/** No live generic credential the caller may attach has this name. */
export class CredentialNotFoundError extends ApplicationError {
  /** Name what was asked for; another account's credential of that name looks the same. */
  constructor(name: string) {
    super(
      404,
      "CREDENTIAL_NOT_FOUND",
      `No credential you can attach is named “${name}”. Check the name with list_credentials, or ask the user to add it on the Keys page.`,
    );
  }
}

/** More than one credential matched a name, so none is chosen. */
export class AmbiguousCredentialNameError extends ApplicationError {
  /** Ask for the duplicate to be renamed. */
  constructor(name: string) {
    super(
      409,
      "AMBIGUOUS_CREDENTIAL_NAME",
      `More than one credential is named “${name}”. Ask the user to rename one on the Keys page.`,
    );
  }
}

/** The stored value can't be decrypted, so it is never sent anywhere. */
export class CredentialUnavailableError extends ApplicationError {
  /** Ask for the value to be saved again; no decryption details are given. */
  constructor() {
    super(
      409,
      "CREDENTIAL_UNAVAILABLE",
      "This credential's value can't be read. Replace its value on the Keys page, then try again.",
    );
  }
}

/** A credential was requested under a name that isn't a usable environment variable. */
export class InvalidCredentialVariableError extends ApplicationError {
  /** Name the variable; it isn't secret. */
  constructor(env: string) {
    super(
      400,
      "INVALID_CREDENTIAL_VARIABLE",
      `${env} isn't a valid variable name for a credential. Use letters, digits, and underscores, starting with a letter or underscore, up to ${appCredentialLimits.envLength} characters.`,
    );
  }
}

/** A credential was requested under a variable Everything, PostgreSQL clients, or Kubernetes set. */
export class ReservedCredentialVariableError extends ApplicationError {
  /** Name the reserved variable. */
  constructor(env: string) {
    super(
      400,
      "RESERVED_CREDENTIAL_VARIABLE",
      `${env} is reserved by Everything. Choose a name that isn't PORT, BASE_PATH, DATABASE_URL, APP_API_KEY, or one starting with EVERYTHING_, PG, or KUBERNETES_.`,
    );
  }
}

/** Two credentials were requested under the same variable. */
export class DuplicateCredentialVariableError extends ApplicationError {
  /** Name the repeated variable. */
  constructor(env: string) {
    super(
      400,
      "DUPLICATE_CREDENTIAL_VARIABLE",
      `Only one credential can be attached as ${env}.`,
    );
  }
}

/** An app may receive only a bounded number of credentials. */
export class TooManyCredentialsError extends ApplicationError {
  /** State the limit. */
  constructor() {
    super(
      400,
      "TOO_MANY_CREDENTIALS",
      `An app can receive at most ${appCredentialLimits.count} credentials.`,
    );
  }
}

/** App service codes for refused credential changes that callers can act on, kept as they are. */
const actionableCodes = new Set([
  "INVALID_CREDENTIAL",
  "INVALID_CREDENTIAL_VARIABLE",
  "RESERVED_CREDENTIAL_VARIABLE",
  "DUPLICATE_CREDENTIAL_VARIABLE",
  "CREDENTIAL_VARIABLE_CONFLICT",
  "CREDENTIAL_VARIABLE_TAKEN",
  "TOO_MANY_CREDENTIALS",
  "CREDENTIAL_REVOKED",
  "CREDENTIAL_CHANGED",
  "CREDENTIAL_NOT_ATTACHED",
  "CREDENTIAL_GRANTS_CHANGED",
  "CREDENTIAL_VALUE_CONFLICT",
  "WRONG_ARTIFACT_KIND",
]);

/**
 * The app service refused a credential change. Its message is written for users and teammates and
 * never contains a value; its code is kept when callers can act on it.
 */
export class CredentialChangeRefusedError extends ApplicationError {
  /** Keep the app service's status, actionable code, and safe message. */
  constructor(status: number, code: string, message: string) {
    super(
      status,
      actionableCodes.has(code) ? code : "CREDENTIAL_CHANGE_REFUSED",
      message,
    );
  }
}
