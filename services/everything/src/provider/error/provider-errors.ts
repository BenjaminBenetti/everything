import { ApplicationError } from "@everything/errors";

/** A disconnected or failed connection cannot drive a teammate. */
export class ProviderInactiveError extends ApplicationError {
  /** Direct the owner to restore a usable connection. */
  constructor() {
    super(
      409,
      "PROVIDER_INACTIVE",
      "Connect and check this model provider before using it for a teammate.",
    );
  }
}

/** Reject stale or incompatible teammate inference choices. */
export class InferenceSelectionError extends ApplicationError {
  /** Explain how to replace a model or effort that is no longer available. */
  constructor() {
    super(
      400,
      "INFERENCE_SELECTION_INVALID",
      "Choose an available model and effort level for this teammate’s provider.",
    );
  }
}

/** Fast mode is offered only for models whose provider documents it. */
export class FastModeUnsupportedError extends ApplicationError {
  /** Explain how to save the teammate without a speed its model cannot use. */
  constructor() {
    super(
      400,
      "FAST_MODE_UNSUPPORTED",
      "Fast mode isn’t available for this model. Turn off Fast mode or choose a model that supports it.",
    );
  }
}

/** Model discovery errors must not expose provider response bodies or credentials. */
export class ProviderModelsError extends ApplicationError {
  /** Offer a retry without claiming a catalog failure disconnected the provider. */
  constructor() {
    super(
      502,
      "PROVIDER_MODELS_UNAVAILABLE",
      "Could not load models. Try again, or check this connection in Model providers.",
    );
  }
}

/** Invalid connection settings, safe to display without echoing submitted values. */
export class ProviderInputError extends ApplicationError {
  /** Describe the input correction without including credentials. */
  constructor(message: string) {
    super(400, "PROVIDER_INPUT_INVALID", message);
  }
}

/** Missing and inaccessible connections have the same public result. */
export class ProviderNotConnectedError extends ApplicationError {
  /** Ask the owner to save credentials before checking them. */
  constructor() {
    super(404, "PROVIDER_NOT_CONNECTED", "Connect this provider first.");
  }
}

/** Safe normalized verification failures contain no upstream response bodies. */
export class ProviderVerificationError extends ApplicationError {
  /** Report a known recovery action, never a raw SDK error. */
  constructor(
    message = "The connection check failed. Check your settings and try again.",
  ) {
    super(422, "PROVIDER_VERIFICATION_FAILED", message);
  }
}

/** Expired, replayed, and mismatched OAuth callbacks cannot replace a connection. */
export class ProviderAuthorizationError extends ApplicationError {
  /** Start a new attempt when the pending authorization cannot be validated. */
  constructor(
    message = "Sign-in expired or could not be verified. Please start again.",
  ) {
    super(400, "PROVIDER_AUTHORIZATION_FAILED", message);
  }
}

/** Normalize upstream failures without returning their potentially sensitive bodies. */
export function verificationFailure(error: unknown): ProviderVerificationError {
  if (error instanceof ProviderVerificationError) return error;
  const status = (error as { status?: number } | null)?.status;
  if (status === 400 || status === 422)
    return new ProviderVerificationError(
      `The provider rejected the test request (HTTP ${status}). Check the model name and whether the server supports this API's request format.`,
    );
  if (status === 401)
    return new ProviderVerificationError(
      "The provider rejected these credentials (HTTP 401). Check your API key or sign in again.",
    );
  if (status === 403)
    return new ProviderVerificationError(
      "The provider denied access (HTTP 403). Check that your account or API key has permission to use this model.",
    );
  if (status === 402)
    return new ProviderVerificationError(
      "The provider requires payment or credits (HTTP 402). Check your billing settings with the provider.",
    );
  if (status === 429)
    return new ProviderVerificationError(
      "The provider's rate or usage limit was reached (HTTP 429). Wait and try again, or check your quota and available credits.",
    );
  if (status === 404)
    return new ProviderVerificationError(
      "The API endpoint or model was not found (HTTP 404). Check the API base address and exact model name.",
    );
  if (status === 405)
    return new ProviderVerificationError(
      "The server does not support this request method (HTTP 405). Check that the API base address points to the correct API endpoint.",
    );
  if (typeof status === "number" && status >= 500 && status <= 599)
    return new ProviderVerificationError(
      `The provider returned a server error (HTTP ${status}). Check the provider's availability or model server logs, then try again.`,
    );
  return new ProviderVerificationError(
    "The provider did not complete the connection check. Check its address, availability, and model settings, then try again.",
  );
}
