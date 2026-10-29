import assert from "node:assert/strict";
import { test } from "node:test";
import { file, owner } from "../../artifact/test/artifact-fixture.js";
import { HostAdmission } from "../handler/host-admission.js";
import { viewPassSignInPath } from "../model/view-credential.js";
import {
  hostStack,
  notesKey,
  send,
  sendRaw,
  type Touches,
} from "./host-stack.js";
import { issuePass } from "./view-fixture.js";

/** No step that reads or changes anything ran. */
const untouched: Touches = {
  lookups: 0,
  forwards: 0,
  files: 0,
  sessions: 0,
  viewLinks: 0,
  passes: 0,
  apiKeys: 0,
};

/** One HTTP/1.1 request's exact bytes: the target as written and each header line in order. */
function request(
  target: string,
  headers: readonly (readonly [string, string])[],
  method = "GET",
): string {
  return [
    `${method} ${target} HTTP/1.1`,
    ...headers.map(([name, value]) => `${name}: ${value}`),
    "Connection: close",
    "",
    "",
  ].join("\r\n");
}

/** Check a refusal: the explanation page, never cached, with no cookie, redirect, or validator. */
function assertRefused(
  answer: { status: number; headers: string; body: string },
  label: string,
  method = "GET",
): void {
  assert.equal(answer.status, 421, label);
  const headers = answer.headers.toLowerCase();
  assert.match(headers, /\r\ncache-control: no-store\r\n/, label);
  for (const name of ["set-cookie", "location", "etag", "last-modified"])
    assert.ok(!headers.includes(`\r\n${name}:`), `${label}: no ${name}`);
  if (method !== "HEAD")
    assert.match(answer.body, /Open this app from Everything/, label);
  assert.doesNotMatch(answer.body, /private notes|public board|Guide/, label);
}

/** The ETag both static apps' index page carries, which a refused request must not validate. */
const pageTag = `"${file("index.html", "<h1>Guide</h1>".length).sha256}"`;

test("a viewer host's hostnames must be explicit cookie hosts", () => {
  for (const hostnames of [
    [],
    ["LOCALHOST"],
    ["localhost."],
    ["localhost:8081"],
    ["http://localhost"],
    [""],
  ])
    assert.throws(
      () => new HostAdmission(hostnames),
      JSON.stringify(hostnames),
    );
  assert.doesNotThrow(
    () => new HostAdmission(["127.0.0.1", "public-apps.everything.svc"]),
  );
});

test("the public apps host refuses every other hostname before reading a cookie, looking up an app, or forwarding", async (context) => {
  const { ports, touches, boardApp, notesApp } = await hostStack(context);
  const hosts = [
    // The artifact host's and the application's cookie host, however it is written.
    "localhost:8082",
    "localhost",
    "LOCALHOST.:8082",
    "Localhost.",
    // The artifact host's in-cluster hostname.
    "artifact.everything.svc.cluster.local:8082",
    "ARTIFACT.everything.svc.cluster.local.",
    // Hostnames nothing configured.
    "everything.test",
    "127.0.0.2:8082",
    "[::1]:8082",
    // Values that are not a host and a port.
    "",
    "127.0.0.1:8082@localhost",
    "127.0.0.1:8082,localhost:8082",
    "127.0.0.1/board",
    "localhost:99999",
  ];
  const credentials = [
    ["Cookie", "notes_session=private-notes-state; everything-session=ui"],
    ["X-Api-Key", notesKey],
    ["Authorization", "Bearer everything_view_pass"],
    ["If-None-Match", pageTag],
  ] as const;
  for (const host of hosts)
    for (const [method, target] of [
      ["GET", "/"],
      ["GET", "/board"],
      ["GET", "/board/"],
      ["POST", "/board/api"],
      ["GET", "/guide/"],
      ["HEAD", "/guide/"],
      ["GET", "/notes/"],
      ["GET", "/missing/page"],
    ] as const)
      assertRefused(
        await sendRaw(
          ports.publicApps,
          request(target, [["Host", host], ...credentials], method),
        ),
        `${method} ${target} on ${JSON.stringify(host)}`,
        method,
      );
  assert.deepEqual(touches, untouched);
  assert.equal(boardApp.received.length, 0);
  assert.equal(notesApp.received.length, 0);
});

