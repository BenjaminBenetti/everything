import type { Repository } from "@everything/persistence/repository";
import type {
  ViewGrant,
  ViewPass,
  ViewSession,
} from "../model/view-credential.js";

/** The credential whose secret hashes to this value. */
export interface TokenScope {
  readonly tokenHash: string;
}

/** Every credential that expired before this time, for cleanup. */
export interface ExpiredScope {
  readonly expiredBefore: string;
}

/** One credential by its token, or every expired credential. */
export type CredentialScope = TokenScope | ExpiredScope;

/** Persistence boundary for one-time view links. */
export interface ViewGrantRepository extends Repository<
  ViewGrant,
  CredentialScope
> {
  /** Store a new view link. */
  create(grant: Omit<ViewGrant, "id" | "createdAt" | "usedAt">): Promise<void>;
  /** Mark an unused, unexpired link as used and return it; any other link yields undefined. */
  consume(scope: TokenScope): Promise<ViewGrant | undefined>;
  /** Delete every link in scope. */
  purge(scope: ExpiredScope): Promise<void>;
}

/** Persistence boundary for artifact host sessions. */
export interface ViewSessionRepository extends Repository<
  ViewSession,
  CredentialScope
> {
  /** Store a new session. */
  create(session: Omit<ViewSession, "id" | "createdAt">): Promise<void>;
  /** Find an unexpired session by its token. */
  findValid(scope: TokenScope): Promise<ViewSession | undefined>;
  /** Delete every session in scope. */
  purge(scope: ExpiredScope): Promise<void>;
}

/** Persistence boundary for teammate passes. */
export interface ViewPassRepository extends Repository<
  ViewPass,
  CredentialScope
> {
  /** Store a new pass. */
  create(pass: Omit<ViewPass, "id" | "createdAt">): Promise<void>;
  /** Find an unexpired pass by its token. */
  findValid(scope: TokenScope): Promise<ViewPass | undefined>;
  /** Delete every pass in scope. */
  purge(scope: ExpiredScope): Promise<void>;
}
