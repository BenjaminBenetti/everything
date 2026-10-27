import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cookieHost,
  hostCookieHost,
  sharesCookieHost,
} from "../model/cookie-host.js";

test("a cookie host ignores ports and schemes, case, and a trailing dot", () => {
  for (const [first, second] of [
    ["http://localhost:8081", "http://localhost:8082"],
    ["http://localhost:8080", "https://localhost"],
    ["https://artifacts.example.com", "http://ARTIFACTS.Example.com:8443"],
    ["https://artifacts.example.com", "https://artifacts.example.com."],
    ["http://localhost:8081", "http://LOCALHOST.:8082"],
  ] as const)
    assert.ok(sharesCookieHost(first, second), `${first} and ${second}`);
  assert.equal(
    cookieHost("http://Public-Apps.Example.com.:8443/"),
    "public-apps.example.com",
  );
});

test("distinct hostnames, loopback addresses, and siblings are separate cookie hosts", () => {
  for (const [first, second] of [
    ["http://localhost:8081", "http://127.0.0.1:8082"],
    ["http://localhost:8081", "http://[::1]:8082"],
    ["https://artifacts.example.com", "https://public-apps.example.com"],
    ["https://example.com", "https://public-apps.example.com"],
    [
      "http://artifact.everything.svc.cluster.local:8080",
      "http://public-apps.everything.svc.cluster.local:8082",
    ],
  ] as const)
    assert.ok(!sharesCookieHost(first, second), `${first} and ${second}`);
});

test("a Host header names the cookie host its browser keeps cookies under, however it is spelled", () => {
  for (const [host, expected] of [
    ["localhost:8082", "localhost"],
    ["LOCALHOST.:8082", "localhost"],
    ["localhost.", "localhost"],
    ["127.0.0.1:8082", "127.0.0.1"],
    ["127.0.0.1.:8082", "127.0.0.1"],
    // Browsers write these IPv4 forms as 127.0.0.1 before sending them, and keep cookies there.
    ["127.1", "127.0.0.1"],
    ["0x7f.0.0.1:8081", "127.0.0.1"],
    ["[0:0:0:0:0:0:0:1]:8082", "[::1]"],
    [
      "PUBLIC-APPS.everything.svc.cluster.local.:8082",
      "public-apps.everything.svc.cluster.local",
    ],
  ] as const)
    assert.equal(hostCookieHost(host), expected, host);
  assert.equal(
    hostCookieHost("public-apps.example.com:443"),
    cookieHost("https://public-apps.example.com"),
  );
});

test("a Host header that is not a host and an optional port names no cookie host", () => {
  for (const host of [
    undefined,
    "",
    ".",
    "localhost:",
    "localhost:99999",
    "127.0.0.1:8082@localhost",
    "user@127.0.0.1",
    "127.0.0.1/board",
    "127.0.0.1:8082,localhost:8082",
    "127.0.0.1 localhost",
    "http://127.0.0.1",
    "1.2.3.4.5",
    "exa_mple.com",
  ])
    assert.equal(hostCookieHost(host), undefined, JSON.stringify(host));
});