test("the artifact host refuses every other hostname before any sign-in link, pass, session, API key, or app", async (context) => {
  const { access, passes, ports, touches, notesApp, browse } =
    await hostStack(context);
  const pass = await issuePass(passes, owner, "notes");
  const view = await access.grant(owner, { slug: "notes" });
  const code = new URL(view.url).searchParams.get("code")!;
  const session = (await access.redeem(
    new URL(
      (await access.grant(owner, { slug: "notes" })).url,
    ).searchParams.get("code")!,
  ))!.sessionToken;
  const hosts = [
    // The public apps host's cookie host, however it is written.
    "127.0.0.1:8081",
    "127.0.0.1",
    "127.0.0.1.:8081",
    "0x7f.0.0.1:8081",
    "127.1",
    // The public apps host's in-cluster hostname.
    "public-apps.everything.svc.cluster.local:8080",
    "PUBLIC-APPS.everything.svc.cluster.local.",
    // Hostnames nothing configured, and values that are not a host and a port.
    "everything.test",
    "",
    "localhost:8081@127.0.0.1",
    "localhost:8081,127.0.0.1:8081",
  ];
  const routes = [
    [
      "GET",
      `${viewPassSignInPath}?token=${encodeURIComponent(pass.token)}`,
      [],
    ],
    ["GET", `/_access?code=${code}`, []],
    ["GET", "/notes/", [["Cookie", `everything-artifact-session=${session}`]]],
    ["GET", "/notes/", [["Authorization", `Bearer ${pass.token}`]]],
    ["POST", "/notes/api", [["X-Api-Key", notesKey]]],
    ["GET", "/drafts/", [["If-None-Match", pageTag]]],
    ["GET", "/board/", []],
    ["GET", "/", []],
    ["GET", "/notes", []],
  ] as const;
  for (const host of hosts)
    for (const [method, target, headers] of routes)
      assertRefused(
        await sendRaw(
          ports.artifact,
          request(
            target,
            [
              ["Host", host],
              ["Sec-Fetch-Site", "none"],
              ["Sec-Fetch-Mode", "navigate"],
              ...headers,
            ],
            method,
          ),
        ),
        `${method} ${target} on ${JSON.stringify(host)}`,
        method,
      );
  assert.deepEqual(touches, untouched);
  assert.equal(notesApp.received.length, 0);
  // Nothing was used up: the view link and the pass still work on the artifact host's hostname.
  assert.equal(
    (await browse(`http://localhost:8081/_access?code=${code}`)).status,
    303,
  );
  assert.equal(
    (
      await browse(
        `http://localhost:8081${viewPassSignInPath}?token=${encodeURIComponent(pass.token)}`,
      )
    ).status,
    303,
  );
});

test("forwarding headers naming an admitted hostname never admit a refused Host", async (context) => {
  const { passes, ports, touches, boardApp, notesApp } =
    await hostStack(context);
  const pass = await issuePass(passes, owner, "notes");
  const spoofed = (host: string) =>
    [
      ["X-Forwarded-Host", host],
      ["Forwarded", `for=192.0.2.1;host=${host};proto=http`],
      ["X-Forwarded-Proto", "http"],
      ["X-Forwarded-For", "192.0.2.1"],
    ] as const;
  for (const host of [
    "127.0.0.1:8082",
    "public-apps.everything.svc.cluster.local:8082",
  ])
    assertRefused(
      await sendRaw(
        ports.publicApps,
        request("/board/", [
          ["Host", "localhost:8082"],
          ["Cookie", "notes_session=private-notes-state"],
          ...spoofed(host),
        ]),
      ),
      host,
    );
  for (const host of [
    "localhost:8081",
    "artifact.everything.svc.cluster.local:8080",
  ])
    assertRefused(
      await sendRaw(
        ports.artifact,
        request(
          `${viewPassSignInPath}?token=${encodeURIComponent(pass.token)}`,
          [["Host", "127.0.0.1:8081"], ...spoofed(host)],
        ),
      ),
      host,
    );
  assert.deepEqual(touches, untouched);
  assert.equal(boardApp.received.length, 0);
  assert.equal(notesApp.received.length, 0);
});

