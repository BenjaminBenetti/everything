import { ApplicationError } from "@everything/errors";
import { keyLimits } from "@everything/key-contracts";

/** A shared key no longer exists in this installation. */
export class KeyNotFoundError extends ApplicationError {
  /** Return a consistent missing-key response for lookup and rename. */
  constructor() {
    super(404, "KEY_NOT_FOUND", "Key not found.");
  }
}

/** Reject unsupported formats and malformed material without echoing secrets. */
export class InvalidKeyError extends ApplicationError {
  /** Return a safe instruction with no parser or key details. */
  constructor() {
    super(
      400,
      "INVALID_KEY",
      "Choose a supported key type and upload a key in that format.",
    );
  }
}

/** A generic credential's value can't be stored or placed in an app's environment exactly. */
export class InvalidCredentialValueError extends ApplicationError {
  /** Explain the value rules without repeating the value. */
  constructor() {
    super(
      400,
      "INVALID_CREDENTIAL_VALUE",
      `Enter a value of at most ${keyLimits.materialLength / 1024} KB. It can't be blank or contain NUL characters.`,
    );
  }
}

/** Another live generic credential already has this name, ignoring case. */
export class KeyNameTakenError extends ApplicationError {
  /** Ask for a different name; teammates choose credentials by name. */
  constructor(name: string) {
    super(
      409,
      "KEY_NAME_TAKEN",
      `Another credential is already named “${name}”. Choose a different name.`,
    );
  }
}

/** An app's own token tried to add, change, delete, or grant a credential. */
export class AppCredentialAccessError extends ApplicationError {
  /** Point the caller at the Keys page. */
  constructor() {
    super(
      403,
      "APP_CREDENTIAL_ACCESS_FORBIDDEN",
      "Apps can't add, change, delete, or attach credentials. Manage credentials in Everything instead.",
    );
  }
}

/** Only the account that added a generic credential can replace its value or give it to apps. */
export class CredentialOwnerOnlyError extends ApplicationError {
  /** Explain who can do this. */
  constructor() {
    super(
      403,
      "CREDENTIAL_OWNER_ONLY",
      "Only the account that added this credential can replace its value or attach it to apps.",
    );
  }
}
