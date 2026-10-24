import assert from "node:assert/strict";
import { test } from "node:test";
import { SpanKind } from "@opentelemetry/api";
import { TracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { telemetryLimits } from "@everything/telemetry-contracts";
import { exportableSpan } from "../adapter/redacting-exporters.js";
import { telemetryAttributes as attribute } from "../model/telemetry-attributes.js";
import {
  messageGapMarker,
  messagePreview,
} from "../service/message-preview.js";
import { sqlStatementPreview } from "../service/sql-statement.js";
import {
  exportableAttributes,
  type ExportPolicy,
} from "../service/telemetry-allowlist.js";
import {
  fitUtf8,
  utf8Head,
  utf8Length,
  utf8Tail,
} from "../service/text-budget.js";
import { toolArgumentsPreview } from "../service/tool-arguments-preview.js";

/** The preview budget every preview must fit, in UTF-8 bytes. */
const budget = telemetryLimits.previewBytes;

/** A synthetic key in a shape the redactor recognizes. */
const key = "sk-proj-abcdefghijklmnopqrstuvwx";

/** Whether `text` is valid UTF-16 with no half of a surrogate pair, so it encodes as UTF-8. */
function wellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    text,
  );
}

// ===========================================
// UTF-8 budgets
// ===========================================

test("text is cut to a UTF-8 byte budget on whole characters, never half of one", () => {
  const text = "a😀b€c";
  assert.equal(utf8Length(text), 1 + 4 + 1 + 3 + 1);
  assert.equal(utf8Head(text, 4), "a", "the emoji doesn't fit in the rest");
  assert.equal(utf8Head(text, 5), "a😀");
  assert.equal(utf8Tail(text, 4), "€c");
  assert.equal(utf8Tail(text, 9), "😀b€c");
  // Halves of surrogate pairs become replacement characters, which encode as three bytes.
  const broken = "x\uD83Dy\uDE00z";
  assert.equal(utf8Head(broken, 100), "x�y�z");
  assert.equal(utf8Tail(broken, 100), "x�y�z");
  assert.equal(utf8Length(broken), 9);
  for (const size of [0, 1, 2, 3, 4, 5, 6, 7, 8])
    assert.ok(wellFormed(utf8Head("😀😀", size)), String(size));
  const fitted = fitUtf8("é".repeat(100), 20, "…");
  assert.ok(fitted.truncated);
  assert.ok(utf8Length(fitted.text) <= 20);
  assert.ok(fitted.text.endsWith("…"));
  assert.deepEqual(fitUtf8("short", 20, "…"), {
    text: "short",
    truncated: false,
  });
});

// ===========================================
// Messages
// ===========================================

test("a short message is previewed whole, with credentials redacted and its length kept", () => {
  const message = `Deploy with password=hunter2 and ${key} 👋`;
  const preview = messagePreview(message);
  assert.equal(
    preview.text,
    "Deploy with password=[redacted] and [redacted] 👋",
  );
  assert.equal(preview.truncated, false);
  assert.equal(
    preview.length,
    message.length - 1,
    "the original's characters, with the emoji counted once",
  );
});

test("a long message keeps its start and its end, where a question after a paste is, within the budget", () => {
  const message = `Here is the log:\n${"connection reset by peer at 10:42\n".repeat(2_000)}Why does the teammate stop replying? ${key}`;
  const preview = messagePreview(message);
  assert.ok(preview.truncated);
  assert.equal(preview.length, message.length);
  assert.ok(utf8Length(preview.text) <= budget);
  assert.ok(preview.text.startsWith("Here is the log:\nconnection reset"));
  assert.ok(preview.text.includes(messageGapMarker));
  assert.ok(
    preview.text.endsWith("Why does the teammate stop replying? [redacted]"),
  );
  assert.ok(!preview.text.includes(key), "the end is redacted too");
});

test("a message just over the budget, or made of wide characters, never repeats or splits a character", () => {
  for (const message of [
    "word ".repeat(budget / 5 - 2) + " middle " + "end ".repeat(50),
    "日本語のテキスト".repeat(400),
    "😀".repeat(1_000),
    `${"\uD83D".repeat(10)}${"z ".repeat(1_500)}`,
  ]) {
    const preview = messagePreview(message);
    assert.ok(preview.truncated);
    assert.ok(utf8Length(preview.text) <= budget);
    assert.ok(wellFormed(preview.text));
  }
});

