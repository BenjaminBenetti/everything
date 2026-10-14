/** Maximum simultaneous background model turns per teammate. */
export const concurrentForkLimit = 8;

/** Keep briefly idle forks in the chat's background count for ten seconds. */
export const backgroundActivityGraceMs = 10_000;

/** Public tool identifiers shared by orchestration, prompts, and Pi bindings. */
export const forkToolNames = {
  fork: "fork",
  send: "send_fork_message",
  list: "list_forks",
  stop: "stop_fork",
} as const;
