import { ApplicationError } from "@everything/errors";
import { appCredentialLimits } from "@everything/artifact-contracts/credential";

/** A grant arrived malformed; the message never repeats a value. */
export class InvalidCredentialError extends ApplicationError {
  /** Describe what a grant must contain without echoing it. */
  constructor() {
    super(
      400,
      "INVALID_CREDENTIAL",
      `Each credential needs an ID, a version, and a value of at most ${appCredentialLimits.valueBytes} bytes without NUL characters.`,
    );
  }
}

/** A credential was attached under a name that isn't a usable environment variable. */
export class InvalidCredentialVariableError extends ApplicationError {
  /** Name the variable; it is chosen by the caller and isn't secret. */
  constructor(env: string) {
    super(
      400,
      "INVALID_CREDENTIAL_VARIABLE",
      `${env} isn't a valid variable name for a credential. Use letters, digits, and underscores, starting with a letter or underscore, up to ${appCredentialLimits.envLength} characters.`,
    );
  }
}

/** A credential was attached under a variable Everything, PostgreSQL clients, or Kubernetes set. */
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

/** Two credentials were attached under the same variable. */
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

/** A credential and an ordinary variable would share a name in the app's environment. */
export class CredentialVariableConflictError extends ApplicationError {
  /** Name the variable both would set. */
  constructor(env: string) {
    super(
      409,
      "CREDENTIAL_VARIABLE_CONFLICT",
      `${env} is both an ordinary variable and a credential of this app. Rename or remove one of them.`,
    );
  }
}

/** The app is already given a credential under this variable. */
export class CredentialVariableTakenError extends ApplicationError {
  /** Name the variable in use. */
  constructor(env: string) {
    super(
      409,
      "CREDENTIAL_VARIABLE_TAKEN",
      `This app already receives a credential as ${env}. Remove it first, or choose another name.`,
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

/** The credential was deleted; it can never be attached or updated again. */
export class CredentialRevokedError extends ApplicationError {
  /** Refuse without saying more about the credential. */
  constructor() {
    super(
      409,
      "CREDENTIAL_REVOKED",
      "This credential was deleted, so it can't be given to an app.",
    );
  }
}

/** A newer value of the credential was delivered while an older one was being attached. */
export class CredentialChangedError extends ApplicationError {
  /** Ask the caller to try again with the current value. */
  constructor() {
    super(
      409,
      "CREDENTIAL_CHANGED",
      "This credential's value changed while it was being attached. Try again.",
    );
  }
}

/** A delivery carried an older value than one already delivered. */
export class CredentialSupersededError extends ApplicationError {
  /** Refuse the older value. */
  constructor() {
    super(
      409,
      "CREDENTIAL_SUPERSEDED",
      "A newer value of this credential was already delivered.",
    );
  }
}

/** No credential is attached to the app under that variable. */
export class CredentialNotAttachedError extends ApplicationError {
  /** Name the variable that has no credential. */
  constructor(env: string) {
    super(
      404,
      "CREDENTIAL_NOT_ATTACHED",
      `No credential is attached to this app as ${env}.`,
    );
  }
}

/** The app's credentials changed after this grant was authorized, for example by a removal. */
export class CredentialGrantsChangedError extends ApplicationError {
  /** Ask the caller to check the app again before granting. */
  constructor() {
    super(
      409,
      "CREDENTIAL_GRANTS_CHANGED",
      "This app's credentials changed after this change was prepared, for example because one was removed. Check the app's credentials, then try again.",
    );
  }
}

/** Everything sent a different value under a version this service already holds another value for. */
export class CredentialValueConflictError extends ApplicationError {
  /** Explain that Everything moves to a newer version; nothing is changed. */
  constructor() {
    super(
      409,
      "CREDENTIAL_VALUE_CONFLICT",
      "Apps already hold a different value of this credential at this version. Everything saves it as a newer version and delivers it again.",
    );
  }
}
