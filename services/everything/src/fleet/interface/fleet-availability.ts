/** Whether Fleet is up, so Fleet's commands reach the daemon Everything supervises. */
export interface FleetAvailability {
  readonly running: boolean;
}
