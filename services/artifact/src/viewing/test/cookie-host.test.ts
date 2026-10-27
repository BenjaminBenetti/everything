import assert from "node:assert/strict";
import { test } from "node:test";
import { sharesCookieHost } from "@everything/security/cookie-host";
import { owner } from "../../artifact/test/artifact-fixture.js";
import { viewPassSignInPath } from "../model/view-credential.js";
import {
  cookieNames,
  hostStack,
  internalUrls,
  origins,
  send,
} from "./host-stack.js";
import { issuePass } from "./view-fixture.js";

test("a private app's own root-path cookies stay on the artifact host and never reach a public app's server", async (context) => {
  const { access, jar, browse, notesApp, boardApp } = await hostStack(context);
  // The owner is signed in to Everything, then opens the private app through a view link.
  await jar.setCookie(
    "everything-session=ui-session; Path=/; HttpOnly",
    `${origins.application}/`,
  );
  const view = await access.grant(owner, { slug: "notes" });
  const signedIn = await browse(view.url);
  assert.equal(signedIn.status, 303);
  const opened = await browse(`${origins.artifact}/notes/`);
  assert.equal(opened.status, 200);
  assert.equal(opened.body, "private notes");
  // The private app's server never received Everything's or the artifact host's session.
  assert.deepEqual(cookieNames(notesApp.received[0]!.headers.cookie), []);
  const privateCookies = ["notes_session", "notes_draft"];
  assert.deepEqual(
    cookieNames(await jar.getCookieString(`${origins.artifact}/notes/`)).filter(
      (name) => privateCookies.includes(name),
    ),
    privateCookies,
  );

  // Why a port of its own is not enough: browsers send a hostname's cookies to all its ports, so a
  // browser opening the public apps host's port under localhost sends the private app's cookies.
  // Locally the public apps Ingress has no host and answers that port under any hostname, so the
  // public apps host itself refuses localhost, before forwarding anything.
  const alias = "http://localhost:8082/board/";
  assert.ok(sharesCookieHost(origins.artifact, alias));
  assert.ok(
    cookieNames(await jar.getCookieString(alias)).includes("notes_session"),
  );
  const refused = await browse(alias);
  assert.equal(refused.status, 421);
  assert.equal(refused.headers["set-cookie"], undefined);
  assert.equal(boardApp.received.length, 0);

  // The same browser opens the public app on the public apps host, a hostname of its own.
  assert.ok(!sharesCookieHost(origins.artifact, origins.publicApps));
  assert.ok(!sharesCookieHost(origins.application, origins.publicApps));
  const firstVisit = await browse(`${origins.publicApps}/board/`);
  assert.equal(firstVisit.status, 200);
  assert.equal(firstVisit.body, "public board");
  assert.equal(boardApp.received.length, 1);
  assert.equal(boardApp.received[0]!.headers.cookie, undefined);
  for (const [name, value] of Object.entries(boardApp.received[0]!.headers))
    assert.ok(
      !/private-notes-state|unsent-private-draft|ui-session/.test(
        String(value),
      ),
      `${name} carries no private cookie`,
    );

  // The public app's own session works as usual, and stays on its own hostname.
  const secondVisit = await browse(`${origins.publicApps}/board/items`);
  assert.equal(secondVisit.status, 200);
  assert.equal(boardApp.received[1]!.path, "/items");
  assert.equal(
    boardApp.received[1]!.headers.cookie,
    "board_session=public-visitor-1",
  );
  await browse(`${origins.artifact}/notes/`);
  assert.deepEqual(cookieNames(notesApp.received[1]!.headers.cookie).sort(), [
    "notes_draft",
    "notes_session",
  ]);
});

test("the artifact host refuses the public apps host's hostname, so no pass, session, or private app cookie lands there", async (context) => {
  const { access, passes, jar, browse, notesApp, boardApp, touches } =
    await hostStack(context);
  const pass = await issuePass(passes, owner, "notes");
  const passLink = (origin: string) =>
    `${origin}${viewPassSignInPath}?token=${encodeURIComponent(pass.token)}`;
  // A teammate's pass link and an owner's view link, opened on the artifact host's port under the
  // public apps host's hostname, which the local Ingress would route there.
  const view = await access.grant(owner, { slug: "notes" });
  const code = new URL(view.url).searchParams.get("code")!;
  for (const url of [
    passLink("http://127.0.0.1:8081"),
    `http://127.0.0.1:8081/_access?code=${code}`,
    "http://127.0.0.1:8081/notes/",
  ]) {
    const refused = await browse(url);
    assert.equal(refused.status, 421, url);
    assert.equal(refused.headers["set-cookie"], undefined, url);
    assert.equal(refused.headers.location, undefined, url);
  }
  assert.deepEqual(await jar.getCookies(`${origins.publicApps}/notes/`), []);
  assert.deepEqual(touches, {
    lookups: 0,
    forwards: 0,
    files: 0,
    sessions: 0,
    viewLinks: 0,
    passes: 0,
    apiKeys: 0,
  });
  assert.equal(notesApp.received.length, 0);

  // The refused view link was not used up: it still signs the owner in on the artifact host.
  assert.equal(
    (await browse(`${origins.artifact}/_access?code=${code}`)).status,
    303,
  );
  // The same pass link works on the artifact host's own hostname, and the private app's cookies
  // stay there: a public app on 127.0.0.1 receives none of them.
  const stored = await browse(passLink(origins.artifact));
  assert.equal(stored.status, 303);
  assert.match(
    String(stored.headers["set-cookie"]),
    /everything-teammate-pass=/,
  );
  assert.equal((await browse(`${origins.artifact}/notes/`)).status, 200);
  assert.equal((await browse(`${origins.publicApps}/board/`)).status, 200);
  assert.equal(boardApp.received[0]!.headers.cookie, undefined);
});

