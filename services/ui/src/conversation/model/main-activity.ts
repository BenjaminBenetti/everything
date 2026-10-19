import type { RuntimeStatus } from "@everything/conversation-contracts";

/** The parts of the conversation's status query that show whether its main teammate is working. */
export interface MainActivitySnapshot {
  readonly isSuccess: boolean;
  /** False while only a cached result from an earlier visit is available. */
  readonly isFetchedAfterMount: boolean;
  readonly data?:
    { readonly runtime: Pick<RuntimeStatus, "mainRunning"> } | undefined;
}

/**
 * Trust only a successful status read made since the conversation opened, and only its main-session
 * flag: background teammates, a cached earlier visit, a failed refresh awaiting reconnection, and an
 * older API without the flag all show the ordinary avatar.
 */
export function mainTeammateWorking(snapshot: MainActivitySnapshot): boolean {
  return (
    snapshot.isSuccess &&
    snapshot.isFetchedAfterMount &&
    snapshot.data?.runtime.mainRunning === true
  );
}
