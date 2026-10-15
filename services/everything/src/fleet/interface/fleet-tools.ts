/** Structured tools served by the supervised Fleet runtime. */
export interface FleetTools {
  /** Call one tool, rejecting protocol and tool failures. */
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
}
