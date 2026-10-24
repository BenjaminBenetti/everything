import {
  telemetryTypes,
  type TelemetryOutcome,
  type TelemetrySeverity,
  type TelemetryType,
} from "@everything/telemetry-contracts";

/** A cause in plain words, and what the owner can do about it. */
export interface CausePresentation {
  readonly summary: string;
  readonly nextStep: string | null;
}

/** Model failure categories, as the API records them, in plain words. */
const causes: Readonly<Record<string, CausePresentation>> = {
  rate_limit: {
    summary: "The provider’s rate limit was reached.",
    nextStep: "Wait a moment, then send the message again.",
  },
  quota: {
    summary: "The provider account is out of quota or credit.",
    nextStep: "Check the provider account’s billing or usage limits.",
  },
  overloaded: {
    summary: "The provider was overloaded.",
    nextStep: "Send the message again in a few moments.",
  },
  unavailable: {
    summary: "The provider was unavailable.",
    nextStep: "Send the message again in a few moments.",
  },
  server_error: {
    summary: "The provider reported an error on its side.",
    nextStep:
      "Send the message again; if it keeps happening, check the provider’s status page.",
  },
  timeout: {
    summary: "The request took too long and timed out.",
    nextStep: "Send the message again.",
  },
  network: {
    summary: "Everything couldn’t reach the provider.",
    nextStep:
      "Check the provider’s address and the installation’s internet access.",
  },
  stream_interrupted: {
    summary: "The response stopped before it finished.",
    nextStep: "Send the message again to continue.",
  },
  authentication: {
    summary: "The provider didn’t accept the saved credentials.",
    nextStep: "Reconnect the provider in Settings.",
  },
  permission: {
    summary: "The provider account isn’t allowed to use this model or feature.",
    nextStep:
      "Choose another model in the teammate’s settings, or check the account’s access.",
  },
  not_found: {
    summary: "The provider doesn’t recognize the model or address.",
    nextStep:
      "Check the model and provider address in the teammate’s settings.",
  },
  context_length: {
    summary: "The conversation was longer than the model accepts.",
    nextStep:
      "Everything summarizes older context automatically; if this repeats, choose a model with a larger context window.",
  },
  request_too_large: {
    summary: "The request was larger than the provider accepts.",
    nextStep: null,
  },
  invalid_request: {
    summary: "The provider rejected the request.",
    nextStep: "Check the teammate’s model settings.",
  },
  content_filter: {
    summary: "The provider declined to respond.",
    nextStep: null,
  },
  fast_mode_rejected: {
    summary: "The provider didn’t accept Fast mode for this model or account.",
    nextStep: "Turn off Fast mode in the teammate’s settings.",
  },
  fast_mode_limited: {
    summary: "The provider’s Fast mode limit was reached.",
    nextStep:
      "Wait a moment, or turn off Fast mode in the teammate’s settings.",
  },
  cancelled: { summary: "The work was stopped.", nextStep: null },
  unknown: { summary: "The cause wasn’t reported.", nextStep: null },
};

/** Codes Everything records for a teammate's turns and requests, in plain words. */
const codes: Readonly<Record<string, string>> = {
  MODEL_REQUEST_FAILED: "The model request failed.",
  COMPACTION_FAILED: "Summarizing older context failed.",
  REPLY_NOT_DELIVERED: "The teammate finished without replying.",
  FAST_MODE_REJECTED: "Fast mode wasn’t accepted.",
  FAST_MODE_LIMITED: "The Fast mode limit was reached.",
  TURN_FAILED: "The turn stopped unexpectedly.",
  INTERNAL_ERROR: "Everything couldn’t complete a request.",
};

/** A recorded cause in plain words, from its category or, failing that, its code. */
export function describeCause(
  category: string | null,
  code: string | null,
): CausePresentation | null {
  if (category && causes[category]) return causes[category];
  if (code && codes[code]) return { summary: codes[code], nextStep: null };
  return null;
}

/** Severity names for badges and announcements. */
export const severityLabels: Readonly<Record<TelemetrySeverity, string>> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
};

/** Outcome names for details. */
export const outcomeLabels: Readonly<Record<TelemetryOutcome, string>> = {
  failure: "Failed",
  cancelled: "Stopped",
  success: "Succeeded",
};

/** A record type's name. */
export function typeLabel(type: TelemetryType): string {
  return telemetryTypes.find(({ id }) => id === type)?.label ?? type;
}

/** A time with its date, in the browser's locale and time zone. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}

/** A duration in the largest sensible unit. */
export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1) return "<1 ms";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  return `${minutes} min ${Math.round((milliseconds % 60_000) / 1_000)} s`;
}

/** The teammate's name, or a description when it isn't known. */
export function teammateName(
  agentId: string | null,
  agents: readonly { readonly id: string; readonly name: string }[] | undefined,
): string | null {
  if (!agentId) return null;
  return agents?.find(({ id }) => id === agentId)?.name ?? "Removed teammate";
}
