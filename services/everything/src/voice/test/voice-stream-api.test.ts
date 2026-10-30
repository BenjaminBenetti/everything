import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Agent, createServer, request as httpRequest } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { WebSocketServer } from "ws";
import {
  encodeVoiceFrame,
  voiceStreamProtocols,
  voiceStreamStart,
  voiceStreamStartFor,
} from "@everything/conversation-contracts/voice-stream";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import { ApiDocumentationService } from "../../api-documentation/service/api-documentation-service.js";
import {
  createHttpApplication,
  type HttpDependencies,
} from "../../application/factory/http-application.js";
import { WebSocketSpeechStreams } from "../adapter/websocket-speech-streams.js";
import { VoiceUnavailableError } from "../error/voice-errors.js";
import { VoiceReservations } from "../service/voice-reservations.js";
import { VoiceStreamService } from "../service/voice-stream-service.js";
import { createVoiceRuntime } from "../factory/voice-runtime.js";
import type { SpeechStreams } from "../interface/speech-streams.js";
import { maxServiceMessageBytes } from "../service/voice-stream-session.js";
import {
  fakeSpeechStream,
  type FakeStreamBehavior,
} from "./fake-speech-stream.js";
import { TelemetryQueryService } from "../../telemetry/service/telemetry-query-service.js";

const agentId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";
const route = `/v1/agents/${agentId}/voice/stream`;
const publicOrigin = "https://everything.test";

/** Bearer tokens the test verifier accepts, by subject. */
const tokens: Readonly<Record<string, string>> = {
  "owner-token": "owner",
  "second-token": "second-owner",
};

/** Any use of an unrelated dependency fails the test. */
function unusedOperations<T>(): T {
  return new Proxy(
    {},
    {
      get: (_target, property) => () =>
        assert.fail(`Voice stream tests invoked ${String(property)}`),
    },
  ) as T;
}

/** The production HTTP application, listening, with streaming to the given service. */
async function gateway(
  context: TestContext,
  options: {
    url?: string;
    streams?: SpeechStreams | null;
    finalTimeoutMs?: number;
    agents?: Pick<AgentCatalog, "get">;
  } = {},
) {
  const runtime = await createVoiceRuntime(
    {
      service: null,
      stream:
        options.url === undefined && options.streams === undefined
          ? null
          : {
              url: options.url ?? "ws://127.0.0.1:9/v1/stream",
              token: "stream-secret",
              finalTimeoutMs: options.finalTimeoutMs ?? 5_000,
              concurrency: 1,
            },
      admission: { concurrency: 1, queueLimit: 0, queueTimeoutMs: 1_000 },
    },
    options.agents ?? {
      /** Each test owner has the teammate; every other ID is missing or foreign. */
      async get(ownerId, id) {
        if (!Object.values(tokens).includes(ownerId) || id !== agentId)
          throw new AgentNotFoundError();
        return { id } as AgentDefinition;
      },
    },
    () => undefined,
    {
      verify: async () => false,
      decode: async () => assert.fail("No uploads"),
    },
    ...(options.streams !== undefined ? [options.streams] : []),
  );
  const dependencies: HttpDependencies = {
    apiDocumentation: new ApiDocumentationService(),
    verifier: {
      verify: async (token) => {
        const subject = tokens[token];
        if (!subject) throw new Error("invalid");
        return { subject };
      },
    },
    sessions: {
      ...unusedOperations<HttpDependencies["sessions"]>(),
      resolve: async (handle) =>
        handle === "browser-session"
          ? {
              accessToken: "owner-token",
              profile: { subject: "owner", displayName: "Owner" },
            }
          : undefined,
    },
    publicOrigin,
    chatGptRedirectUri: "http://127.0.0.1:8080/v1/providers/chatgpt/callback",
    keys: unusedOperations(),
    credentialGrants: unusedOperations(),
    credentialRollouts: unusedOperations(),
    providers: unusedOperations(),
    models: unusedOperations(),
    agents: unusedOperations(),
    agentActivity: unusedOperations(),
    profiles: unusedOperations(),
    removal: unusedOperations(),
    conversations: unusedOperations(),
    attachments: unusedOperations(),
    subagents: unusedOperations(),
    updates: unusedOperations(),
    upgrades: unusedOperations(),
    artifacts: unusedOperations(),
    workers: unusedOperations(),
    generalSettings: unusedOperations(),
    teammateOrder: unusedOperations(),
    workspaces: unusedOperations(),
    workspaceActivity: unusedOperations(),
    voice: runtime.uploads,
    voiceStreams: runtime.streams,
    telemetry: new TelemetryQueryService(
      { enabled: false, retentionDays: 7 },
      null,
    ),
    readiness: async () => {},
  };
  const app = await createHttpApplication(dependencies);
  app.addHook("preClose", async () => runtime.close());
  await app.listen({ port: 0, host: "127.0.0.1" });
  context.after(() => app.close());
  // Every server-side connection, so tests can prove refused upgrades don't linger.
  const sockets = new Set<Socket>();
  app.server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const { port } = app.server.address() as AddressInfo;
  return { app, port, runtime, openSockets: () => sockets.size };
}