test("an admitted hostname is served whatever forwarding headers say, in any case, with a trailing dot, or on another port", async (context) => {
  const { passes, ports, boardApp, notesApp } = await hostStack(context);
  const spoofed = (host: string) => ({
    "x-forwarded-host": host,
    forwarded: `host=${host}`,
  });
  const publicHosts = [
    "127.0.0.1:8082",
    "127.0.0.1",
    "127.0.0.1.:9000",
    "public-apps.everything.svc.cluster.local:8082",
    "PUBLIC-APPS.Everything.svc.cluster.local.:8082",
  ];
  for (const [index, host] of publicHosts.entries()) {
    const served = await send(`http://127.0.0.1:${ports.publicApps}/board/`, {
      host,
      ...spoofed("localhost:8082"),
    });
    assert.equal(served.status, 200, host);
    assert.equal(served.body, "public board", host);
    // The public app starts its own session for the visitor, as usual.
    assert.match(String(served.headers["set-cookie"]), /^board_session=/, host);
    // The app learns the hostname the request was admitted under, not the one a caller claimed.
    assert.equal(boardApp.received[index]!.headers["x-forwarded-host"], host);
  }
  const guide = await send(`http://127.0.0.1:${ports.publicApps}/guide/`, {
    host: "127.0.0.1:8082",
    "if-none-match": pageTag,
  });
  assert.equal(guide.status, 304);

  for (const host of [
    "localhost:8081",
    "LOCALHOST.:8081",
    "artifact.everything.svc.cluster.local:8080",
  ]) {
    const keyed = await send(
      `http://127.0.0.1:${ports.artifact}/notes/api`,
      { host, "x-api-key": notesKey, ...spoofed("127.0.0.1:8082") },
      "POST",
    );
    assert.equal(keyed.status, 200, host);
    assert.equal(keyed.body, "private notes", host);
    const pass = await issuePass(passes, owner, "notes");
    const stored = await send(
      `http://127.0.0.1:${ports.artifact}${viewPassSignInPath}?token=${encodeURIComponent(pass.token)}`,
      { host, ...spoofed("127.0.0.1:8081") },
    );
    assert.equal(stored.status, 303, host);
    assert.match(
      String(stored.headers["set-cookie"]),
      /^everything-teammate-pass=everything_view_/,
      host,
    );
  }
  assert.equal(notesApp.received.length, 3);
});

test("requests no browser sends are refused: no Host header, two of them, or a target that is not a path", async (context) => {
  const { ports, touches, boardApp, notesApp } = await hostStack(context);
  for (const [port, host] of [
    [ports.publicApps, "127.0.0.1:8082"],
    [ports.artifact, "localhost:8081"],
  ] as const) {
    const other = host.startsWith("127") ? "localhost:8082" : "127.0.0.1:8081";
    for (const [label, text] of [
      ["no Host header", "GET /board/ HTTP/1.0\r\n\r\n"],
      [
        "two Host headers",
        request("/board/", [
          ["Host", host],
          ["Host", other],
        ]),
      ],
      [
        "the same Host header twice",
        request("/board/", [
          ["Host", host],
          ["Host", host],
        ]),
      ],
      [
        "a full URL as the target",
        request(`http://${other}/board/`, [["Host", host]]),
      ],
      [
        "a full URL naming the admitted host",
        request(`http://${host}/board/`, [["Host", host]]),
      ],
      ["an asterisk as the target", request("*", [["Host", host]], "OPTIONS")],
    ] as const)
      assertRefused(await sendRaw(port, text), `${label} on ${host}`);
    // Node itself refuses an HTTP/1.1 request without a Host header.
    assert.equal(
      (await sendRaw(port, "GET /board/ HTTP/1.1\r\nConnection: close\r\n\r\n"))
        .status,
      400,
    );
  }
  assert.deepEqual(touches, untouched);
  assert.equal(boardApp.received.length, 0);
  assert.equal(notesApp.received.length, 0);
});
