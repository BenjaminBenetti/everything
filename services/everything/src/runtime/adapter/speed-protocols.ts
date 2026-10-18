import type { ProviderId } from "@everything/provider-contracts";
import type { SpeedProtocol } from "../interface/speed-protocol.js";
import { reportedTier, type SpeedFailure } from "../model/speed-report.js";

/** The value at `path` in a provider's JSON, if every step along it is an object. */
function field(source: unknown, ...path: string[]): unknown {
  let value = source;
  for (const key of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

// ===========================================
// OpenAI Responses
// ===========================================

/** Sign in with ChatGPT names a refused request field in the error's `param`. */
function refusedServiceTier(error: unknown): SpeedFailure | undefined {
  return field(error, "param") === "service_tier" ? "rejected" : undefined;
}

/**
 * OpenAI Responses requests Fast with `service_tier`. `priority` is the documented alias of `fast`,
 * which models up to GPT-5.6 report either way and which ChatGPT sign-in clients send. Only the
 * terminal response reports the tier that served the request; a downgrade reports `default`.
 */
const responsesSpeed: SpeedProtocol = {
  request: (payload) => ({ ...payload, service_tier: "priority" }),
  reported(event) {
    const type = field(event, "type");
    if (type !== "response.completed" && type !== "response.incomplete")
      return undefined;
    const tier = reportedTier(field(event, "response", "service_tier"));
    const effective =
      tier === "priority" || tier === "fast"
        ? "fast"
        : tier === "default"
          ? "standard"
          : "unknown";
    return { ...(tier !== undefined ? { tier } : {}), effective };
  },
  failure: (_status, body) => refusedServiceTier(field(body, "error")),
  /**
   * Plan checks can fail a request after its stream opens. The OpenAI SDK raises named `error`
   * events before Pi's event hook, so only failed responses reach this protocol.
   */
  streamFailure: (event) =>
    field(event, "type") === "response.failed"
      ? refusedServiceTier(field(event, "response", "error"))
      : undefined,
};

// ===========================================
// Anthropic Messages
// ===========================================

/**
 * Anthropic refusals that name the speed setting: over Fast mode's own rate limit or capacity, or
 * unavailable to this account or model. Other errors keep their usual handling.
 */
function refusedSpeed(
  status: number,
  message: unknown,
): SpeedFailure | undefined {
  if (
    typeof message !== "string" ||
    !/\bspeed\b|\bfast[ -]mode\b/i.test(message)
  )
    return undefined;
  if (status === 429 || status === 529) return "limited";
  return status >= 400 && status < 500 ? "rejected" : undefined;
}

/**
 * Anthropic Messages requests Fast with `speed`, adding a model's beta to the betas Pi already sends.
 * Message usage reports the speed used; streamed messages report it when they start.
 */
const messagesSpeed: SpeedProtocol = {
  request(payload, { beta }) {
    const betas = Array.isArray(payload.betas) ? payload.betas : [];
    return {
      ...payload,
      speed: "fast",
      ...(beta ? { betas: [...new Set([...betas, beta])] } : {}),
    };
  },
  reported(event) {
    const type = field(event, "type");
    const speed =
      type === "message_start"
        ? field(event, "message", "usage", "speed")
        : type === "message_delta"
          ? field(event, "usage", "speed")
          : undefined;
    if (speed === undefined || speed === null) return undefined;
    const tier = reportedTier(speed);
    return {
      ...(tier !== undefined ? { tier } : {}),
      effective: tier === "fast" || tier === "standard" ? tier : "unknown",
    };
  },
  failure: (status, body) =>
    refusedSpeed(status, field(body, "error", "message")),
  /** Pi raises streamed Anthropic errors before its event hook, so none reach this protocol. */
  streamFailure: () => undefined,
};

/** Speed translation for each provider whose protocol can request Fast mode. */
export const speedProtocols: Readonly<
  Partial<Record<ProviderId, SpeedProtocol>>
> = {
  chatgpt: responsesSpeed,
  anthropic: messagesSpeed,
};
