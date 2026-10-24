import { Type, type Static } from "typebox";
import { providerIds } from "@everything/provider-contracts";
import {
  telemetryLimits,
  telemetryOutcomes,
  telemetrySeverities,
  telemetryTypes,
} from "@everything/telemetry-contracts";

/**
 * Non-blank text without backslashes or control characters, which the query builder also refuses:
 * OpenObserve's SQL treats a backslash as an escape inside string literals.
 */
function filterText(maxLength: number) {
  return Type.String({
    minLength: 1,
    maxLength,
    pattern: "^(?=.*\\S)[^\\\\\\x00-\\x1F\\x7F]+$",
  });
}

/** Filters for a page of events or spans; ownership always comes from the signed-in caller. */
export const telemetryPageQuery = Type.Object(
  {
    from: Type.Optional(Type.String({ format: "date-time" })),
    to: Type.Optional(Type.String({ format: "date-time" })),
    type: Type.Optional(
      Type.Union(telemetryTypes.map(({ id }) => Type.Literal(id))),
    ),
    severity: Type.Optional(
      Type.Union(
        telemetrySeverities.map((value) => Type.Literal(value)),
        {
          description:
            "Minimum severity: error shows errors, warning also shows warnings, info shows everything.",
        },
      ),
    ),
    outcome: Type.Optional(
      Type.Union(telemetryOutcomes.map((value) => Type.Literal(value))),
    ),
    agentId: Type.Optional(Type.String({ format: "uuid" })),
    provider: Type.Optional(
      Type.Union(providerIds.map((value) => Type.Literal(value))),
    ),
    model: Type.Optional(filterText(telemetryLimits.modelLength)),
    correlationId: Type.Optional(
      Type.String({
        pattern: `^[A-Za-z0-9_.:-]{1,${telemetryLimits.correlationLength}}$`,
        description:
          "A trace, span, session, run, event, or provider request ID.",
      }),
    ),
    search: Type.Optional(filterText(telemetryLimits.searchLength)),
    cursor: Type.Optional(
      Type.String({
        pattern: `^[A-Za-z0-9_-]{1,${telemetryLimits.cursorLength}}$`,
      }),
    ),
    limit: Type.Optional(
      Type.String({
        pattern: "^(?:[1-9][0-9]?|100)$",
        description: `Records per page, 1 to ${telemetryLimits.maxPageSize}.`,
      }),
    ),
  },
  { additionalProperties: false },
);
export type TelemetryPageQuery = Static<typeof telemetryPageQuery>;

/** One event by the ID Everything gave it. */
export const telemetryEventParams = Type.Object(
  { eventId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
export type TelemetryEventParams = Static<typeof telemetryEventParams>;

/** One trace by its W3C trace ID. */
export const telemetryTraceParams = Type.Object(
  { traceId: Type.String({ pattern: "^[0-9a-f]{32}$" }) },
  { additionalProperties: false },
);
export type TelemetryTraceParams = Static<typeof telemetryTraceParams>;
