# Focused model-information browser evidence

Run this committed harness in main's existing Chromium environment. The implementation worker has no launchable Chromium; do not install or repair browsers there. The harness has not been executed in Chromium by the worker, so screenshots and browser assertions remain pending until main records a native exit and inspects the captures.

Build the source at the exact handoff commit first:

```sh
pnpm --filter @everything/ui-service... build
```

Choose a fresh owned absolute output directory and use main's existing Chromium executable:

```sh
model_info_run=$(mktemp -d /tmp/everything-model-info-XXXXXX)
MODEL_INFO_E2E_ROOT="$model_info_run" \
PLAYWRIGHT_CHROMIUM_EXECUTABLE="<existing-main-chromium>" \
NODE_OPTIONS=--max-old-space-size=256 \
pnpm --filter @everything/ui-tests test:model-info
```

The config starts one local Vite server at `http://localhost:5187` (override with `MODEL_INFO_E2E_PORT` if necessary), uses one worker, no retries, no service workers and no traces. No API service, cluster, database or inference endpoint is contacted. The fixtures intercept all API responses and block external browser requests. They do not use real credentials or files. Do not add automatic retries or modify product source while gathering evidence.

Four tests are expected: two scenarios on desktop Chromium (1440×960), and the same two on Chromium iPhone 13 emulation. They cover the real avatar/provider panel with the exact synthetic Terra metadata, loading, transport/discovery errors, fresh selected metadata alongside an older applied runtime, refresh on a newly observed turn, and reopened profile/model state. Backend parser/resolver/runtime-pinning truth is tested separately in service tests; browser fixtures do not prove discovery or inference.

Expected artifacts beneath `$model_info_run`:

- `evidence/desktop-context.png` and `desktop-documentation.png`.
- `evidence/phone-context.png` and `phone-documentation.png`.
- `playwright/` for failure artifacts if any. The explicit evidence directory is not Playwright's cleared output directory.

Phone captures scroll the existing compact details panel to show the context and documentation note; these are separate views, not a composite. Record the source SHA, command/native exit, test conclusions, viewport/emulation, and asset hashes. Visually inspect the actual captures before committing evidence or updating PR30. Keep the seven older upload screenshots and their source/provenance unchanged. Browser screenshot completion will resume the same Codex author under a new finishing receipt.
