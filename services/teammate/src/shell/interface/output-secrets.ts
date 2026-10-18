/** Secrets commands can read but whose values their output must never return. */
export interface OutputSecrets {
  /** The secrets to redact from a command starting now, which can change between commands. */
  current(): Promise<readonly string[]>;
}

/** No secrets to redact. */
export const noOutputSecrets: OutputSecrets = { current: async () => [] };
