/** Verified caller identity shared by services; never constructed from unverified claims. */
export interface Identity {
  readonly subject: string;
  /**
   * The app whose backend presented the token while acting as `subject`, set only by a service's
   * identity resolver after every token check succeeds. Services use it to refuse actions an app's
   * own code must not take, such as granting itself credentials.
   */
  readonly app?: string;
}
