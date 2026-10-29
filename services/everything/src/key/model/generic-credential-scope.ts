/** Live generic credentials one account added, which that account and its teammates may grant. */
export interface CredentialGrantScope {
  readonly usage: "credential-grant";
  readonly ownerId: string;
}

/** Every generic credential, including deleted ones still being removed, for synchronizing apps. */
export interface CredentialSyncScope {
  readonly usage: "credential-sync";
}

/** Internal scopes of generic credential use, independent of browser sessions. */
export type GenericCredentialScope = CredentialGrantScope | CredentialSyncScope;
