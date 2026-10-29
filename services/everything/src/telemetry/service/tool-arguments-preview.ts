import { telemetryLimits } from "@everything/telemetry-contracts";
import { decodedPath, redactStart } from "./telemetry-redactor.js";
import { fitUtf8, utf8Length } from "./text-budget.js";

/** A tool call's arguments as bounded JSON, and whether anything was left out. */
export interface ToolArgumentsPreview {
  readonly text: string;
  readonly truncated: boolean;
}

/** How much of the arguments one pass keeps. */
interface PreviewLimits {
  /** Nesting below the top level that is shown; deeper values are summarized. */
  readonly depth: number;
  /** Fields of one object, or items of one array, that are shown. */
  readonly entries: number;
  /** Values read in all, so the work is bounded however the arguments are shaped. */
  readonly nodes: number;
  /** UTF-8 bytes of one string. */
  readonly string: number;
  /** UTF-8 bytes of a string under a field that usually holds a body, such as a file's content. */
  readonly body: number;
}

/**
 * Successively smaller limits; each pass is bounded, and the first whose result fits the budget is
 * kept.
 */
const passes: readonly PreviewLimits[] = [
  { depth: 4, entries: 24, nodes: 200, string: 300, body: 160 },
  { depth: 3, entries: 12, nodes: 100, string: 120, body: 64 },
  { depth: 2, entries: 6, nodes: 40, string: 48, body: 24 },
];

/** Most keys counted on one object to say how many were left out. */
const countedKeys = 1_000;

/**
 * Most keys one object's scan visits, own or inherited, and most one pass visits in all, so a long
 * prototype chain or many wide objects can't make the walk unbounded.
 */
const objectScanLimit = 1_024;
const passScanLimit = 4_096;

/** Integers at least this large, either way, are summarized rather than written out. */
const largeInteger = 10n ** 30n;

/** Longest field name shown, in UTF-8 bytes. */
const keyBytes = 64;

/**
 * Field names whose values are credentials, compared without case or separators: names containing
 * an unambiguous word, or ending in one that is a credential only at the end, so `max_tokens` and
 * `token_count` stay readable while `auth_token` doesn't.
 */
const secretKey =
  /password|passwd|passphrase|apikey|privatekey|secretkey|accesskey|clientsecret|credential|authorization|cookie|(?:token|secrets?|sessionid|sessionkey|signature)$/;

/** Field names whose strings are usually bodies, such as files a tool writes, shown briefly. */
const bodyKeys = new Set([
  "content",
  "contents",
  "body",
  "data",
  "file",
  "files",
  "patch",
  "diff",
  "newtext",
  "oldtext",
  "newstring",
  "oldstring",
  "code",
  "source",
  "html",
  "image",
  "images",
  "base64",
  "blob",
  "buffer",
  "bytes",
  "attachment",
  "attachments",
  "payload",
]);

/**
 * Field names that hold maps of named values, such as an app's environment variables or build
 * arguments, which are often credentials: their names are shown, never their values.
 */
const valueMaps = new Set([
  "env",
  "environment",
  "variables",
  "vars",
  "buildargs",
  "buildarguments",
  "headers",
  "secrets",
]);

/** A data URL's media type, without its data. */
const dataUrl = /^data:([\w.+-]{1,64}\/[\w.+-]{1,64})?[^,]{0,100},/i;

/**
 * A bounded, redacted preview of a tool call's arguments as compact JSON within
 * `telemetryLimits.previewBytes` of UTF-8. Only the arguments' own enumerable data properties are
 * read, never getters or `toJSON`, built-in objects are summarized through the engine's own
 * methods, never an override, and nothing is changed, so the call runs with exactly the arguments
 * it was given. Key scans, inherited keys included, values, and strings are bounded before
 * anything is serialized, and large integers are summarized. A proxy's traps are its own code and
 * can still run when it is walked. Strings are redacted for credentials and cut, fields named like
 * credentials are replaced, maps of named values such as environment variables keep only their
 * names, bodies such as file contents are shortened, encoded or binary data is summarized by its
 * size, and deep, wide, or circular values are summarized; each cut is marked in place. Arguments that can't be read at all become a short note instead of an error.
 */
export function toolArgumentsPreview(
  args: unknown,
  budget: number = telemetryLimits.previewBytes,
): ToolArgumentsPreview {
  try {
    for (const limits of passes) {
      const pass = new PreviewPass(limits);
      const text = JSON.stringify(pass.value(args, 0, "")) ?? "null";
      if (utf8Length(text, budget) <= budget)
        return { text, truncated: pass.truncated };
    }
    return {
      text: JSON.stringify(`[arguments too large to preview: ${shape(args)}]`),
      truncated: true,
    };
  } catch {
    return {
      text: JSON.stringify("[arguments could not be previewed]"),
      truncated: true,
    };
  }
}

/** One bounded walk over the arguments. */
class PreviewPass {
  // ===========================================
  // State and construction
  // ===========================================