test("a pasted blob or private key in a message is redacted rather than stored", () => {
  const blob = "QUJD".repeat(5_000);
  const preview = messagePreview(
    `Here's the screenshot: data:image/png;base64,${blob}\n-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----\nThanks`,
  );
  assert.ok(!preview.text.includes("QUJDQUJD"));
  assert.ok(!preview.text.includes("MIIEv"));
  assert.ok(preview.text.endsWith("Thanks"));
});

// ===========================================
// Tool arguments
// ===========================================

test("tool arguments are structured JSON with secrets, bodies, blobs, and depth summarized, and the arguments unchanged", () => {
  const args = {
    path: "notes/plan.md",
    content: `# Plan\n${"Write the launch checklist.\n".repeat(400)}`,
    password: "hunter2",
    apiKey: "plain-but-named-like-a-key",
    max_tokens: 4_096,
    headers: { Authorization: `Bearer ${key}` },
    command: `curl https://admin:dbsecret@db.internal/backup?token=${key}`,
    image: `data:image/png;base64,${"iVBORw0KGgo".repeat(400)}`,
    nested: { one: { two: { three: { four: { five: true } } } } },
    items: Array.from({ length: 30 }, (_, index) => index),
  };
  const before = structuredClone(args);
  const preview = toolArgumentsPreview(args);
  assert.deepEqual(args, before, "previewing never changes the arguments");
  assert.ok(preview.truncated);
  assert.ok(utf8Length(preview.text) <= budget);
  const parsed = JSON.parse(preview.text) as Record<string, unknown>;
  assert.equal(parsed.path, "notes/plan.md");
  assert.equal(parsed.password, "[redacted]");
  assert.equal(parsed.apiKey, "[redacted]");
  assert.equal(parsed.max_tokens, 4_096, "a token count stays readable");
  assert.deepEqual(
    parsed.headers,
    { Authorization: "[value not recorded]" },
    "headers keep their names only",
  );
  assert.match(String(parsed.content), /^# Plan\nWrite the launch/);
  assert.match(String(parsed.content), /…\[truncated from \d+ characters\]$/);
  assert.match(
    String(parsed.image),
    /^\[data URL of image\/png, \d+ characters\]$/,
  );
  assert.ok(!String(parsed.command).includes("dbsecret"));
  assert.ok(!preview.text.includes(key));
  assert.ok(!preview.text.includes("hunter2"));
  assert.ok(!preview.text.includes("iVBORw0KGgo"));
  assert.match(JSON.stringify(parsed.nested), /\[object with 1 field\]/);
  assert.equal((parsed.items as unknown[]).at(-1), "[+6 more items]");
});

test("environment variables, build arguments, and headers keep their names but never their values", () => {
  const preview = toolArgumentsPreview({
    app: "billing",
    env: {
      STRIPE_KEY: "sk_live_shortsecret",
      DATABASE_URL: "postgresql://admin:dbsecret@db/billing",
      FEATURE_FLAG: "on",
    },
    buildArgs: { NPM_TOKEN: "npm-build-secret", NODE_ENV: "production" },
    headers: { "X-Api-Key": "header-secret" },
  });
  const parsed = JSON.parse(preview.text) as Record<string, unknown>;
  assert.deepEqual(parsed.env, {
    STRIPE_KEY: "[value not recorded]",
    DATABASE_URL: "[value not recorded]",
    FEATURE_FLAG: "[value not recorded]",
  });
  assert.deepEqual(parsed.buildArgs, {
    NPM_TOKEN: "[value not recorded]",
    NODE_ENV: "[value not recorded]",
  });
  assert.deepEqual(parsed.headers, { "X-Api-Key": "[value not recorded]" });
  assert.equal(parsed.app, "billing");
  assert.ok(preview.truncated, "values left out count as summarized");
  for (const secret of [
    "sk_live_shortsecret",
    "dbsecret",
    "npm-build-secret",
    "header-secret",
  ])
    assert.ok(!preview.text.includes(secret), secret);
  assert.equal(
    JSON.parse(toolArgumentsPreview({ env: "A=1 SECRET=x" }).text).env,
    "[values not recorded]",
    "a value map given as text is left out too",
  );
});

test("circular, accessor, proxy, and non-JSON arguments are summarized without running their code", () => {
  let read = false;
  const args: Record<string, unknown> = {
    get secretGetter() {
      read = true;
      return "never";
    },
    when: new Date("2026-10-24T00:00:00Z"),
    bytes: new Uint8Array(32),
    map: new Map([["a", 1]]),
    call: () => "never",
    big: 12n,
    missing: undefined,
    toJSON: () => ({ replaced: true }),
    ["__proto__"]: "kept as a field",
  };
  args.self = args;
  const preview = toolArgumentsPreview(args);
  assert.equal(read, false, "the getter never ran");
  const parsed = JSON.parse(preview.text) as Record<string, unknown>;
  assert.equal(parsed.secretGetter, "[accessor]");
  assert.equal(parsed.when, "2026-10-24T00:00:00.000Z");
  assert.equal(parsed.bytes, "[binary data, 32 bytes]");
  assert.equal(parsed.map, "[map of 1 entries]");
  assert.equal(parsed.call, "[function]");
  assert.equal(parsed.big, "12n");
  assert.equal(parsed.toJSON, "[function]", "toJSON is never called");
  assert.equal(parsed.self, "[circular]");
  assert.ok(preview.truncated);
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("hostile");
      },
    },
  );
  assert.deepEqual(toolArgumentsPreview(hostile), {
    text: JSON.stringify("[arguments could not be previewed]"),
    truncated: true,
  });
});

