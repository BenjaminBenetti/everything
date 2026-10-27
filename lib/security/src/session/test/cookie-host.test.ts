import assert from "node:assert/strict";
import { test } from "node:test";
import { cookieHost, sharesCookieHost } from "../model/cookie-host.js";

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
