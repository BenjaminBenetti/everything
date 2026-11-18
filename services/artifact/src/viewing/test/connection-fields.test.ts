import assert from "node:assert/strict";
import { Agent, type RequestListener } from "node:http";
import { test } from "node:test";
import {
  appRoutes,
  exchange,
  hostStack,
  type AppServer,
} from "./host-stack.js";

/** An app that reads each request's body whole, notes it, and then answers. */
function readingApp() {
  const bodies: string[] = [];
  const listener: RequestListener = (request, response) => {
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      bodies.push(Buffer.concat(parts).toString());
      response.end("received");
    });
  };
  return { listener, bodies };
}

test("each host keeps the viewer's connection fields from the app, and a field the viewer names cannot remove one the host sets", async (context) => {
  const notes = readingApp();
  const board = readingApp();
  const { notesApp, boardApp, ports } = await hostStack(context, {
    notes: notes.listener,
    board: board.listener,
  });
  for (const [index, route] of appRoutes(ports).entries()) {
    const app: AppServer = [notesApp, boardApp][index]!;
    const answer = await exchange(`${route.url}/form?step=1`, {
      method: "POST",
      headers: {
        ...route.headers,
        connection: "keep-alive, x-viewer-hop, x-forwarded-prefix, host",
        "x-viewer-hop": "1",
        "keep-alive": "timeout=30",
        "proxy-connection": "keep-alive",
        te: "trailers",
        upgrade: "h2c",
        expect: "100-continue",
        "x-viewer-end": "kept",
        "content-type": "text/plain",
      },
      body: ["form ", "body"],
    });
    assert.deepEqual([answer.status, answer.body], [200, "received"]);
    const { path, headers } = app.received.at(-1)!;
    assert.equal(path, "/form?step=1");
    for (const name of [
      "x-viewer-hop",
      "keep-alive",
      "proxy-connection",
      "te",
      "upgrade",
      "expect",
      "x-api-key",
    ])
      assert.equal(headers[name], undefined, `${route.app}: ${name}`);
    assert.equal(headers.connection, "keep-alive", "the host's own connection");
    assert.equal(headers.host, `127.0.0.1:${app.port}`);
    assert.equal(headers["x-forwarded-prefix"], `/${route.app}`);
    assert.equal(headers["x-forwarded-host"], route.headers.host);
    assert.equal(headers["x-viewer-end"], "kept");
    assert.equal([notes, board][index]!.bodies.at(-1), "form body");
  }
});

test(
  "each host frames the bodies it forwards: chunked and sized uploads arrive whole, and a request whose body it does not forward declares none",
  { timeout: 10_000 },
  async (context) => {
    const notes = readingApp();
    const board = readingApp();
    const { notesApp, boardApp, ports } = await hostStack(context, {
      notes: notes.listener,
      board: board.listener,
    });
    for (const [index, route] of appRoutes(ports).entries()) {
      const app: AppServer = [notesApp, boardApp][index]!;
      const { bodies } = [notes, board][index]!;
      const deleted = await exchange(`${route.url}/items/1`, {
        method: "DELETE",
        headers: {
          ...route.headers,
          "transfer-encoding": "chunked",
          "content-type": "text/plain",
        },
        body: ["first ", "second"],
      });
      assert.equal(deleted.status, 200, route.app);
      assert.equal(bodies.at(-1), "first second");
      assert.equal(app.received.at(-1)!.headers["content-length"], undefined);
      assert.equal(
        app.received.at(-1)!.headers["transfer-encoding"],
        "chunked",
      );
      const put = await exchange(`${route.url}/items/1`, {
        method: "PUT",
        headers: {
          ...route.headers,
          "content-type": "text/plain",
          "content-length": "10",
        },
        body: ["sized body"],
      });
      assert.equal(put.status, 200, route.app);
      assert.equal(bodies.at(-1), "sized body");
      assert.equal(app.received.at(-1)!.headers["content-length"], "10");
      // Some search APIs send a body with GET; the host forwards none, so it declares none.
      const query = JSON.stringify({ query: "notes" });
      const searched = await exchange(`${route.url}/search`, {
        headers: {
          ...route.headers,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(query)),
        },
        body: [query],
      });
      assert.equal(searched.status, 200, route.app);
      assert.equal(bodies.at(-1), "");
      for (const name of ["content-length", "transfer-encoding"])
        assert.equal(app.received.at(-1)!.headers[name], undefined, name);
    }
  },
);

test("each host keeps the app's connection fields from the viewer, relays its end-to-end fields, and keeps the viewer's connection open", async (context) => {
  const responder: RequestListener = (_request, response) => {
    response.statusCode = 201;
    response.setHeader("connection", "x-app-hop, close");
    response.setHeader("keep-alive", "timeout=5");
    response.setHeader("proxy-connection", "close");
    response.setHeader("upgrade", "h2c");
    response.setHeader("x-app-hop", "1");
    response.setHeader("x-app-end", "kept");
    response.setHeader("set-cookie", ["first=1; Path=/", "second=2; Path=/"]);
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader("content-length", 9);
    response.end("app reply");
  };
  const { ports } = await hostStack(context, {
    notes: responder,
    board: responder,
  });
  for (const route of appRoutes(ports)) {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const answer = await exchange(`${route.url}/`, {
        headers: route.headers,
        agent,
      });
      assert.equal(answer.status, 201, route.app);
      assert.equal(answer.body, "app reply");
      assert.equal(answer.headers["content-type"], "text/plain; charset=utf-8");
      assert.equal(answer.headers["content-length"], "9");
      assert.deepEqual(answer.headers["set-cookie"], [
        "first=1; Path=/",
        "second=2; Path=/",
      ]);
      assert.equal(answer.headers["x-app-end"], "kept");
      for (const name of ["x-app-hop", "proxy-connection", "upgrade"])
        assert.equal(answer.headers[name], undefined, `${route.app}: ${name}`);
      // The host's own connection fields, not the app's.
      assert.equal(answer.headers.connection, "keep-alive");
      assert.notEqual(answer.headers["keep-alive"], "timeout=5");
      // The app closed its own connection; the viewer's stays open for its next request.
      const next = await exchange(`${route.url}/`, {
        headers: route.headers,
        agent,
      });
      assert.deepEqual([next.status, next.reused], [201, true], route.app);
      // A HEAD answer keeps the app's length and no body, and the connection still serves.
      const head = await exchange(`${route.url}/`, {
        method: "HEAD",
        headers: route.headers,
        agent,
      });
      assert.deepEqual(
        [head.status, head.headers["content-length"], head.body, head.reused],
        [201, "9", "", true],
        route.app,
      );
      const after = await exchange(`${route.url}/`, {
        headers: route.headers,
        agent,
      });
      assert.deepEqual(
        [after.status, after.body, after.reused],
        [201, "app reply", true],
        route.app,
      );
    } finally {
      agent.destroy();
    }
  }
});