test("teammates' in-cluster links open each host on its own Service and nowhere else", async (context) => {
  const { passes, browse, notesApp, boardApp, ports } =
    await hostStack(context);
  const pass = await issuePass(passes, owner, "notes");
  const stored = await browse(
    `${internalUrls.artifact}${viewPassSignInPath}?token=${encodeURIComponent(pass.token)}`,
  );
  assert.equal(stored.status, 303);
  assert.equal(stored.headers.location, "/notes/");
  const opened = await browse(`${internalUrls.artifact}/notes/`);
  assert.equal(opened.status, 200);
  assert.equal(opened.body, "private notes");
  const curl = await send(`http://127.0.0.1:${ports.artifact}/notes/api`, {
    host: new URL(internalUrls.artifact).host,
    authorization: `Bearer ${pass.token}`,
  });
  assert.equal(curl.status, 200);
  assert.equal((await browse(`${internalUrls.publicApps}/board/`)).status, 200);
  assert.equal(notesApp.received.length, 2);
  assert.equal(boardApp.received.length, 1);

  // Each host refuses the other's in-cluster hostname, however a request reached it.
  const crossed = [
    [ports.artifact, new URL(internalUrls.publicApps).host, "/notes/"],
    [ports.publicApps, new URL(internalUrls.artifact).host, "/board/"],
    [ports.publicApps, "artifact.everything.svc.cluster.local:8082", "/board/"],
  ] as const;
  for (const [port, host, path] of crossed) {
    const refused = await send(`http://127.0.0.1:${port}${path}`, {
      host,
      authorization: `Bearer ${pass.token}`,
    });
    assert.equal(refused.status, 421, host);
  }
  assert.equal(notesApp.received.length, 2);
  assert.equal(boardApp.received.length, 1);
});

test("the public apps host forwards a public app's own cookies and Authorization, and strips the platform's credentials", async (context) => {
  const { boardApp, ports } = await hostStack(context);
  const publicUrl = `http://127.0.0.1:${ports.publicApps}`;
  const host = new URL(origins.publicApps).host;
  // A browser sends a distinct hostname none of these; the proxy strips them anyway.
  const platformCookies = [
    "everything-artifact-session=artifact-session",
    "__Host-everything-artifact-session=secure-artifact-session",
    "everything-session=ui-session",
    "__Host-everything-session=secure-ui-session",
    "everything-teammate-pass=everything_view_pass-cookie",
  ];
  const response = await send(`${publicUrl}/board/api?page=2`, {
    host,
    cookie: [
      "board_session=public-visitor-1",
      ...platformCookies,
      "board_theme=dark",
    ].join("; "),
    authorization: "Bearer board-owned-token",
    "x-api-key": "everything_app_key_secret",
  });
  assert.equal(response.status, 200);
  assert.equal(response.body, "public board");
  const received = boardApp.received[0]!;
  assert.equal(received.path, "/api?page=2");
  assert.equal(
    received.headers.cookie,
    "board_session=public-visitor-1; board_theme=dark",
  );
  assert.equal(received.headers.authorization, "Bearer board-owned-token");
  assert.equal(received.headers["x-api-key"], undefined);
  assert.equal(received.headers["x-forwarded-prefix"], "/board");
  // A teammate pass in Authorization is the platform's too, and never reaches the app.
  await send(`${publicUrl}/board/`, {
    host,
    authorization: "Bearer everything_view_secret-pass",
  });
  assert.equal(boardApp.received[1]!.headers.authorization, undefined);
  // The app's own cookies reach the visitor, so a public app can start a session.
  const fresh = await send(`${publicUrl}/board/`, { host });
  assert.deepEqual(fresh.headers["set-cookie"], [
    "board_session=public-visitor-1; Path=/; HttpOnly",
  ]);
});