test("huge, wide, and deep arguments are previewed in bounded work and within the budget", () => {
  const wide = Object.fromEntries(
    Array.from({ length: 50_000 }, (_, index) => [`field${index}`, index]),
  );
  const deep: Record<string, unknown> = {};
  let level = deep;
  for (let index = 0; index < 10_000; index++) {
    const next = {};
    level.next = next;
    level = next;
  }
  const long = { text: "word ".repeat(2_000_000) };
  for (const args of [wide, deep, long, "plain string argument", 42, null]) {
    const started = performance.now();
    const preview = toolArgumentsPreview(args);
    assert.ok(performance.now() - started < 1_000, "bounded work");
    assert.ok(utf8Length(preview.text) <= budget);
    JSON.parse(preview.text);
  }
  const parsed = JSON.parse(toolArgumentsPreview(wide).text) as Record<
    string,
    unknown
  >;
  assert.equal(parsed["…"], "[+1000 or more more fields]");
});

// ===========================================
// SQL statements
// ===========================================

test("an SQL statement keeps its shape and placeholders, while every literal, comment, and credential goes", () => {
  assert.deepEqual(
    sqlStatementPreview(
      'SELECT "m"."id" AS "m_id" FROM "messages" "m" WHERE "m"."owner_id" = $1 AND "token" = $2 ORDER BY "m"."created_at" DESC LIMIT 51',
    ),
    {
      text: 'SELECT "m"."id" AS "m_id" FROM "messages" "m" WHERE "m"."owner_id" = $1 AND "token" = $2 ORDER BY "m"."created_at" DESC LIMIT ?',
      truncated: false,
    },
  );
  for (const [statement, shape] of [
    [
      "CREATE ROLE artifact_x LOGIN PASSWORD 'hunter2'",
      "CREATE ROLE artifact_x LOGIN PASSWORD ?",
    ],
    ["SELECT E'it\\'s secret', 'it''s secret' FROM t", "SELECT ?, ? FROM t"],
    [
      "DO $body$ BEGIN PERFORM 'secret'; END $body$; SELECT $$secret$$",
      "DO ?; SELECT ?",
    ],
    [
      "SELECT 3.14, 1e-5, 0x1F, -42, table2 FROM t",
      "SELECT ?, ?, ?, -?, table2 FROM t",
    ],
    [
      "SELECT 1 /* secret /* nested secret */ still secret */ -- secret\nFROM t",
      "SELECT ? FROM t",
    ],
    [
      "SELECT * FROM t WHERE dsn = 'postgresql://admin:dbsecret@db/everything'",
      "SELECT * FROM t WHERE dsn = ?",
    ],
    [`SELECT * FROM "${key}"`, 'SELECT * FROM "[redacted]"'],
  ] as const)
    assert.equal(sqlStatementPreview(statement).text, shape, statement);
});

