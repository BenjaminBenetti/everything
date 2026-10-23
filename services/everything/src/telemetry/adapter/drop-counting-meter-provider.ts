import {
  createNoopMeter,
  type Attributes,
  type Counter,
  type Meter,
  type MeterProvider,
} from "@opentelemetry/api";
import type { ExportHealth } from "../service/export-health.js";

/** The batch processors' counters of processed records, which mark records dropped by a full queue. */
const processedCounters = new Set([
  "otel.sdk.processor.span.processed",
  "otel.sdk.processor.log.processed",
]);

/**
 * A meter provider for the SDK's own batch processors that counts only one thing: records they
 * drop because the export queue is full. Every other instrument does nothing; Everything collects
 * no metrics.
 */
export class DropCountingMeterProvider implements MeterProvider {
  /** Count drops into `health`. */
  constructor(private readonly health: ExportHealth) {}

  /** A meter whose processed-record counters report queue drops. */
  getMeter(): Meter {
    const noop = createNoopMeter();
    const health = this.health;
    return new Proxy(noop, {
      get(target, property, receiver) {
        if (property === "createCounter")
          return (name: string, options?: object): Counter => {
            if (!processedCounters.has(name))
              return target.createCounter(name, options);
            return {
              /** Count records the processor dropped because its queue was full. */
              add(value: number, attributes?: Attributes): void {
                if (attributes?.["error.type"] === "queue_full")
                  health.discarded(value);
              },
            };
          };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}