/** The HTTP status a WebSocket upgrade request gets, without completing a connection. */
function upgradeStatus(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    // A dedicated connection, as browsers use for an upgrade; a refused upgrade's socket is closed.
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      agent: false,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
}

/** A browser-side stream client that collects every message, offering these subprotocols. */
async function client(
  port: number,
  headers: Record<string, string>,
  protocols: string[] = [],
) {
  const messages: Record<string, unknown>[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}${route}`, {
    headers,
    protocols,
  } as unknown as string[]);
  socket.binaryType = "arraybuffer";
  const closed = new Promise<void>((resolve) =>
    socket.addEventListener("close", () => resolve()),
  );
  socket.addEventListener("message", (event: MessageEvent) =>
    messages.push(JSON.parse(String(event.data)) as Record<string, unknown>),
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () =>
      reject(new Error("connection failed")),
    );
  });
  return {
    socket,
    messages,
    closed,
    /** Wait for a message of this type. */
    async next(type: string): Promise<Record<string, unknown>> {
      for (let attempt = 0; attempt < 500; attempt++) {
        const found = messages.find((message) => message.type === type);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`No ${type} message; got ${JSON.stringify(messages)}`);
    },
  };
}

/** Wait until a condition holds, failing after a few seconds. */
async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition());
}

const bearer = { authorization: "Bearer owner-token" };

test("refuses before upgrading: no credentials, a foreign origin, a foreign teammate, or no service", async (context) => {
  const speech = await fakeSpeechStream(context);
  const { port } = await gateway(context, { url: speech.url });
  assert.equal(await upgradeStatus(port, route), 401);
  // Cookie sessions need the application's exact origin; GET upgrades are not covered by the mutation check.
  const cookie = { cookie: "__Host-everything-session=browser-session" };
  assert.equal(
    await upgradeStatus(port, route, {
      ...cookie,
      origin: "https://elsewhere.test",
    }),
    403,
  );
  assert.equal(await upgradeStatus(port, route, cookie), 403);
  assert.equal(
    await upgradeStatus(port, route, {
      ...cookie,
      origin: publicOrigin,
      "sec-fetch-site": "cross-site",
    }),
    403,
  );
  assert.equal(
    await upgradeStatus(port, route, { ...cookie, origin: publicOrigin }),
    101,
  );
  await eventually(() => speech.record.open === 0);
  // Missing and foreign teammates are indistinguishable; malformed IDs fail validation.
  assert.equal(
    await upgradeStatus(
      port,
      "/v1/agents/0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c/voice/stream",
      bearer,
    ),
    404,
  );
  assert.equal(
    await upgradeStatus(port, "/v1/agents/not-a-uuid/voice/stream", bearer),
    400,
  );
  // An ordinary GET is not a stream.
  const plain = await fetch(`http://127.0.0.1:${port}${route}`, {
    headers: bearer,
  });
  assert.equal(plain.status, 404);
  assert.equal(speech.record.controls.length, 0);
  const unconfigured = await gateway(context);
  assert.equal(await upgradeStatus(unconfigured.port, route, bearer), 503);
});

