/** Verified caller identity shared by services; never constructed from unverified claims. */
export interface Identity {
  readonly subject: string;
}
