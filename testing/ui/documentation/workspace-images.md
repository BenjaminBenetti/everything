# Workspace Markdown browser verification

Source-phase harness; browser screenshots are pending MAIN execution. No worker browser is installed or repaired.

Run from a fresh guarded archive of the exact PR head, after frozen dependency installation and shared library builds:

```sh
pnpm --filter "@everything/ui-service^..." --filter "@everything/everything^..." build
WORKSPACE_IMAGES_E2E_ROOT=/tmp/<fresh-owned-empty-output> PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium NODE_OPTIONS=--max-old-space-size=256 pnpm --filter @everything/ui-tests test:workspace-images
```

The output root must already exist and be empty; the gateway creates its exclusive `volume` and `evidence` directories. Default ports are UI localhost:5193 and loopback gateway 18193; override `WORKSPACE_IMAGES_E2E_UI_PORT`/`WORKSPACE_IMAGES_E2E_GATEWAY_PORT` together if required. One worker, retries zero, desktop Chromium plus iPhone 13 viewport/touch emulation. No external network is allowed by the browser fixture. Physical phone, native generation, production identity, or clipboard behavior is not claimed.

A fixture-only reset endpoint clears synthetic in-memory messages between desktop/phone projects; it never touches workspace files and is absent from production.

Real boundaries: production Vite UI, Markdown parser/image components, conversation HTTP/controller/service and actual `send_message` tool, authenticated production image handler/service, no-follow filesystem reader, real temporary raster bytes and decoder. Synthetic boundaries: bearer/browser session verification, in-memory owned teammate/message records, text-only model reply, unrelated directory/provider/model-info/read-receipt/update/workspace/voice metadata. Image/content/message/runtime/session HTTP is NOT intercepted with fake bytes.

Two tests (one per project) assert no file-creation post, explicit relative/absolute image rendering, correct unchanged bytes via real HTTP, unavailable-image fallback, plain/link/code/HTML non-image controls, no image refetch across two runtime polls, reload, a second teammate's differing actual pixel width, return to first history, and phone overflow bounds. Expected outputs: `evidence/{desktop,phone}-{inline,other-workspace}.png` and `{desktop,phone}-assertions.json`. Screenshots contain only synthetic files. Inspect all four originals before publishing any evidence; fixture assertions are not visual proof. Preserve native exit, full test summary, hashes/dimensions and bounded provenance manifest outside source. No PR-ready claim until MAIN evidence and final-head automatic CI are complete.
