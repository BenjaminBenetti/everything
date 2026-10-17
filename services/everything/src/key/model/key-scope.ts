/** All signed-in members manage the installation's keys; actor attribution does not isolate records. */
export interface KeyScope {
  readonly usage: "installation";
  readonly actorId: string;
}
