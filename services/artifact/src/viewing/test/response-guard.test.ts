import assert from "node:assert/strict";
import { createServer, get, type RequestListener } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { test, type TestContext } from "node:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import Fastify from "fastify";
import replyFrom from "@fastify/reply-from";
import { MemoryArtifacts } from "../../artifact/test/artifact-fixture.js";
import { ArtifactProxy } from "../adapter/artifact-proxy.js";
import { AppResponseBlockedError } from "../error/app-response-blocked-error.js";
import type { ArtifactResponseSecrets } from "../interface/artifact-response-secrets.js";
import { AppResponseGuard } from "../service/app-response-guard.js";
import { SecretMatcher } from "../service/secret-matcher.js";

const secret = "TestClientSecret9aBcDeF0123456789";

/** Run the real reply-from transport against a local app while retaining production proxy behavior. */
async function fixture(
  context: TestContext,
  listener: RequestListener,
  secrets: ArtifactResponseSecrets = { read: async () => [secret] },
) {
  const upstream = createServer(listener);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const logs: string[] = [];
  const app = Fastify({
    logger: {
      stream: {
        write: (line: string) => {
          logs.push(line);
        },
      },
    },
  });
  await app.register(replyFrom, { disableRequestLogging: true });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, payload, done) =>
    done(null, payload),
  );
  const artifact = new MemoryArtifacts().add("dynamic", "app", {
    liveDeployment: 1,
    running: true,
  });
  const proxy = new ArtifactProxy(
    "apps",
    ["host-session"],
    secrets,
    new AppResponseGuard(),
  );
  app.addHook("onRequest", async (_request, reply) => {
    const from = reply.from.bind(reply);
    /** Substitute only the network destination; exercise the production forwarding hooks. */
    reply.from = (source, options) => {
      const url = new URL(source!);
      assert.ok(url.hostname.endsWith(".apps.svc.cluster.local"));
      return from(
        `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
        options,
      );
    };
  });
  app.all("/app/*", async (request, reply) =>
    proxy.forward(request, reply, artifact, request.url.slice(4)),
  );
  context.after(async () => {
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    assert.ok(
      logs.every((line) => !line.includes(secret)),
      "request logs must not contain the secret",
    );
  });
  return { app, upstream };
}

test("secret matching withholds every possible split and preserves safe partial matches", async () => {
  const matcher = new SecretMatcher([secret]);
  for (let split = 1; split < secret.length; split++) {
    const emitted: Buffer[] = [];
    await assert.rejects(async () => {
      for await (const chunk of matcher.scan(
        Readable.from([
          Buffer.from(`safe!${secret.slice(0, split)}`),
          Buffer.from(`${secret.slice(split)}!end`),
        ]),
      ))
        emitted.push(chunk);
    }, AppResponseBlockedError);
    assert.equal(Buffer.concat(emitted).toString(), "safe!");
  }
  const safe = `safe!${secret.slice(0, -1)}`;
  const chunks = [];
  for await (const chunk of matcher.scan(
    Readable.from([...Buffer.from(safe)].map((byte) => Buffer.from([byte]))),
  ))
    chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), safe);
});

test("blocks credentials in HTML, scripts, JSON, and common encodings", async (context) => {
  const unicode = secret
    .split("")
    .map(
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
    .join("");
  const bodies = [
    Buffer.from(`<html>${secret}</html>`),
    Buffer.from(`window.clientSecret = '${secret}';`),
    Buffer.from(JSON.stringify({ secret })),
    Buffer.from(Buffer.from(secret).toString("base64")),
    Buffer.from(unicode),
    Buffer.from(secret, "utf16le"),
  ];
  const { app } = await fixture(context, (_request, response) =>
    response.end(bodies.shift()),
  );
  const count = bodies.length;
  for (let index = 0; index < count; index++) {
    const response = await app.inject("/app/leak");
    assert.equal(response.statusCode, 502);
    assert.match(response.body, /response was blocked/);
    assert.ok(!response.body.includes(secret));
    assert.equal(response.headers["cache-control"], "no-store");
  }
  const special = "credential+with/slash?and=padding";
  const matcher = new SecretMatcher([special]);
  assert.throws(
    () => matcher.check(Buffer.from(encodeURIComponent(special))),
    AppResponseBlockedError,
  );
});

test("blocks header leaks before redirects, cookies, or HEAD responses reach the viewer", async (context) => {
  const { app } = await fixture(context, (request, response) => {
    if (request.url === "/redirect") {
      response.statusCode = 302;
      response.setHeader("location", `https://example.test/?secret=${secret}`);
    } else if (request.url === "/cookies") {
      response.setHeader("set-cookie", ["safe=cookie", `credential=${secret}`]);
    } else response.setHeader("x-client-secret", secret);
    response.end("safe body");
  });
  for (const method of ["GET", "HEAD"] as const) {
    for (const path of ["headers", "redirect", "cookies"]) {
      const response = await app.inject({ method, url: `/app/${path}` });
      assert.equal(response.statusCode, 502);
      for (const name of ["location", "set-cookie", "x-client-secret"])
        assert.equal(response.headers[name], undefined);
      assert.ok(!JSON.stringify(response.headers).includes(secret));
    }
  }
});

