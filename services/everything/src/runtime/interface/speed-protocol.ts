import type { FastModeModel } from "../model/fast-mode-support.js";
import type { ReportedSpeed, SpeedFailure } from "../model/speed-report.js";

/** Requests Fast mode through one provider protocol and reads the speed the provider serves. */
export interface SpeedProtocol {
  /** Add the provider's Fast request, and any beta the model needs, to an outgoing request body. */
  request(
    payload: Record<string, unknown>,
    model: FastModeModel,
  ): Record<string, unknown>;
  /** The speed a raw provider stream event reports, or undefined when the event reports none. */
  reported(event: unknown): ReportedSpeed | undefined;
  /** Why an error response refused a Fast request, or undefined when it shows another cause. */
  failure(status: number, body: unknown): SpeedFailure | undefined;
  /** Why an error event in an accepted stream refused a Fast request, or undefined otherwise. */
  streamFailure(event: unknown): SpeedFailure | undefined;
}
