/** Marker appended to text cut to its limit, so a reader knows more was recorded than shown. */
export const truncationMarker = "…[truncated]";

/** Replacement for anything that looks like a credential. */
const redacted = "[redacted]";

/**
 * Redact a long run of token characters unless it is a path or identifier made of short parts,
 * such as `/v1/agents/<uuid>/messages`, which separators break into pieces no secret is made of.
 */
function opaqueToken(match: string): string {
  return match.split(/[/-]/).every((part) => part.length < 24)
    ? match
    : redacted;
}

/**
 * Credential shapes, replaced wherever they appear in text: private keys, tokens, API keys,
 * `name=value` secrets in text, JSON, or headers, and URL user information and query strings. A
 * pattern's first group, when present, is kept before the replacement. Already-redacted text is
 * left as it is, so redacting twice gives the same result.
 */
const secretPatterns: readonly [RegExp, string][] = [
  [
    /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g,
    redacted,
  ],
  // Whole cookie headers, since their values hold several name=value pairs.
  [/\b((?:set-)?cookie\s*:\s*)(?!\[redacted\])[^\r\n]+/gi, `$1${redacted}`],
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${redacted}`],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, redacted],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{6,}/g, redacted],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, redacted],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g, redacted],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, redacted],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, redacted],
  [
    /((?:\\?["'])?\b(?:[a-z0-9_-]{0,32}(?:api[_-]?key|session)|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|passwd|passphrase|secret|token|authorization|proxy-authorization|cookie|set-cookie|session[_-]?(?:key|id|token)|credentials?)(?:\\?["'])?\s*[:=]\s*)(?!\\?["']?\[redacted\])(?:\\"(?:[^"\\]|\\[^"])*\\"|"[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi,
    `$1${redacted}`,
  ],
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#@]{1,256}@/gi, `$1${redacted}@`],
  [
    /(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi,
    `$1?${redacted}`,
  ],
  [/\b[A-Fa-f0-9]{40,}\b/g, redacted],
  [
    /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g,
    "[email]",
  ],
];

/** Control characters, other than tabs and line feeds, and Unicode line separators. */
const controlCharacters =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]+/g;

/** Characters dropped from the end of text that was cut before redaction; see `redactText`. */
const cutMargin = 64;

/**
 * Remove credentials and control characters, then cut the text to `limit` characters. Only the
 * first `limit * 2 + 512` characters are examined, so the time taken is bounded however long the
 * text is. When text is cut there, the last characters before the cut are dropped after
 * redaction, so a credential the cut split in two cannot survive as a fragment.
 */
export function redactText(value: string, limit: number): string {
  const window = limit * 2 + 512;
  const cut = value.length > window;
  let text = (cut ? value.slice(0, window) : value).replace(
    controlCharacters,
    " ",
  );
  for (const [pattern, replacement] of secretPatterns)
    text = text.replace(pattern, replacement);
  text = text.replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, opaqueToken);
  if (cut)
    text =
      text.slice(0, Math.max(0, text.length - cutMargin)) + truncationMarker;
  return truncate(text.trim(), limit);
}

/** Cut text to `limit` characters, marking the cut. */
export function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return (
    value.slice(0, Math.max(0, limit - truncationMarker.length)) +
    truncationMarker
  );
}

/**
 * A URL without user information, query string, or fragment, which can carry credentials, and with
 * credentials in its host or path redacted, such as a key in a gateway's base path.
 */
export function redactUrl(value: string, limit = 512): string {
  try {
    const url = new URL(value);
    return redactText(
      `${url.protocol}//${url.host}${decodedPath(url.pathname)}`,
      limit,
    );
  } catch {
    return redactPath(value, limit);
  }
}

/** A path without its query string or fragment, with credentials redacted. */
export function redactPath(value: string, limit = 512): string {
  return redactText(decodedPath(value.split(/[?#]/, 1)[0] ?? ""), limit);
}

/** Percent-encoded ASCII characters, which can spell a credential the patterns would not see. */
const encodedAscii = /%([0-7][0-9A-Fa-f])/g;

/** Most times a path is decoded, for a credential encoded more than once. */
const decodePasses = 3;

/**
 * A path with its percent-encoded ASCII characters decoded, so encoding cannot hide a credential
 * from redaction. A decoded `?` or `#` stays encoded, so the path never reads as a query string.
 */
function decodedPath(path: string): string {
  let current = path;
  for (let pass = 0; pass < decodePasses; pass++) {
    const next = current.replace(encodedAscii, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (next === current) break;
    current = next;
  }
  return current.replaceAll("?", "%3F").replaceAll("#", "%23");
}

/** A short identifier, such as an error code or request ID, or undefined when it is anything else. */
export function safeIdentifier(
  value: unknown,
  limit = 128,
): string | undefined {
  if (typeof value === "number" && Number.isInteger(value))
    return String(value);
  return typeof value === "string" &&
    value.length <= limit &&
    /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value)
    ? value
    : undefined;
}

/** What may be recorded about a thrown value; never the value itself or its other properties. */
export interface ErrorDescription {
  /** The error's class name, such as `TypeError`. */
  readonly type?: string;
  readonly code?: string;
  readonly status?: number;
  /** The redacted, bounded message, followed by those of its causes; error text. */
  readonly message?: string;
  /** The innermost frames of the call stack, as code locations without the message. */
  readonly stack?: string;
}

/** Limits for one error description. */
const errorLimits = {
  message: 400,
  causes: 3,
  frames: 6,
  stack: 1200,
} as const;

/**
 * A call-stack line naming a function and where its code is, such as
 * `at main (file:///app/build/main.js:10:5)`.
 */
const stackFrame =
  /^at (?:[\w$.<>[\] -]{1,200} \()?(?:file:\/\/|node:|\/|<anonymous>|native\b)[^\s()]{0,500}\)?$/;

/**
 * Describe a thrown value from its class name, code, status, message, causes, and stack frames
 * only, each redacted and bounded. Response bodies, headers, request options, and any other
 * properties an SDK attaches are never read. The message and those of its causes are error text,
 * which is exported only if the installation records it; the frames are code locations only.
 */
export function describeError(error: unknown): ErrorDescription {
  if (!(error instanceof Error))
    return typeof error === "string"
      ? { message: redactText(error, errorLimits.message) }
      : {};
  const failure = error as Error & {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  const type =
    safeIdentifier(failure.name, 64) ??
    safeIdentifier(failure.constructor?.name, 64);
  const code = safeIdentifier(failure.code, 64);
  const status = [failure.status, failure.statusCode].find(
    (value): value is number =>
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 100 &&
      value <= 599,
  );
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth <= errorLimits.causes && current; depth++) {
    if (current instanceof Error && current.message)
      messages.push(current.message);
    else if (typeof current === "string") messages.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  const message = messages.length
    ? redactText(messages.join(" ← "), errorLimits.message)
    : undefined;
  // The stack starts with the message, which may run over several lines; only frames are kept.
  const header = `${error.name}: ${error.message}`;
  const trace = error.stack ?? "";
  const frames = (trace.startsWith(header) ? trace.slice(header.length) : trace)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => stackFrame.test(line))
    .slice(0, errorLimits.frames);
  const stack = frames.length
    ? redactText(frames.join("\n"), errorLimits.stack)
    : undefined;
  return {
    ...(type !== undefined ? { type } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(stack !== undefined ? { stack } : {}),
  };
}
