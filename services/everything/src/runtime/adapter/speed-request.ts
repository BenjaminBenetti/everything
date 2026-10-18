import {
  appendAssistantMessageDiagnostic,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { FastModeModel } from "../model/fast-mode-support.js";
import {
  speedDiagnosticType,
  type ReportedSpeed,
  type SpeedFailure,
  type SpeedReport,
} from "../model/speed-report.js";
import type { SpeedProtocol } from "../interface/speed-protocol.js";

/** A response stream whose final message is also available on its own, as Pi's streams provide. */
type ResponseEvents = AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

/**
 * One model request's speed. Pi's simple streams drop speed options, so Fast is added to the
 * request body through Pi's payload hook. The speed the provider reports is read from Pi's raw
 * event hook, without parsing the stream again, and recorded on the response's final message for
 * every request, including those that request no speed.
 */
export class SpeedRequest {
  // ===========================================
  // State
  // ===========================================

  private reported: ReportedSpeed | undefined;
  private failure: SpeedFailure | undefined;

  // ===========================================
  // Construction
  // ===========================================

  /** Request Fast only with the model's documented requirements; otherwise request no speed. */
  constructor(
    private readonly protocol: SpeedProtocol,
    private readonly fast?: FastModeModel,
  ) {}

  // ===========================================
  // Request
  // ===========================================

  /** Extend the caller's payload and stream-event hooks, which still run first. */
  options(options: SimpleStreamOptions | undefined): SimpleStreamOptions {
    const fast = this.fast;
    const { onPayload, onProviderStreamEvent } = options ?? {};
    return {
      ...options,
      ...(fast
        ? {
            onPayload: async (payload, model) =>
              this.protocol.request(
                ((await onPayload?.(payload, model)) ?? payload) as Record<
                  string,
                  unknown
                >,
                fast,
              ),
          }
        : {}),
      onProviderStreamEvent: async (event, model) => {
        await onProviderStreamEvent?.(event, model);
        this.reported = this.protocol.reported(event) ?? this.reported;
        if (fast)
          this.failure = this.protocol.streamFailure(event) ?? this.failure;
      },
    };
  }

  /** Classify a refused Fast request from a copy of its error body, leaving the response unread. */
  fetch(transport: typeof fetch): typeof fetch {
    return async (input, init) => {
      const response = await transport(input, init);
      if (this.fast && !response.ok)
        this.failure = this.protocol.failure(
          response.status,
          await response
            .clone()
            .json()
            .catch(() => undefined),
        );
      return response;
    };
  }

  // ===========================================
  // Response
  // ===========================================

  /** Record the requested and reported speed on the final message; failures leave it unknown. */
  record(stream: AssistantMessageEventStream): ResponseEvents {
    const annotate = (message: AssistantMessage, completed: boolean) => {
      const report: SpeedReport = {
        requested: this.fast ? "fast" : "standard",
        effective: completed
          ? (this.reported?.effective ?? "unknown")
          : "unknown",
        ...(completed && this.reported?.tier !== undefined
          ? { reportedTier: this.reported.tier }
          : {}),
        ...(!completed && this.failure ? { failure: this.failure } : {}),
      };
      appendAssistantMessageDiagnostic(message, {
        type: speedDiagnosticType,
        timestamp: Date.now(),
        details: { ...report },
      });
    };
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of stream) {
          if (event.type === "done") annotate(event.message, true);
          else if (event.type === "error") annotate(event.error, false);
          yield event;
        }
      },
      result: () => stream.result(),
    };
  }
}
