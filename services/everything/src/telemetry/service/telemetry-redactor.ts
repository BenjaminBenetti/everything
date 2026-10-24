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
 * `name=value` secrets in text, JSON, or headers, such as `password=…` or `"api_key": "…"`, with
 * the name kept. Text whose values are already placeholders, such as an SQL statement's shape, can
 * skip it.
 */
const assignmentPattern: readonly [RegExp, string] = [
  /((?:\\?["'])?\b(?:[a-z0-9_-]{0,32}(?:api[_-]?key|session)|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|passwd|passphrase|secret|token|authorization|proxy-authorization|cookie|set-cookie|session[_-]?(?:key|id|token)|credentials?)(?:\\?["'])?\s*[:=]\s*)(?!\\?["']?\[redacted\])(?:\\"(?:[^"\\]|\\[^"])*\\"|"[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi,
  `$1${redacted}`,
];

/**
 * Credential shapes, replaced wherever they appear in text: private keys, tokens, API keys,
 * `name=value` secrets in text, JSON, or headers, and URL user information and query strings. A
 * pattern's first group, when present, is kept before the replacement. Already-redacted text is
 * left as it is, so redacting twice gives the same result.
 */
const secretPatterns: readonly (readonly [RegExp, string])[] = [
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
  assignmentPattern,
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
  const { text, cut } = redactStart(value, limit * 2 + 512);
  return truncate((cut ? text + truncationMarker : text).trim(), limit);
}

/** Redacted text from part of a longer value, and whether the value went on past it. */
export interface RedactedWindow {
  readonly text: string;
  readonly cut: boolean;
}

/** What a redaction replaces besides credential shapes. */
export interface RedactionOptions {
  /**
   * Replace the values of `name=value` secrets too; on unless the text's values are already
   * placeholders, as in an SQL statement's shape.
   */
  readonly assignments?: boolean;
}

/**
 * Remove credentials and control characters from the first `window` characters of `value`,
 * without marking or shortening the result further. When the value is longer, the last
 * characters before the cut are dropped after redaction, as in `redactText`, unless what the cut
 * ended in was itself redacted, so a credential the cut split leaves no fragment either way.
 */
export function redactStart(
  value: string,
  window: number,
  options: RedactionOptions = {},
): RedactedWindow {
  const cut = value.length > window;
  const text = withoutAnySecrets(cut ? value.slice(0, window) : value, options);
  return {
    text:
      cut && !text.endsWith(redacted)
        ? text.slice(0, Math.max(0, text.length - cutMargin))
        : text,
    cut,
  };
}

/**
 * Remove credentials and control characters from the last `window` characters of `value`. When
 * the value is longer, the first characters after the cut are dropped after redaction, unless
 * what the cut began in was itself redacted, so a credential the cut split leaves no fragment.
 */
export function redactEnd(value: string, window: number): RedactedWindow {
  if (value.length <= window) return redactStart(value, window);
  const text = withoutAnySecrets(value.slice(value.length - window));
  return {
    text: text.startsWith(redacted)
      ? text
      : text.slice(Math.min(text.length, cutMargin)),
    cut: true,
  };
}

/** Whether text holds percent-encoded ASCII, which could spell a credential the patterns miss. */
const hasEncodedAscii = /%[0-7][0-9A-Fa-f]/;

/**
 * `text` with credentials redacted, as written and as its percent-encoded ASCII reads decoded, so
 * encoding a credential, such as a key in a URL path or `api%5Fkey%3D…`, cannot hide it. Text in
 * which decoding reveals nothing is kept as written. Otherwise its decoded, redacted form is used,
 * since a credential can't be cut out of its encoded form reliably. Only `text` itself, already a
 * bounded window, is decoded, at most `decodePasses` times; other encodings, such as base64 or
 * HTML entities, are not recognized.
 */
function withoutAnySecrets(
  text: string,
  options: RedactionOptions = {},
): string {
  const literal = withoutSecrets(text, options);
  if (!hasEncodedAscii.test(literal)) return literal;
  const decoded = decodedPath(literal);
  const safe = withoutSecrets(decoded, options);
  return safe === decoded ? literal : safe;
}

/** `text` with control characters and every credential shape replaced. */
function withoutSecrets(
  text: string,
  { assignments = true }: RedactionOptions = {},
): string {
  let result = text.replace(controlCharacters, " ");
  for (const entry of secretPatterns)
    if (assignments || entry !== assignmentPattern)
      result = result.replace(entry[0], entry[1]);
  return result.replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, opaqueToken);
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
    return truncate(
      `${url.protocol}//${redactText(url.host, limit)}${redactPath(url.pathname, limit)}`,
      limit,
    );
  } catch {
    return redactPath(value, limit);
  }
}

/**
 * A path without its query string or fragment, with credentials redacted. Its percent-encoded
 * ASCII is decoded first, so encoding cannot hide a credential, and redacted as decoded, so an
 * encoded `?` or `#` cannot join a credential to the text before it. Those two are encoded again
 * afterwards, so the path never reads as a query string or fragment.
 */
export function redactPath(value: string, limit = 512): string {
  const redacted = redactText(
    decodedPath(value.split(/[?#]/, 1)[0] ?? ""),
    limit,
  );
  return truncate(
    redacted.replaceAll("?", "%3F").replaceAll("#", "%23"),
    limit,
  );
}

/** Percent-encoded ASCII characters, which can spell a credential the patterns would not see. */
const encodedAscii = /%([0-7][0-9A-Fa-f])/g;

/** Most times a path is decoded, for a credential encoded more than once. */
const decodePasses = 3;

/** Text with its percent-encoded ASCII characters decoded, up to `decodePasses` times. */
export function decodedPath(path: string): string {
  let current = path;
  for (let pass = 0; pass < decodePasses; pass++) {
    const next = current.replace(encodedAscii, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (next === current) break;
    current = next;
  }
  return current;
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
