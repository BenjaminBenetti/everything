/** How the workers that teammates run their work in are set up, for the whole workspace. */
export interface WorkerSettings {
  /** Whether workers may run privileged, which Docker inside a worker needs. */
  readonly privileged: boolean;
}