test("a statement cut before it was recorded, or longer than the budget, says so", () => {
  for (const statement of [
    "SELECT * FROM t WHERE note = 'cut in the middle of a lit",
    "SELECT * FROM t /* a comment that never ends",
  ]) {
    const preview = sqlStatementPreview(statement);
    assert.ok(preview.truncated, statement);
    assert.ok(!preview.text.includes("lit") && !preview.text.includes("never"));
    assert.ok(preview.text.endsWith("…[truncated]"));
  }
  assert.ok(sqlStatementPreview("SELECT 1", { cut: true }).truncated);
  const wide = sqlStatementPreview(
    `SELECT ${Array.from({ length: 500 }, (_, index) => `"column_${index}"`).join(", ")} FROM t`,
  );
  assert.ok(wide.truncated);
  assert.ok(utf8Length(wide.text) <= budget);
});

// ===========================================
// The export boundary
// ===========================================

/** Spans made by a tracer of their own, as instrumented libraries' are, for the exporter's view. */
const tracer = new TracerProvider().getTracer("content-previews-test");

/** Content recorded, and withheld; error text recorded either way. */
const recorded: ExportPolicy = { includeErrorText: true, includeContent: true };
const withheld: ExportPolicy = {
  includeErrorText: true,
  includeContent: false,
};

test("content previews are exported only when the installation records content, and marked when withheld", () => {
  const attributes = {
    [attribute.messagePreview]: "Plan the launch",
    [attribute.messageLength]: 15,
    [attribute.messageTruncated]: false,
    [attribute.toolArguments]: '{"path":"a.txt"}',
    [attribute.toolArgumentsTruncated]: false,
    [attribute.dbQueryText]: "SELECT * FROM t WHERE a = $1",
  };
  const kept = exportableAttributes(attributes, recorded);
  assert.deepEqual(kept, attributes);
  const dropped = exportableAttributes(attributes, withheld);
  assert.deepEqual(dropped, {});
  const span = tracer.startSpan("teammate.turn", { attributes });
  span.end();
  const view = exportableSpan(span as unknown as ReadableSpan, withheld);
  assert.equal(view.attributes[attribute.contentWithheld], true);
  assert.equal(view.attributes[attribute.messagePreview], undefined);
  const shown = exportableSpan(span as unknown as ReadableSpan, recorded);
  assert.equal(shown.attributes[attribute.contentWithheld], undefined);
  assert.equal(shown.attributes[attribute.messagePreview], "Plan the launch");
});

test("content that reaches the export boundary unshaped is shaped, redacted, and bounded there", () => {
  const exported = exportableAttributes(
    {
      [attribute.messagePreview]: `password=hunter2 ${"long ".repeat(2_000)}`,
      [attribute.toolArguments]: JSON.stringify({ token: key, note: "x" }),
      [attribute.dbQueryText]: "SELECT * FROM t WHERE secret = 'sql-secret'",
      [attribute.dbStatement]: "UPDATE t SET a = 'older-convention-secret'",
      "db.postgresql.values": ["parameter-secret"],
    },
    recorded,
  );
  const text = JSON.stringify(exported);
  for (const secret of [
    "hunter2",
    key,
    "sql-secret",
    "older-convention-secret",
    "parameter-secret",
  ])
    assert.ok(!text.includes(secret), secret);
  assert.ok(utf8Length(String(exported[attribute.messagePreview])) <= budget);
  assert.deepEqual(JSON.parse(String(exported[attribute.toolArguments])), {
    token: "[redacted]",
    note: "x",
  });
  assert.equal(
    exported[attribute.dbQueryText],
    "SELECT * FROM t WHERE secret = ?",
  );
  assert.equal(exported["db.postgresql.values"], undefined);
});

test("exported links keep only the IDs of the spans that started the work", () => {
  const origin = tracer.startSpan("POST /v1/agents/:agentId/messages", {
    kind: SpanKind.SERVER,
  });
  const linked = tracer.startSpan("teammate.turn", {
    root: true,
    links: [
      {
        context: origin.spanContext(),
        attributes: { "link.secret": "link-attribute-secret" },
      },
    ],
  });
  linked.end();
  origin.end();
  const view = exportableSpan(linked as unknown as ReadableSpan, recorded);
  assert.deepEqual(view.links, [
    {
      context: {
        traceId: origin.spanContext().traceId,
        spanId: origin.spanContext().spanId,
        traceFlags: origin.spanContext().traceFlags,
      },
    },
  ]);
  assert.ok(!JSON.stringify(view.links).includes("link-attribute-secret"));
});
