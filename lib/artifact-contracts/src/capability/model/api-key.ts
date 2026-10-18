/** Header external callers send a dynamic app's API key in; the app host checks it and removes it. */
export const appApiKeyHeader = "X-Api-Key";

/** Environment variable holding a dynamic app's API key, set only in its backend. */
export const appApiKeyVariable = "APP_API_KEY";

/** Prefix of every app API key, so people and secret scanners recognize one. */
export const appApiKeyPrefix = "everything_app_key_";

/** An app API key: the prefix followed by 32 random bytes in base64url. */
export const appApiKeyPattern = `^${appApiKeyPrefix}[A-Za-z0-9_-]{43}$`;
