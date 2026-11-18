import assert from "node:assert/strict";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { once } from "node:events";
import {
  Agent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { appIdleTimeout } from "../config/app-forwarding.js";
import type { ArtifactResponseSecrets } from "../interface/artifact-response-secrets.js";
import { hostMessages } from "../presenter/host-pages.js";
import {
  appRoutes,
  exchange,
  hostStack,
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

/**
 * An app that answers /events with one event and holds the stream open, keeping each stream to write
 * more and noting when each one closes.
 */
function holdingApp() {
  const closed: Promise<unknown>[] = [];
  const streams: ServerResponse[] = [];
  const listener: RequestListener = (request, response) => {
    if (request.url !== "/events") {
      response.end("still serving");
      return;
    }
    closed.push(once(response, "close"));
    streams.push(response);
    response.setHeader("content-type", "text/event-stream");
    response.write("data: first\n\n");
  };
  return { listener, closed, streams };
}

/** Wait until `check` holds, looking again every few milliseconds. */
async function until(check: () => boolean): Promise<void> {
  while (!check()) await delay(5);
}

/** The apps' responses as the hosts' HTTP client receives them, by the app's address and path. */
function appResponses(context: TestContext): Map<string, IncomingMessage> {
  const responses = new Map<string, IncomingMessage>();
  // Node's client publishes each response it receives on this documented diagnostics channel.
  const record = (message: unknown) => {
    const { request, response } = message as {
      request: ClientRequest;
      response: IncomingMessage;
    };
    responses.set(
      `${String(request.getHeader("host"))}${request.path}`,
      response,
    );
  };
  subscribe("http.client.response.finish", record);
  context.after(() => unsubscribe("http.client.response.finish", record));
  return responses;
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

test(
  "each host holds an app's response body to the idle bound the old transport gave it, event streams included, with or without parameters",
  { timeout: 10_000 },
  async (context) => {
    const types: Record<string, string> = {
      "/events": "text/event-stream",
      "/events-utf8": "text/event-stream; charset=utf-8",
      "/progress": "text/plain",
    };
    const streaming: RequestListener = (request, response) => {
      response.setHeader("content-type", types[request.url ?? ""]!);
      response.write("data: first\n\n");
    };
    const { notesApp, boardApp, ports } = await hostStack(context, {
      notes: streaming,
      board: streaming,
    });
    const responses = appResponses(context);
    for (const [index, route] of appRoutes(ports).entries()) {
      const { port } = [notesApp, boardApp][index]!;
      for (const path of Object.keys(types)) {
        const stream = await openStream(`${route.url}${path}`, route.headers);
        try {
          const response = responses.get(`127.0.0.1:${port}${path}`);
          assert.equal(
            response?.socket?.timeout,
            appIdleTimeout,
            `${route.app} ${path}`,
          );
        } finally {
          stream.request.destroy();
        }
      }
    }
  },
);

test(
  "an event stream stays open while its app keeps sending, and is cut off and released at the app once it falls silent for the idle wait",
  { timeout: 15_000 },
  async (context) => {
    // A controlled wait in place of the 300-second bound, so the test runs in moments.
    const idleWait = 400;
    const notes = holdingApp();
    const board = holdingApp();
    const { notesApp, boardApp, ports } = await hostStack(context, {
      notes: notes.listener,
      board: board.listener,
    });
    const responses = appResponses(context);
    for (const [index, route] of appRoutes(ports).entries()) {
      const app = [notes, board][index]!;
      const { port } = [notesApp, boardApp][index]!;
      const stream = await openStream(`${route.url}/events`, route.headers);
      try {
        responses.get(`127.0.0.1:${port}/events`)!.setTimeout(idleWait);
        // Steady events for well over the wait: each one starts it again.
        for (let tick = 1; tick <= 12; tick++) {
          await delay(idleWait / 8);
          app.streams.at(-1)!.write(`data: ${tick}\n\n`);
        }
        await until(() => stream.received().endsWith("data: 12\n\n"));
        assert.equal(
          await Promise.race([stream.outcome, "open"]),
          "open",
          route.app,
        );
        const silent = Date.now();
        assert.equal(await stream.outcome, "cut off", route.app);
        assert.ok(
          Date.now() - silent >= idleWait / 2,
          `${route.app} waits for the silence to last`,
        );
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
  "a transport failure reported after the viewer left, or after its response finished, changes nothing",
  { timeout: 10_000 },
  async (context) => {
    const held: ServerResponse[] = [];
    const responder: RequestListener = (request, response) => {
      if (request.url === "/slow") held.push(response);
      else response.end("still serving");
    };
    const { ports, forwarded } = await hostStack(context, {
      notes: responder,
      board: responder,
    });
    const failure = { error: new Error("synthetic transport failure") };
    for (const [index, route] of appRoutes(ports).entries()) {
      // The viewer leaves before the app answers.
      const request = httpRequest(`${route.url}/slow`, {
        headers: route.headers,
        agent: false,
      });
      request.on("error", () => {});
      request.end();
      await until(() => held.length === index + 1);
      const left = forwarded.at(-1)!;
      const closed = once(left.reply.raw, "close");
      request.destroy();
      await closed;
      assert.doesNotThrow(() => left.options.onError!(left.reply, failure));
      assert.equal(
        left.reply.raw.headersSent,
        false,
        `${route.app}: nothing is written for a viewer who left`,
      );
      held.at(-1)!.end("late");
      // A failure reported for a finished response leaves the viewer's connection serving.
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });
      try {
        const first = await exchange(`${route.url}/`, {
          headers: route.headers,
          agent,
        });
        assert.equal(first.status, 200, route.app);
        const finished = forwarded.at(-1)!;
        assert.doesNotThrow(() =>
          finished.options.onError!(finished.reply, failure),
        );
        const next = await exchange(`${route.url}/`, {
          headers: route.headers,
          agent,
        });
        assert.deepEqual(
          [next.status, next.body, next.reused],
          [200, "still serving", true],
          route.app,
        );
      } finally {
        agent.destroy();
      }
    }
  },
);

test(
  "a transport failure while an app's credentials are read gets one 502 page, and the app's response is released",
  { timeout: 10_000 },
  async (context) => {
    const notes = holdingApp();
    const board = holdingApp();
    // Hold the credential read that follows an app's response, once the app is about to answer.
    let holdNext = false;
    let release: (() => void) | undefined;
    const secrets: ArtifactResponseSecrets = {
      read: async () => {
        if (holdNext) {
          holdNext = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return [];
      },
    };
    const answering =
      (app: ReturnType<typeof holdingApp>): RequestListener =>
      (request, response) => {
        if (request.url === "/events") holdNext = true;
        app.listener(request, response);
      };
    const { ports, forwarded } = await hostStack(
      context,
      { notes: answering(notes), board: answering(board) },
      secrets,
    );
    for (const [index, route] of appRoutes(ports).entries()) {
      const app = [notes, board][index]!;
      const page = send(`${route.url}/events`, route.headers);
      await until(() => release !== undefined);
      const { reply, options } = forwarded.at(-1)!;
      assert.equal(reply.raw.headersSent, false, route.app);
      options.onError!(reply, {
        error: new Error("synthetic transport failure"),
      });
      await app.closed.at(-1);
      release!();
      release = undefined;
      const answer = await page;
      assert.equal(answer.status, 502, route.app);
      assert.ok(answer.body.includes(hostMessages.unreachable.message));
      assert.doesNotMatch(answer.body, /data: first/);
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
  "an app's 503 that the host retries past releases its connection, and the retried stream keeps flowing",
  { timeout: 10_000 },
  async (context) => {
    const apps = [holdingApp(), holdingApp()];
    const started = new Set<number>();
    /** Each app answers its first stream request while still starting. */
    const starting =
      (index: number): RequestListener =>
      (request, response) => {
        if (request.url === "/events" && !started.has(index)) {
          started.add(index);
          response.statusCode = 503;
          response.end("starting");
          return;
        }
        apps[index]!.listener(request, response);
      };
    const { notesApp, boardApp, ports } = await hostStack(context, {
      notes: starting(0),
      board: starting(1),
    });
    for (const [index, route] of appRoutes(ports).entries()) {
      const app = apps[index]!;
      const stream = await openStream(`${route.url}/events`, route.headers);
      try {
        assert.equal(stream.received(), "data: first\n\n", route.app);
        // The 503 came over the app's first connection; the retry opened another.
        const discarded = [notesApp, boardApp][index]!.connections[0]!;
        const released =
          discarded.destroyed ||
          (await Promise.race([
            once(discarded, "close").then(() => true),
            delay(1_000).then(() => false),
          ]));
        assert.ok(released, `${route.app} releases the 503's connection`);
        app.streams.at(-1)!.write("data: second\n\n");
        await until(() => stream.received().endsWith("data: second\n\n"));
        assert.equal(
          await Promise.race([stream.outcome, "open"]),
          "open",
          route.app,
        );
      } finally {
        stream.request.destroy();
      }
    }
  },
);
