import type { PrivateArtifactViewPass } from "@everything/artifact-contracts";
import type {
  ViewGrantRepository,
  ViewPassRepository,
  ViewSessionRepository,
} from "../interface/view-repositories.js";
import type {
  ViewGrant,
  ViewPass,
  ViewSession,
} from "../model/view-credential.js";
import type { ViewPasses } from "../service/view-passes.js";

/** In-memory view credentials, exposing stored records so tests can inspect and age them. */
export interface MemoryCredentials {
  readonly grants: ViewGrantRepository;
  readonly sessions: ViewSessionRepository;
  readonly passes: ViewPassRepository;
  readonly storedPasses: ViewPass[];
}

/** In-memory view links, sessions, and passes with the same one-time and expiry rules as PostgreSQL. */
export function memoryCredentials(): MemoryCredentials {
  const grants: ViewGrant[] = [];
  const sessions: ViewSession[] = [];
  const passes: ViewPass[] = [];
  const now = () => new Date().toISOString();
  return {
    storedPasses: passes,
    grants: {
      getById: async () => undefined,
      list: async () => [...grants],
      delete: async () => {},
      async create(grant) {
        grants.push({
          ...grant,
          id: String(grants.length),
          createdAt: now(),
          usedAt: null,
        });
      },
      async consume({ tokenHash }) {
        const grant = grants.find(
          (entry) =>
            entry.tokenHash === tokenHash &&
            !entry.usedAt &&
            entry.expiresAt > now(),
        );
        if (!grant) return undefined;
        Object.assign(grant, { usedAt: now() });
        return grant;
      },
      async purge({ expiredBefore }) {
        grants.splice(
          0,
          grants.length,
          ...grants.filter((entry) => entry.expiresAt >= expiredBefore),
        );
      },
    },
    sessions: {
      getById: async () => undefined,
      list: async () => [...sessions],
      delete: async () => {},
      async create(session) {
        sessions.push({
          ...session,
          id: String(sessions.length),
          createdAt: now(),
        });
      },
      async findValid({ tokenHash }) {
        return sessions.find(
          (entry) => entry.tokenHash === tokenHash && entry.expiresAt > now(),
        );
      },
      async purge() {},
    },
    passes: {
      getById: async () => undefined,
      list: async () => [...passes],
      delete: async () => {},
      async create(pass) {
        passes.push({ ...pass, id: String(passes.length), createdAt: now() });
      },
      async findValid({ tokenHash }) {
        return passes.find(
          (entry) => entry.tokenHash === tokenHash && entry.expiresAt > now(),
        );
      },
      async purge({ expiredBefore }) {
        passes.splice(
          0,
          passes.length,
          ...passes.filter((entry) => entry.expiresAt >= expiredBefore),
        );
      },
    },
  };
}

/** Make a stored pass expire, as if its lifetime had passed. */
export function expire(pass: ViewPass): void {
  Object.assign(pass, {
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
}

/** Issue a teammate pass for a private app, failing the test if the app is public and gets none. */
export async function issuePass(
  passes: Pick<ViewPasses, "issue">,
  ownerId: string,
  reference: string,
  input: { readonly path?: string } = {},
): Promise<PrivateArtifactViewPass> {
  const view = await passes.issue(ownerId, reference, input);
  if (view.visibility !== "private")
    throw new Error(`${reference} is public and has no pass`);
  return view;
}
