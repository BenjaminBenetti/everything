import assert from "node:assert/strict";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { once } from "node:events";
import {
  request as httpRequest,
  type ClientRequest,
  type RequestListener,
} from "node:http";
import { test } from "node:test";
import {
  hostStack,
  notesKey,
  origins,
  send,
  sendRaw,
  type AppServer,
} from "./host-stack.js";

/** A response that is still arriving. */
interface Streamed {
  readonly request: ClientRequest;
  /** Everything received so far. */
  received(): string;
  /** Whether the response arrived whole or was cut off. */
  readonly outcome: Promise<"complete" | "cut off">;
}

/** How a viewer reaches each host's dynamic app: the private app, notes, with its API key, and the public app, board. */
function appRoutes(ports: {
  readonly artifact: number;
  readonly publicApps: number;
}) {
  return [
    {
      app: "notes",
      url: `http://127.0.0.1:${ports.artifact}/notes`,
      headers: { host: new URL(origins.artifact).host, "x-api-key": notesKey },
    },
    {
      app: "board",
      url: `http://127.0.0.1:${ports.publicApps}/board`,
      headers: { host: new URL(origins.publicApps).host },
    },
  ];
}

/** An app that answers /events with one event and holds the stream open, noting when each one closes. */
function holdingApp() {
  const closed: Promise<unknown>[] = [];
  const listener: RequestListener = (request, response) => {
    if (request.url !== "/events") {
      response.end("still serving");
      return;
    }
    closed.push(once(response, "close"));
    response.setHeader("content-type", "text/event-stream");
    response.write("data: first\n\n");
  };
  return { listener, closed };
}

/** Open a response on its own connection and resolve once its first bytes arrive. */
function openStream(
  url: string,
  headers: Record<string, string>,
): Promise<Streamed> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      const outcome = new Promise<"complete" | "cut off">((settle) =>
        response.once("close", () =>
          settle(response.complete ? "complete" : "cut off"),
        ),
      );
      response.on("error", () => {});
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (chunks.length === 1)
          resolve({
            request,
            received: () => Buffer.concat(chunks).toString(),
            outcome,
          });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

test("both hosts forward to their apps with Node's HTTP client, not reply-from's bundled Undici client", async (context) => {
  const { notesApp, boardApp, ports } = await hostStack(context);
  const viaNode: string[] = [];
  const viaUndici: string[] = [];
  // Both clients publish each outgoing request on their documented diagnostics channels.
  const onNode = (message: unknown) => {
    const { request } = message as { request: ClientRequest };
    viaNode.push(String(request.getHeader("host")));
  };
  const onUndici = (message: unknown) => {
    const { request } = message as { request: { origin: unknown } };
    viaUndici.push(new URL(String(request.origin)).host);
  };
  subscribe("http.client.request.start", onNode);
  subscribe("undici:request:create", onUndici);
  try {
    for (const route of appRoutes(ports)) {
      const answer = await send(`${route.url}/`, route.headers);
      assert.equal(answer.status, 200, route.app);
    }
  } finally {
    unsubscribe("http.client.request.start", onNode);
    unsubscribe("undici:request:create", onUndici);
  }
  const apps = [notesApp, boardApp].map(({ port }) => `127.0.0.1:${port}`);
  assert.deepEqual(
    viaNode.filter((host) => apps.includes(host)),
    apps,
  );
  assert.deepEqual(
    viaUndici.filter((host) => apps.includes(host)),
    [],
  );
});

test("each host relays an app's file whole when the app closes its connection after answering, then serves the next requests", async (context) => {
  const file = Buffer.from(
    Array.from({ length: 256 * 1024 }, (_, index) => (index * 31 + 7) % 256),
  );
  const responder: RequestListener = (request, response) => {
    if (request.url !== "/files/sample.bin") {
      response.write("ne");
      response.end("xt");
      return;
    }
    response.setHeader("content-type", "application/octet-stream");
    response.setHeader("content-length", file.length);
    // A complete response, after which the app closes the connection: ordinary HTTP/1.1.
    response.setHeader("connection", "close");
    response.end(file);
  };
  const { notesApp, boardApp, ports } = await hostStack(context, {
    notes: responder,
    board: responder,
  });
  const apps: AppServer[] = [notesApp, boardApp];
  for (const [index, route] of appRoutes(ports).entries()) {
    const downloaded = await send(
      `${route.url}/files/sample.bin`,
      route.headers,
    );
    assert.equal(downloaded.status, 200, route.app);
    assert.equal(
      downloaded.headers["content-type"],
      "application/octet-stream",
    );
    assert.equal(downloaded.headers["content-length"], String(file.length));
    assert.ok(
      downloaded.bytes.equals(file),
      `${route.app} receives every byte`,
    );
    for (const path of ["/next", "/next?again"]) {
      const next = await send(`${route.url}${path}`, route.headers);
      assert.deepEqual([next.status, next.body], [200, "next"], route.app);
    }
    // The app closed the file's connection; the next two requests share one new connection.
    assert.equal(apps[index]!.connections.length, 2, route.app);
  }
});