  /** Something was cut, summarized, or redacted away. */
  truncated = false;
  private nodes = 0;
  private scanned = 0;
  private readonly seen = new Set<object>();

  /** Walk within `limits`. */
  constructor(private readonly limits: PreviewLimits) {}

  // ===========================================
  // Values
  // ===========================================

  /** The preview of `value`, found under field `key` at `depth`. */
  value(value: unknown, depth: number, key: string): unknown {
    if (++this.nodes > this.limits.nodes) return this.cut("[not shown]");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number")
      return Number.isFinite(value) ? value : String(value);
    if (typeof value === "string") return this.string(value, key);
    if (typeof value === "bigint")
      return value < largeInteger && value > -largeInteger
        ? `${value}n`
        : this.cut("[large integer]");
    if (typeof value === "undefined") return "[undefined]";
    if (typeof value === "function") return this.cut("[function]");
    if (typeof value === "symbol") return this.cut("[symbol]");
    return this.object(value, depth);
  }

  /** A string, redacted and cut, or summarized when it is encoded or binary data. */
  private string(value: string, key: string): string {
    const encoded = encodedData(value);
    if (encoded) return this.cut(encoded);
    const limit = bodyKeys.has(normalizedKey(key))
      ? this.limits.body
      : this.limits.string;
    const { text, cut } = redactStart(value, limit * 2 + 512);
    const marker = `…[truncated from ${value.length} characters]`;
    const fitted = cut
      ? {
          text: fitUtf8(text, limit - utf8Length(marker), "").text + marker,
          truncated: true,
        }
      : fitUtf8(text, limit, marker);
    if (fitted.truncated) this.truncated = true;
    return fitted.text;
  }

  /** An object or array, summarized when it is too deep, already shown, or a known non-JSON type. */
  private object(value: object, depth: number): unknown {
    if (value instanceof Unread) return this.cut(value.note);
    if (this.seen.has(value)) return this.cut("[circular]");
    const special = specialObject(value);
    if (special) return this.cut(special);
    if (depth >= this.limits.depth) return this.cut(`[${shape(value)}]`);
    this.seen.add(value);
    try {
      return Array.isArray(value)
        ? this.array(value, depth)
        : this.record(value, depth);
    } finally {
      this.seen.delete(value);
    }
  }

  /** The first items of an array, with a count of the rest. */
  private array(value: readonly unknown[], depth: number): unknown[] {
    const shown = Math.min(value.length, this.limits.entries);
    const items: unknown[] = [];
    for (let index = 0; index < shown; index++)
      items.push(this.value(ownValue(value, String(index)), depth + 1, ""));
    if (value.length > shown)
      items.push(this.cut(`[+${value.length - shown} more items]`));
    return items;
  }