test("decodes gzip, deflate, Brotli, and stacked encodings before scanning", async (context) => {
  const codings = [
    { name: "gzip", encode: gzipSync },
    { name: "deflate", encode: deflateSync },
    { name: "br", encode: brotliCompressSync },
    {
      name: "gzip, br",
      encode: (value: string) => brotliCompressSync(gzipSync(value)),
    },
  ];
  let selected = codings[0]!;
  const { app } = await fixture(context, (request, response) => {
    assert.equal(request.headers["accept-encoding"], "identity");
    const body = selected.encode(
      request.url === "/safe" ? "safe compressed content!" : secret,
    );
    response.setHeader("content-encoding", selected.name);
    response.setHeader("content-length", body.length);
    response.setHeader("etag", '"encoded"');
    response.end(body);
  });
  for (const coding of codings) {
    selected = coding;
    assert.equal((await app.inject("/app/leak")).statusCode, 502);
    const safe = await app.inject("/app/safe");
    assert.equal(safe.statusCode, 200);
    assert.equal(safe.body, "safe compressed content!");
    assert.equal(safe.headers["content-encoding"], undefined);
    assert.equal(safe.headers["content-length"], undefined);
    assert.equal(safe.headers.etag, undefined);
  }
});

test("fails closed for unsupported or broken compression and unsolicited partial or cached responses", async (context) => {
  const { app } = await fixture(context, (request, response) => {
    switch (request.url) {
      case "/unsupported":
        response.setHeader("content-encoding", "unknown");
        break;
      case "/broken":
        response.setHeader("content-encoding", "gzip");
        break;
      case "/partial":
        response.statusCode = 206;
        break;
      case "/cached":
        response.statusCode = 304;
        break;
    }
    response.end("uninspectable");
  });
  for (const path of ["unsupported", "broken", "partial", "cached"]) {
    assert.equal((await app.inject(`/app/${path}`)).statusCode, 502, path);
  }
});

test("safe API requests preserve methods, payloads, app cookies, redirects, and binary bytes", async (context) => {
  const binary = Buffer.from([0, 255, 3, 128, 13, 10]);
  const { app } = await fixture(context, (request, response) => {
    assert.equal(request.url, "/items?limit=2");
    assert.equal(request.headers.cookie, "theme=dark");
    assert.equal(request.headers.authorization, "Bearer app-owned-token");
    assert.equal(request.headers["x-forwarded-prefix"], "/app");
    for (const name of [
      "range",
      "if-range",
      "if-none-match",
      "if-modified-since",
    ])
      assert.equal(request.headers[name], undefined);
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      assert.equal(
        Buffer.concat(parts).toString(),
        request.method === "POST" ? '{"item":1}' : "",
      );
      response.statusCode = 201;
      response.setHeader("location", "/items/1");
      response.setHeader("set-cookie", "app-cookie=ok");
      response.end(binary);
    });
  });
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
    const response = await app.inject({
      method,
      url: "/app/items?limit=2",
      headers: {
        cookie: "host-session=private; theme=dark",
        authorization: "Bearer app-owned-token",
        range: "bytes=0-10",
        "if-range": '"old"',
        "if-none-match": '"old"',
        "if-modified-since": "yesterday",
        "content-type": "application/json",
      },
      ...(method === "POST" ? { payload: '{"item":1}' } : {}),
    });
    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.rawPayload, binary);
    assert.equal(response.headers.location, "/app/items/1");
    assert.equal(response.headers["set-cookie"], "app-cookie=ok");
  }
});

test("apps without provisioned credentials retain ordinary response behavior", async (context) => {
  const body = gzipSync("app without credentials");
  const { app } = await fixture(
    context,
    (request, response) => {
      assert.equal(request.headers.range, "bytes=0-10");
      response.statusCode = 206;
      response.setHeader("content-encoding", "gzip");
      response.setHeader("cache-control", "public, max-age=60");
      response.end(body);
    },
    { read: async () => [] },
  );
  const response = await app.inject({
    url: "/app/file",
    headers: { range: "bytes=0-10" },
  });
  assert.equal(response.statusCode, 206);
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.deepEqual(response.rawPayload, body);
});

test("credential lookup failures block before forwarding and after receiving the response", async (context) => {
  for (const failAt of [1, 2]) {
    await context.test(`lookup ${failAt}`, async (child) => {
      let reads = 0;
      let requests = 0;
      const { app } = await fixture(
        child,
        (_request, response) => {
          requests++;
          response.end("safe");
        },
        {
          /** Simulate a storage failure whose raw error must never reach logs or callers. */
          read: async () => {
            if (++reads === failAt) throw new Error(secret);
            return [secret];
          },
        },
      );
      const response = await app.inject("/app/");
      assert.equal(response.statusCode, 502);
      assert.equal(requests, failAt - 1);
      assert.ok(!response.body.includes(secret));
    });
  }
});

test("credentials provisioned or rotated during an upstream request are inspected", async (context) => {
  for (const original of [[], ["previous-client-secret"]]) {
    await context.test(`initial count ${original.length}`, async (child) => {
      let reads = 0;
      const { app } = await fixture(
        child,
        (_request, response) => response.end(secret),
        {
          read: async () => (++reads === 1 ? original : [secret]),
        },
      );
      assert.equal((await app.inject("/app/")).statusCode, 502);
    });
  }
});

test(
  "safe SSE events arrive promptly and a later split secret aborts without releasing its prefix",
  { timeout: 10000 },
  async (context) => {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app } = await fixture(context, (_request, response) => {
      response.setHeader("content-type", "text/event-stream");
      response.write("data: safe\n\n");
      void next.then(() => {
        response.write(`data: ${secret.slice(0, 15)}`);
        setTimeout(() => response.end(`${secret.slice(15)}\n\n`), 20);
      });
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const received: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      get(`${address}/app/events`, (response) => {
        response.on("data", (chunk: Buffer) => {
          received.push(chunk);
          release();
        });
        response.on("aborted", resolve);
        response.on("end", () =>
          reject(new Error("a leaking stream must be terminated")),
        );
        response.on("error", () => {});
      }).on("error", reject);
    });
    assert.equal(Buffer.concat(received).toString(), "data: safe\n\ndata: ");
  },
);
