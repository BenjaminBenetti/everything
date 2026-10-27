/**
 * How a verified caller presented its access token. `bearer` is an Authorization header, which any
 * client holding a token can send, including apps and services acting for a user. `session` is the
 * server-owned browser session, whose token never leaves the server: only a person who signed in to
 * the consuming service in a browser holds one.
 */
export type CredentialSource = "bearer" | "session";
