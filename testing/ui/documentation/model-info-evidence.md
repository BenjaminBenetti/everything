# Focused model-information browser evidence

Main ran this committed harness at exact source `5c9767c434a6f621c3ca166bb429d77ca5732349`: **4/4 passed in 45.6 seconds, native exit 0, no retries**, using its existing Chromium, one worker and a process-scoped 256 MiB Node heap. The [four screenshots, original manifest, hashes and author visual inspection](../../../services/ui/documentation/assets/model-info/README.md) are now recorded separately from implementation tests. The implementation worker has no launchable Chromium and did not rerun, install or repair it.

The production UI/panels are real, while **all HTTP/API/authentication/model metadata/records/model replies are intercepted synthetic fixtures**. These captures do not prove actual provider discovery, backend state, live vision, pod restart or security isolation. The older upload screenshots have a different real-upload/temp-storage provenance and remain unchanged. The commands below document how the isolated run was configured; they are not a request for another run.

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

Phone captures scroll the existing compact details panel to show the context and documentation note; these are separate views, not a composite. The evidence README records the tested source, main's native exit/test conclusions, viewport/emulation, asset hashes and the same Codex author's inspection of all four actual images. The seven older upload screenshots and their source/provenance remain unchanged. The earlier implementation task's evidence-pending failed receipt is preserved; this finishing task records the completed evidence delivery independently.