test("relays a stream with the backend-only token and returns one final transcript", async (context) => {
  const speech = await fakeSpeechStream(context);
  const { port, runtime } = await gateway(context, { url: speech.url });
  assert.equal(runtime.uploads.capabilities().streaming, true);
  const browser = await client(port, bearer);
  browser.socket.send(JSON.stringify(voiceStreamStart));
  assert.deepEqual(await browser.next("ready"), {
    type: "ready",
    version: 1,
    maxSamples: 960_000,
    maxFrameSamples: 3_200,
    windowSamples: 16_000,
  });
  for (let sequence = 0; sequence < 10; sequence++)
    browser.socket.send(
      encodeVoiceFrame(sequence, new Int16Array(sequence === 9 ? 7 : 320)),
    );
  await eventually(() =>
    browser.messages.some((m) => m.type === "ack" && m.sequence === 9),
  );
  browser.socket.send(
    JSON.stringify({ type: "end", sequence: 10, totalSamples: 9 * 320 + 7 }),
  );
  assert.deepEqual(await browser.next("final"), {
    type: "final",
    text: "Heard 2887 samples.",
  });
  await browser.closed;
  assert.deepEqual(speech.record.authorizations, ["Bearer stream-secret"]);
  assert.deepEqual(speech.record.paths, ["/v1/stream"]);
  assert.deepEqual(
    speech.record.frames.map((frame) => frame.sequence),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.deepEqual(speech.record.controls, [
    voiceStreamStart,
    { type: "end", sequence: 10, totalSamples: 2887 },
  ]);
});

test("a browser offering version 2 gets the live service's partials; version 1 peers on either side keep version 1", async (context) => {
  const offered = [voiceStreamProtocols[1], voiceStreamProtocols[2]];
  const partial = (samples: number) => `Heard ${samples} so far`;
  const behavior: FakeStreamBehavior = { versions: "1, 2", partial };
  /** Stream two frames and end; returns the browser's messages and what the service received. */
  async function dictate(
    speechBehavior: FakeStreamBehavior,
    protocols: string[],
    version: 1 | 2,
  ) {
    const speech = await fakeSpeechStream(context, speechBehavior);
    const { port } = await gateway(context, { url: speech.url });
    const browser = await client(port, bearer, protocols);
    const negotiated = browser.socket.protocol;
    browser.socket.send(JSON.stringify(voiceStreamStartFor(version)));
    await browser.next("ready");
    browser.socket.send(encodeVoiceFrame(0, new Int16Array(320)));
    browser.socket.send(encodeVoiceFrame(1, new Int16Array(320)));
    await eventually(() =>
      browser.messages.some((m) => m.type === "ack" && m.sequence === 1),
    );
    browser.socket.send(
      JSON.stringify({ type: "end", sequence: 2, totalSamples: 640 }),
    );
    await browser.next("final");
    await browser.closed;
    return { negotiated, messages: browser.messages, speech: speech.record };
  }

  const live = await dictate(behavior, offered, 2);
  assert.equal(live.negotiated, voiceStreamProtocols[2]);
  assert.deepEqual(live.speech.controls[0], voiceStreamStartFor(2));
  assert.deepEqual(
    live.messages.map((m) => m.type),
    ["ready", "partial", "ack", "partial", "ack", "final"],
  );
  assert.equal(live.messages[0]!.version, 2);
  assert.deepEqual(live.messages[3], {
    type: "partial",
    revision: 2,
    text: "Heard 640 so far",
  });

  // A service without the versions header is spoken to in version 1; the browser gets only the final.
  const finalOnly = await dictate({ partial }, offered, 2);
  assert.equal(finalOnly.negotiated, voiceStreamProtocols[2]);
  assert.deepEqual(finalOnly.speech.controls[0], voiceStreamStart);
  assert.deepEqual(
    finalOnly.messages.map((m) => m.type),
    ["ready", "ack", "ack", "final"],
  );
  assert.equal(finalOnly.messages[0]!.version, 2);

  // A browser that offers no subprotocol, as before version 2, is version 1 end to end.
  const legacy = await dictate(behavior, [], 1);
  assert.equal(legacy.negotiated, "");
  assert.deepEqual(legacy.speech.controls[0], voiceStreamStart);
  assert.deepEqual(
    legacy.messages.map((m) => m.type),
    ["ready", "ack", "ack", "final"],
  );
  assert.equal(legacy.messages[0]!.version, 1);
});

test("a gateway that predates version 2, which selects no subprotocol itself, answers the browser's offer with version 1", async (context) => {
  // Before version 2 the gateway's WebSocket server had no subprotocol selection, so it takes the first offer.
  const older = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  context.after(() => older.close());
  await new Promise((resolve) => older.once("listening", resolve));
  const { port } = older.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, [
    voiceStreamProtocols[1],
    voiceStreamProtocols[2],
  ]);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  assert.equal(socket.protocol, voiceStreamProtocols[1]);
  socket.close();
});

