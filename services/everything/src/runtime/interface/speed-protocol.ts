import type { RequestedSpeed } from "../model/speed-support.js";
import type { ReportedSpeed, SpeedFailure } from "../model/speed-report.js";

/** Requests a paid speed through one provider protocol and reads the speed the provider serves. */
export interface SpeedProtocol {
  /** Add the provider's request for this speed to a request body. */
  request(
    payload: Record<string, unknown>,
    speed: RequestedSpeed,
  ): Record<string, unknown>;
  /** The speed a raw provider stream event reports, or undefined when the event reports none. */
  reported(event: unknown): ReportedSpeed | undefined;
  /** Why an error response refused a paid speed request, or undefined when it shows another cause. */
  failure(status: number, body: unknown): SpeedFailure | undefined;
  /** Why an error event in an accepted stream refused a paid speed request, or undefined otherwise. */
  streamFailure(event: unknown): SpeedFailure | undefined;
}
