# Compact Context row and persistent cache evidence

Main ran this harness at exact source `5cb3e3240e083055397b206381a6488e7090ef53`: **8/8 passed, native browser exit 0, retry 0, one worker, 105.060267 seconds** (structured duration; browser command 107 seconds). The [four original screenshots, eight count records, bounded manifest and same-author visual inspection](../../../services/ui/documentation/assets/compact-context-cache/README.md) are published separately from implementation tests. This finishing commit changes evidence/docs only. The worker did not rerun, install or repair a browser. The old model-info harness/assets remain historical evidence at source `5c9767c434a6f621c3ca166bb429d77ca5732349`.

The following commands document the isolated run at the tested implementation source; they are not a request for another run. Main used its existing executable and a **fresh owned** output directory:

```sh
pnpm --filter @everything/ui-service... build
context_cache_run=$(mktemp -d /tmp/everything-context-cache-XXXXXX)
MODEL_INFO_E2E_ROOT="$context_cache_run" \
PLAYWRIGHT_CHROMIUM_EXECUTABLE="<existing-main-chromium>" \
NODE_OPTIONS=--max-old-space-size=256 \
pnpm --filter @everything/ui-tests test:context-cache
```

The inherited config starts only Vite on localhost:5187 (optional `MODEL_INFO_E2E_PORT`), one worker, retry zero, no traces or service workers. All **eight tests passed**: four scenarios on desktop Chromium 1440×960 and four on iPhone 13 Chromium emulation (CSS 390×664 at device scale 3; PNG 1170×1992). Phone evidence is emulation, not a physical-device test. Do not run the historical `test:model-info` harness against the new compact UI.

These are real production UI consumers, HTTP adapters and browser localStorage. **All HTTP/API/authentication/connection actions/model metadata/runtime/history are synthetic intercepted fixtures**, including the explicit connection check. External browser requests are blocked. No actual credential/provider request, inference, cluster, backend detection, deployment or installer is involved. Screenshots prove the rendered compact panels; request-count assertions prove this fixture's client caching behavior. They do not prove live provider discovery or backend runtime state.

The scenarios cover:

- One Context row directly after Effort in the existing chat and profile grids; quiet initial placeholder; matching applied budget preferred over selected; details/dialog reopen, SPA navigation, focus, new-message runtime polling and full `page.reload()` all keep the model-info count at **one** and provider-model discovery at **zero**.
- First failure stays quiet. Persisted data aged just below 24h causes no request; aged beyond 24h refreshes while retaining its count through a held request and failure, then recovers. Aging changes only fixture localStorage timestamps, rather than waiting 24h; unit tests also control the clock at the exact TTL boundary.
- A new model never shows the previous model's number; inference changes retire the entry, cosmetic name changes reuse it, and changed public connection identity invalidates it.
- The actual connection-action consumer invalidates even with identical public identity; the actual logout consumer removes storage; a different owner starts empty. Delayed adapter response isolation, bounded/corrupt storage and unavailable storage are also covered by focused worker tests.

Published artifacts in the [evidence folder](../../../services/ui/documentation/assets/compact-context-cache/README.md):

- `desktop-chat-after.png`, `phone-chat-after.png`: the compact chat/provider panel after a full reload, showing Context 200,000 tokens. The fixture has matching applied 200000 and selected 16384; only the effective count is visible.
- `desktop-profile-after.png`, `phone-profile-after.png`: the corresponding compact profile details, Context immediately after Effort level.
- Per-project `fresh-counts.json`, `ttl-counts.json`, `identity-counts.json` and `owner-counts.json`, each written exclusively after its scenario's assertions pass.

The bounded manifest records the tested commit, native phase exits, test conclusions, duration, retry count, PNG SHA-256/dimensions and all eight count values. The same author inspected all four original PNGs using the image tool: Context 200,000 tokens appears directly after Effort (Effort level in profile details), with no verbose metadata block or clipped count. Images and count files are byte-identical to the captured originals. Only manifest whitespace was formatted; its captured/committed hashes and identical parsed values are recorded in the evidence README. Screenshots show compact UI; the browser assertions and count JSONs establish fixture cache/network behavior.

Before images are already public: [desktop before](https://raw.githubusercontent.com/BenjaminBenetti/everything/40e040120e9d40189e4479879fad2167dc0d4be0/services/ui/documentation/assets/model-info/desktop-context.png) and [phone before](https://raw.githubusercontent.com/BenjaminBenetti/everything/40e040120e9d40189e4479879fad2167dc0d4be0/services/ui/documentation/assets/model-info/phone-context.png). Their [original provenance](../../../services/ui/documentation/assets/model-info/README.md) remains unchanged. Never publish the private user reference image.

The production cache persists only sanitized context counts, original timestamps, owner/teammate/inference identity and a digest of public connection identity. Freshness is 24h without sliding extension on visits; stale values can be retained up to seven days while refreshing or after errors. Storage is capped at 64 entries and 64 KiB UTF-8; unavailable storage falls back to memory, so reload persistence is not guaranteed when storage is blocked/full. Owner/logout/provider/model/inference and explicit connection operations invalidate entries; status-check timestamps and cosmetic profile fields do not. The public API has no stable credential revision: same-public-identity edits made through this browser are explicitly invalidated, while identity changes reported by the connection API are detected on later reads. An indistinguishable credential edit in another browser cannot be observed before TTL without a backend revision. Backend budgets, capabilities and source/runtime semantics are unchanged.