test(
  "an app's chunked framing stays on the host's connection to it: an HTTP/1.0 viewer gets the body in its own framing",
  { timeout: 10_000 },
  async (context) => {
    const { ports } = await hostStack(context, {
      board: (_request, response) => {
        response.write("public ");
        response.end("board");
      },
    });
    const answer = await sendRaw(
      ports.publicApps,
      `GET /board/ HTTP/1.0\r\nHost: ${new URL(origins.publicApps).host}\r\n\r\n`,
    );
    assert.equal(answer.status, 200);
    assert.doesNotMatch(answer.headers, /transfer-encoding/i);
    assert.equal(answer.body, "public board");
  },
);

test(
  "a viewer who leaves an app's stream closes the app's response, and the host keeps serving",
  { timeout: 10_000 },
  async (context) => {
    const notes = holdingApp();
    const board = holdingApp();
    const { ports } = await hostStack(context, {
      notes: notes.listener,
      board: board.listener,
    });
    for (const [index, route] of appRoutes(ports).entries()) {
      const app = [notes, board][index]!;
      const stream = await openStream(`${route.url}/events`, route.headers);
      assert.equal(stream.received(), "data: first\n\n", route.app);
      stream.request.destroy();
      await app.closed.at(-1);
      const next = await send(`${route.url}/`, route.headers);
      assert.deepEqual(
        [next.status, next.body],
        [200, "still serving"],
        route.app,
      );
    }
  },
);

test(
  "a transport failure reported after an app's response began cuts that response off instead of adding an error page",
  { timeout: 10_000 },
  async (context) => {
    const notes = holdingApp();
    const board = holdingApp();
    const { ports, forwarded } = await hostStack(context, {
      notes: notes.listener,
      board: board.listener,
    });
    for (const [index, route] of appRoutes(ports).entries()) {
      const app = [notes, board][index]!;
      const stream = await openStream(`${route.url}/events`, route.headers);
      try {
        const { reply, options } = forwarded.at(-1)!;
        assert.ok(reply.raw.headersSent, route.app);
        // Node's client can report a lost connection or an idle timeout once the body is streaming.
        assert.doesNotThrow(() =>
          options.onError!(reply, {
            error: new Error("synthetic transport failure"),
          }),
        );
        assert.equal(await stream.outcome, "cut off", route.app);
        assert.equal(stream.received(), "data: first\n\n", route.app);
        await app.closed.at(-1);
      } finally {
        stream.request.destroy();
      }
      const next = await send(`${route.url}/`, route.headers);
      assert.deepEqual(
        [next.status, next.body],
        [200, "still serving"],
        route.app,
      );
    }
  },
);

test(
  "closing a host closes the idle connections it keeps to apps",
  { timeout: 10_000 },
  async (context) => {
    const { notesApp, boardApp, ports, hosts } = await hostStack(context);
    const stack = [
      { app: notesApp, host: hosts.artifact },
      { app: boardApp, host: hosts.publicApps },
    ];
    for (const [index, route] of appRoutes(ports).entries()) {
      const { app, host } = stack[index]!;
      assert.equal((await send(`${route.url}/`, route.headers)).status, 200);
      const [connection] = app.connections;
      assert.ok(connection && !connection.destroyed, route.app);
      const closed = once(connection, "close").then(() => true);
      await host.close();
      // Well within the idle timeout, so only closing the host can close the connection.
      const closedInTime = await Promise.race([
        closed,
        new Promise<false>((resolve) =>
          setTimeout(() => resolve(false), 1_000),
        ),
      ]);
      assert.ok(closedInTime, `${route.app}'s connection closes with its host`);
    }
  },
);
