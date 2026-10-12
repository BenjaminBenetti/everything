/** Supplies a current access token for calling another service. */
export interface AccessTokenSource {
  /** Return an unexpired access token, requesting a new one when needed. */
  token(): Promise<string>;
}
