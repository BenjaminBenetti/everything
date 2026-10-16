/** Credentials for one confidential app client; never included in API responses or deployment history. */
export interface AppApiClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Provision and remove the identities apps use to call Everything. */
export interface AppApiClients {
  /** Create or repair the app's client while preserving its existing secret. */
  ensure(appId: string, ownerId: string): Promise<AppApiClient>;
  /** Delete the app's client; already absent clients succeed. */
  remove(appId: string): Promise<void>;
}