test("a browser that offers only version 1, or starts another version than it agreed, stays within version 1", async (context) => {
  const speech = await fakeSpeechStream(context, {
    versions: "1, 2",
    partial: () => "never sent",
  });
  const { port } = await gateway(context, { url: speech.url });
  const onlyOne = await client(port, bearer, [voiceStreamProtocols[1]]);
  assert.equal(onlyOne.socket.protocol, voiceStreamProtocols[1]);
  onlyOne.socket.send(JSON.stringify(voiceStreamStartFor(2)));
  assert.deepEqual(await onlyOne.next("error"), {
    type: "error",
    code: "INVALID_MESSAGE",
  });
  await onlyOne.closed;
  assert.equal(speech.record.controls.length, 0, "the service was never asked");
});

test("one stream per owner, shared with uploads, and a bounded total, held until the service confirms cancellation", async (context) => {
  const speech = await fakeSpeechStream(context, { cancelDelayMs: 300 });
  const { port } = await gateway(context, { url: speech.url });
  const first = await client(port, bearer);
  first.socket.send(JSON.stringify(voiceStreamStart));
  await first.next("ready");
  assert.equal(await upgradeStatus(port, route, bearer), 429);
  assert.equal(
    await upgradeStatus(port, route, { authorization: "Bearer second-token" }),
    503,
  );
  // Closing the browser asks the service to cancel; the places stay held until it confirms.
  first.socket.close();
  await eventually(() =>
    speech.record.controls.some((m) => m.type === "cancel"),
  );
  assert.equal(await upgradeStatus(port, route, bearer), 429);
  await eventually(() => speech.record.open === 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const next = await client(port, bearer);
  next.socket.send(JSON.stringify(voiceStreamStart));
  await next.next("ready");
  next.socket.send(
    JSON.stringify({ type: "end", sequence: 0, totalSamples: 0 }),
  );
  assert.deepEqual(await next.next("final"), {
    type: "final",
    text: "Heard 0 samples.",
  });
});

test("invalid browser audio is refused with its code and the service's work is cancelled", async (context) => {
  const speech = await fakeSpeechStream(context);
  const { port } = await gateway(context, { url: speech.url });
  const browser = await client(port, bearer);
  browser.socket.send(JSON.stringify(voiceStreamStart));
  await browser.next("ready");
  browser.socket.send(encodeVoiceFrame(0, new Int16Array(320)));
  browser.socket.send(encodeVoiceFrame(2, new Int16Array(320)));
  assert.deepEqual(await browser.next("error"), {
    type: "error",
    code: "INVALID_SEQUENCE",
  });
  await browser.closed;
  await eventually(() =>
    speech.record.controls.some((m) => m.type === "cancel"),
  );
  // A message larger than any valid one closes the connection at the transport.
  const huge = await client(port, bearer);
  await eventually(() => speech.record.open === 0);
  huge.socket.send(new Uint8Array(64 * 1024));
  await huge.closed;
});

test("bounds every service message on the wire and refuses oversized, fragmented, compressed, and redirected replies", async (context) => {
  const oversized = Buffer.alloc(maxServiceMessageBytes + 1, 0x20);
  const behaviors: [string, FakeStreamBehavior][] = [
    [
      "oversized",
      { afterStart: (socket) => socket.send(oversized.toString("latin1")) },
    ],
    [
      "fragmented",
      {
        afterStart: (socket) => {
          // Small fragments whose total passes the limit; the receiver counts across fragments.
          const piece = Buffer.alloc(64 * 1024, 0x20).toString("latin1");
          for (let index = 0; index < 4; index++)
            socket.send(piece, { fin: false });
          socket.send("}", { fin: true });
        },
      },
    ],
  ];
  for (const [name, behavior] of behaviors) {
    const speech = await fakeSpeechStream(context, behavior);
    const { port } = await gateway(context, { url: speech.url });
    const browser = await client(port, bearer);
    browser.socket.send(JSON.stringify(voiceStreamStart));
    assert.deepEqual(
      await browser.next("error"),
      { type: "error", code: "UNAVAILABLE" },
      name,
    );
    await browser.closed;
    await eventually(() => speech.record.open === 0);
    // The places are free again.
    const again = await client(port, bearer);
    again.socket.close();
    await again.closed;
  }
  // A raw server: one redirects the handshake, one replies with a compressed frame it never negotiated.
  const raw = await rawSpeechServer(context);
  for (const path of ["/redirect", "/compressed"]) {
    const { port } = await gateway(context, { url: `${raw.url}${path}` });
    const browser = await client(port, bearer);
    browser.socket.send(JSON.stringify(voiceStreamStart));
    assert.deepEqual(
      await browser.next("error"),
      { type: "error", code: "UNAVAILABLE" },
      path,
    );
    await browser.closed;
  }
  assert.deepEqual(raw.paths, ["/redirect", "/compressed"]);
});

test("the upstream connection enforces the limit before buffering a message's payload", async (context) => {
  // The receiver rejects from the frame header alone: the payload never arrives here.
  const raw = await rawSpeechServer(context);
  let closed = false;
  const channel = await new WebSocketSpeechStreams(
    { url: `${raw.url}/declares-huge`, token: "" },
    1_024,
  ).connect(
    {
      message: () => assert.fail("No message may be delivered"),
      closed: () => (closed = true),
    },
    new AbortController().signal,
  );
  assert.ok(channel);
  await eventually(() => closed);
  assert.ok(raw.declaredOnly);
});

/** Compute a WebSocket handshake accept value. */
function accept(key: string): string {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

/** A hand-written server for handshakes and frames a well-behaved WebSocket server never sends. */
async function rawSpeechServer(context: TestContext) {
  const paths: string[] = [];
  const state = { declaredOnly: false };
  const server = createServer();
  server.on("upgrade", (request, socket: Socket) => {
    paths.push(request.url ?? "");
    if (request.url === "/redirect") {
      socket.end(
        "HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:9/elsewhere\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept(String(request.headers["sec-websocket-key"]))}\r\n\r\n`,
    );
    if (request.url === "/compressed")
      // A text frame with RSV1 set, as permessage-deflate would send it.
      socket.once("data", () =>
        socket.write(Buffer.from([0xc1, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f])),
      );
    else if (request.url === "/declares-huge") {
      // A text frame header declaring 16 MiB, and none of its payload.
      const header = Buffer.from([0x81, 127, 0, 0, 0, 0, 0x01, 0, 0, 0]);
      socket.write(header);
      state.declaredOnly = true;
    }
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    paths,
    get declaredOnly() {
      return state.declaredOnly;
    },
  };
}

test("refused, public, and non-voice upgrades never switch protocols and leave no connection open", async (context) => {
  const speech = await fakeSpeechStream(context);
  const { port, openSockets } = await gateway(context, { url: speech.url });
  const cookie = { cookie: "__Host-everything-session=browser-session" };
  for (const [path, headers, status] of [
    [route, {}, 401],
    [route, { ...cookie, origin: "https://elsewhere.test" }, 403],
    [
      "/v1/agents/0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c/voice/stream",
      bearer,
      404,
    ],
    ["/v1/agents/not-a-uuid/voice/stream", bearer, 400],
    // Only the voice stream may upgrade: public, authenticated, and unknown routes all refuse.
    ["/health", {}, 404],
    ["/v1/session", {}, 404],
    ["/v1/me", {}, 404],
    ["/v1/me", bearer, 404],
    ["/nowhere", {}, 404],
  ] as const)
    assert.equal(await upgradeStatus(port, path, headers), status, path);
  await eventually(() => openSockets() === 0);
  assert.equal(speech.record.controls.length, 0);
});

test("a caller that leaves while ownership is checked strands no places and reaches no service", async (context) => {
  const speech = await fakeSpeechStream(context);
  let resolveOwnership: () => void = () => undefined;
  let lookups = 0;
  const { port } = await gateway(context, {
    url: speech.url,
    agents: {
      async get(ownerId, id) {
        lookups++;
        if (lookups === 1)
          await new Promise<void>((resolve) => (resolveOwnership = resolve));
        if (ownerId !== "owner" || id !== agentId)
          throw new AgentNotFoundError();
        return { id } as AgentDefinition;
      },
    },
  });
  const pending = httpRequest({
    host: "127.0.0.1",
    port,
    path: route,
    agent: false,
    headers: {
      ...bearer,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    },
  });
  pending.on("error", () => undefined);
  pending.end();
  await eventually(() => lookups === 1);
  pending.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  resolveOwnership();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(speech.record.paths.length, 0);
  // The same owner's next stream is admitted.
  const next = await client(port, bearer);
  next.socket.send(JSON.stringify(voiceStreamStart));
  await next.next("ready");
  next.socket.send(
    JSON.stringify({ type: "end", sequence: 0, totalSamples: 0 }),
  );
  await next.next("final");
});

test("an ordinary GET on a kept-alive connection takes no place", async (context) => {
  const speech = await fakeSpeechStream(context);
  const { port } = await gateway(context, { url: speech.url });
  const agent = new Agent({ keepAlive: true });
  context.after(() => agent.destroy());
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path: route, agent, headers: bearer },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(status, 404);
  // The connection is still open in the agent's pool, and the owner can stream.
  const browser = await client(port, bearer);
  browser.socket.send(JSON.stringify(voiceStreamStart));
  await browser.next("ready");
  browser.socket.send(
    JSON.stringify({ type: "end", sequence: 0, totalSamples: 0 }),
  );
  await browser.next("final");
});

test("opening after shutdown fails and the places return exactly once", async () => {
  const reservations = new VoiceReservations(2);
  const service = new VoiceStreamService(
    { get: async (_ownerId, id) => ({ id }) as AgentDefinition },
    reservations,
    { connect: () => assert.fail("No connection after shutdown") },
    { concurrency: 1, finalTimeoutMs: 1_000 },
  );
  const lease = await service.admit("owner", agentId);
  service.close();
  assert.throws(
    () =>
      service.open(
        lease,
        {
          send: () => undefined,
          close: () => undefined,
          bufferedAmount: 0,
        },
        1,
      ),
    VoiceUnavailableError,
  );
  lease.release();
  lease.release();
  // Both places are free again.
  reservations.reserve("owner").release();
  reservations.reserve("second-owner").release();
});

test("capabilities are serialized over HTTP with the streaming lane", async (context) => {
  const speech = await fakeSpeechStream(context);
  const { port } = await gateway(context, {
    url: speech.url,
    finalTimeoutMs: 7_000,
  });
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/voice/capabilities`,
    {
      headers: bearer,
    },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.streaming, true);
  assert.equal(body.streamFinalTimeoutMs, 7_000);
  assert.equal(body.available, false);
  assert.ok(!JSON.stringify(body).includes("127.0.0.1"));
  assert.ok(!JSON.stringify(body).includes("stream-secret"));
});
