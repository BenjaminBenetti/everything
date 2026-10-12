/**
 * Limit for each route reachable without authentication, per client address. Authenticated routes
 * are not rate limited: the application has a single user.
 */
export const anonymousRateLimit = { max: 120, timeWindow: "1 minute" } as const;
