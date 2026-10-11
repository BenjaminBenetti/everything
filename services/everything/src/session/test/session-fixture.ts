import type {
  PasswordAuthentication,
  SessionGrant,
} from "@everything/security/password-grant";
import { SessionCipher } from "@everything/security/session-cipher";
import type { SessionStore } from "../interface/session-repository.js";
import type { StoredSession } from "../model/stored-session.js";
import { SessionService } from "../service/session-service.js";

/** Keep records capability-scoped in tests exactly as the production repository contract requires. */
export function sessionFixture() {
  let now = Date.now();
  let refreshes = 0;
  const revoked: string[] = [];
  const records = new Map<string, StoredSession>();
  const store: SessionStore = {
    /** Store a copy so service mutations cannot bypass repository operations. */
    async create(scope, record) {
      records.set(record.id, { ...record, ...scope });
    },
    /** Resolve only a matching capability. */
    async getById(scope, id) {
      const record = records.get(id);
      return record?.tokenHash === scope.tokenHash ? record : undefined;
    },
    /** Delete only a matching capability. */
    async delete(scope, id) {
      if (records.get(id)?.tokenHash === scope.tokenHash) records.delete(id);
    },
    /** Replace rotating credentials without changing the capability. */
    async rotate(scope, id, encryptedGrant, expiresAt) {
      const record = records.get(id);
      if (record?.tokenHash === scope.tokenHash)
        records.set(id, { ...record, encryptedGrant, expiresAt });
    },
    /** Apply owner and expiry scope to retention. */
    async pruneExpired({ ownerId }, at) {
      for (const record of records.values())
        if (record.ownerId === ownerId && record.expiresAt <= at)
          records.delete(record.id);
    },
  };
  /** Issue recognizable test credentials with a bounded refresh lifetime. */
  function grant(): SessionGrant {
    return {
      profile: { subject: "owner", displayName: "Owner" },
      accessToken: "access-" + refreshes,
      refreshToken: "refresh-" + refreshes,
      accessExpiresAt: now + 60_000,
      refreshExpiresAt: now + 30 * 60_000,
    };
  }
  const provider: PasswordAuthentication = {
    /** Return a session for valid fixture credentials. */
    async authenticate() {
      return grant();
    },
    /** Advance token generation to detect concurrent rotation. */
    async refresh() {
      refreshes++;
      return grant();
    },
    /** Record provider revocations without retaining passwords. */
    async revoke(token) {
      revoked.push(token);
    },
  };
  const cipher = new SessionCipher(Buffer.alloc(32, 1).toString("base64"));
  const service = new SessionService(store, provider, cipher, () => now);
  return {
    service,
    store,
    records,
    provider,
    cipher,
    revoked,
    /** Move the clock without making tests sleep. */
    advance(ms: number) {
      now += ms;
    },
    /** Inspect the number of rotations. */
    refreshCount() {
      return refreshes;
    },
  };
}