  /** The first fields of an object, with a count of the rest. */
  private record(value: object, depth: number): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null);
    const { keys, more, unchecked } = this.keysOf(value);
    for (const key of keys) {
      const name = this.key(key, result);
      const normalized = normalizedKey(key);
      const field = secretKey.test(normalized)
        ? "[redacted]"
        : valueMaps.has(normalized)
          ? this.names(ownValue(value, key), depth + 1)
          : this.value(ownValue(value, key), depth + 1, key);
      Object.defineProperty(result, name, {
        value: field,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    this.markRest(result, more, unchecked);
    return result;
  }

  /**
   * The object's first own enumerable keys, how many more it has, and whether the scan stopped
   * before checking every key, own or inherited, within `objectScanLimit` and `passScanLimit`.
   */
  private keysOf(value: object): {
    keys: string[];
    more: number;
    unchecked: boolean;
  } {
    const keys: string[] = [];
    let more = 0;
    let scanned = 0;
    for (const key in value) {
      if (++scanned > objectScanLimit || ++this.scanned > passScanLimit)
        return { keys, more, unchecked: true };
      if (!Object.hasOwn(value, key)) continue;
      if (keys.length < this.limits.entries) keys.push(key);
      else if (++more >= countedKeys) return { keys, more, unchecked: true };
    }
    return { keys, more, unchecked: false };
  }

  /** Say how many more fields `result` leaves out, or that some weren't checked. */
  private markRest(
    result: Record<string, unknown>,
    more: number,
    unchecked: boolean,
  ): void {
    if (!more && !unchecked) return;
    Object.defineProperty(result, "…", {
      value: this.cut(
        more
          ? `[+${more}${unchecked ? " or more" : ""} more fields]`
          : "[more fields not checked]",
      ),
      enumerable: true,
    });
  }

  /** A map of named values, such as environment variables, by its names only. */
  private names(value: unknown, depth: number): unknown {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value instanceof Unread ||
      depth >= this.limits.depth
    )
      return value === undefined || value === null
        ? value
        : this.cut("[values not recorded]");
    const result: Record<string, unknown> = Object.create(null);
    const { keys, more, unchecked } = this.keysOf(value);
    let shown = 0;
    for (const key of keys) {
      if (++this.nodes > this.limits.nodes) break;
      shown++;
      Object.defineProperty(result, this.key(key, result), {
        value: "[value not recorded]",
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    this.markRest(result, more + keys.length - shown, unchecked);
    this.truncated = true;
    return result;
  }

  /** A field's name, redacted, bounded, and distinct from names already shown. */
  private key(key: string, shown: Record<string, unknown>): string {
    const { text } = redactStart(key, keyBytes * 2 + 512);
    const name = fitUtf8(text, keyBytes, "…").text;
    if (!(name in shown)) return name;
    let suffix = 2;
    while (`${name} (${suffix})` in shown) suffix++;
    return `${name} (${suffix})`;
  }

  /** `note`, recorded as a cut. */
  private cut(note: string): string {
    this.truncated = true;
    return note;
  }
}

/** What stands in for a value the preview doesn't read, such as a getter's. */
class Unread {
  /** Describe the value as `note`. */
  constructor(readonly note: string) {}
}

/** A field's value if it is a plain data property; getters and unreadable fields are not read. */
function ownValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    return "value" in descriptor ? descriptor.value : new Unread("[accessor]");
  } catch {
    return new Unread("[unreadable]");
  }
}

/**
 * A field name without percent-encoding, case, or separators, for matching credential and body
 * names, so `api%5Fkey` reads as `api_key`. Only its first characters are read.
 */
function normalizedKey(key: string): string {
  return decodedPath(key.slice(0, 192))
    .slice(0, 64)
    .toLowerCase()
    .replace(/[\s_.-]/g, "");
}

/** A summary of a string holding encoded or binary data, or undefined for ordinary text. */
function encodedData(value: string): string | undefined {
  const url = dataUrl.exec(value.slice(0, 256));
  if (url)
    return `[data URL${url[1] ? ` of ${url[1]}` : ""}, ${value.length} characters]`;
  if (value.length < 256) return undefined;
  const sample = value.slice(0, 512);
  // Encoded data mixes cases and digits without spaces; a run of one letter is just text.
  if (
    /^[A-Za-z0-9+/=_-]+$/.test(sample) &&
    /[A-Z]/.test(sample) &&
    /[a-z]/.test(sample) &&
    /[0-9]/.test(sample)
  )
    return `[encoded data, ${value.length} characters]`;
  const unreadable = sample.match(/[\u0000-\u0008\u000E-\u001F�]/g);
  if (unreadable && unreadable.length > sample.length / 10)
    return `[binary data, ${value.length} characters]`;
  return undefined;
}

/**
 * The engine's own getters and methods for built-in objects, taken when this module loads, so an
 * instance or subclass that overrides `size`, `byteLength`, `getTime`, or `toISOString` never has
 * its code run. Each checks its object's internal type itself and throws for any other object.
 */
const builtIns = {
  apply: Reflect.apply,
  typedArrayBytes: Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype) as object,
    "byteLength",
  )!.get!,
  dataViewBytes: Object.getOwnPropertyDescriptor(
    DataView.prototype,
    "byteLength",
  )!.get!,
  bufferBytes: Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    "byteLength",
  )!.get!,
  mapSize: Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!,
  setSize: Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!,
  dateTime: Date.prototype.getTime,
  dateIso: Date.prototype.toISOString,
};

/** `method` applied to `value` by the engine, or undefined when `value` isn't its kind. */
function builtIn(method: Function, value: object): unknown {
  try {
    return builtIns.apply(method, value, []);
  } catch {
    return undefined;
  }
}

/**
 * A summary of a built-in object that isn't plain JSON data, such as bytes, a map, or a date, or
 * undefined for anything else, read only through `builtIns`. A proxy has no built-in type, so it is
 * walked as an object, and its traps, which are its own code, can run; that is not guarded against.
 */
function specialObject(value: object): string | undefined {
  for (const method of [
    builtIns.typedArrayBytes,
    builtIns.dataViewBytes,
    builtIns.bufferBytes,
  ]) {
    const bytes = builtIn(method, value);
    if (typeof bytes === "number") return `[binary data, ${bytes} bytes]`;
  }
  const entries = builtIn(builtIns.mapSize, value);
  if (typeof entries === "number") return `[map of ${entries} entries]`;
  const items = builtIn(builtIns.setSize, value);
  if (typeof items === "number") return `[set of ${items} items]`;
  const time = builtIn(builtIns.dateTime, value);
  if (typeof time === "number")
    return Number.isNaN(time)
      ? "[invalid date]"
      : String(builtIn(builtIns.dateIso, value));
  return undefined;
}

/** What a value is, without its contents, such as `object with 3 fields`. */
function shape(value: unknown): string {
  if (Array.isArray(value)) return `array of ${value.length} items`;
  if (value && typeof value === "object") {
    let fields = 0;
    let scanned = 0;
    for (const key in value) {
      if (++scanned > objectScanLimit)
        return `object with ${fields} or more fields`;
      if (Object.hasOwn(value, key)) fields++;
      if (fields >= countedKeys)
        return `object with ${countedKeys} or more fields`;
    }
    return `object with ${fields} field${fields === 1 ? "" : "s"}`;
  }
  return typeof value;
}
