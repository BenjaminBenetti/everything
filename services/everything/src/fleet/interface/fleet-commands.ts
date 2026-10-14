/** Fleet's command-line client, run against the fleetd in Everything's container. */
export interface FleetCommands {
  /** Run `fleet <args>` and return what it printed; reject when it fails. */
  run(args: readonly string[]): Promise<string>;
}
