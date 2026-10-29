/** The signed-in account acting on keys, and the app whose backend called on its behalf, if any. */
export interface KeyActor {
  readonly subject: string;
  /** Set when an app's own token made the request; apps can't add, change, or grant credentials. */
  readonly app?: string;
}
