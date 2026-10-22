import type { AppCredential } from "@everything/artifact-contracts/credential";
import type { CredentialGrants } from "../service/credential-grants.js";

/** Credential grants for tests that never attach credentials: names stay as the app service sent them. */
export const noCredentialGrants: Pick<
  CredentialGrants,
  "resolve" | "named" | "catalog" | "align"
> = {
  resolve: async () => {
    throw new Error("No credentials were expected");
  },
  named: async (credentials: readonly AppCredential[]) => [...credentials],
  catalog: async () => [],
  align: async () => {},
};
