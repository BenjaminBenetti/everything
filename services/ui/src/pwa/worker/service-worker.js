/* Only public offline assets enter the cache. Auth, API, and private pages never do. */
const offlineCache = "everything-offline-v2";

/** Install a generic offline screen without caching any user data. */
async function installOffline() {
  const cache = await caches.open(offlineCache);
  await cache.addAll(["/offline.html", "/offline.css", "/brand/icon.svg"]);
  await self.skipWaiting();
}

/** Remove only this application's obsolete offline caches. */
async function activateOffline() {
  for (const key of await caches.keys()) {
    if (key.startsWith("everything-offline-") && key !== offlineCache)
      await caches.delete(key);
  }
  await self.clients.claim();
}

/** Fall back to public installation assets only when the network is unavailable. */
async function networkOrOffline(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(offlineCache);
    return (
      (await cache.match(
        request.mode === "navigate" ? "/offline.html" : request,
      )) || Response.error()
    );
  }
}

self.addEventListener("install", (event) => event.waitUntil(installOffline()));
self.addEventListener("activate", (event) =>
  event.waitUntil(activateOffline()),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET")
    return;
  const pages = [
    "/",
    "/team",
    "/workspaces",
    "/updates",
    "/apps",
    "/apps/open",
    "/artifacts",
    "/artifacts/open",
    "/login",
  ];
  const publicAssets = ["/offline.html", "/offline.css", "/brand/icon.svg"];
  if (
    (event.request.mode === "navigate" &&
      (pages.includes(url.pathname) || /^\/team\/[^/]+$/.test(url.pathname))) ||
    publicAssets.includes(url.pathname)
  ) {
    event.respondWith(networkOrOffline(event.request));
  }
});
