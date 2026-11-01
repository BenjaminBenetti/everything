# Model context and image-support screenshots

These four unedited PNGs come from main's execution of the committed [model-info harness](../../../../../testing/ui/documentation/model-info-evidence.md) at exact product source [`5c9767c434a6f621c3ca166bb429d77ca5732349`](https://github.com/BenjaminBenetti/everything/commit/5c9767c434a6f621c3ca166bb429d77ca5732349). This evidence-only addition changes no product code. The same Codex primary author inspected all four images with the image-view tool at original resolution before publishing them.

## What is real and mocked

- **Real:** the production UI and its avatar/provider/context/details panels.
- **All HTTP/API responses are mocked/intercepted synthetic fixtures**, including authentication, model metadata, records and model replies. External browser HTTP requests are blocked. These screenshots do not establish actual provider discovery, backend state, live model vision, a pod restart or security isolation.
- The displayed Terra image support is a **Documentation fallback**, explicitly not API-detected. The displayed **200,000-token Fallback (default)** is an assumed planning budget, not a detected provider capacity. No published maximum was substituted.
- The separate 102 focused implementation tests and twelve mocked native SDK wire requests cover backend resolution, runtime pinning and exact pixel serialization. They are separate evidence, not proof supplied by these browser screenshots or live inference.
- Phone images use Chromium iPhone 13 emulation: CSS 390×664, scale 3, physical PNG 1170×1992. They are not physical-device captures.
- The older [seven upload screenshots](../attachments/README.md) retain their separate provenance: their upload/temp-storage/send path was real, with mocked auth, in-memory records and model. Do not apply that qualification to the all-HTTP-mocked panel captures here.

## Run and visual inspection

Main reported the actual native browser result: **4 passed, 0 unexpected, 0 flaky, 0 skipped, 0 errors, 0 retries; exit 0 in 45.6 seconds**. One worker used the existing main Chromium and process-scoped Node heap 256 MiB with an isolated fixture. No product edits, browser installation or retry occurred. The implementation worker did not rerun Chromium. The supplied [transfer manifest](BROWSER-EVIDENCE-MANIFEST.json) is copied byte-for-byte; its inspection note describes the handoff before the author's pixel inspection below.

The DOM assertions also covered selected 16,384 / Provider detected versus applied 200,000 / Fallback, discovery error, reopening and Catalog estimate 8,192 states. Those states passed the harness but are not pictured in these four captures, which show the unloaded-runtime Terra fixture.

| Capture                                            | What the author inspected                                                                                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Desktop context](desktop-context.png)             | Avatar/provider/model, no loaded runtime, selected 200,000-token budget, Fallback source, Documentation fallback image support and the assumption/non-detection explanations are readable.                                                       |
| [Desktop documentation](desktop-documentation.png) | The same viewport with the documentation link and non-API-detected caveat visible. It is nearly identical to the context capture, with a small avatar-animation difference; it is a separate unedited capture.                                   |
| [Phone context](phone-context.png)                 | The expanded compact panel shows the teammate identity/provider/model and selected context value near its lower edge. The bounded panel continues below this scroll position; the source/caveat appears in the next capture.                     |
| [Phone documentation](phone-documentation.png)     | The same compact panel scrolled down: 200,000 tokens, Fallback (default), Supported · Documentation fallback, the assumption note and the explicit non-API-detected caveat are readable. The top of the identity block has scrolled out of view. |

No serious visible defect was found. Minor compact-layout observations: the desktop context label and explanatory prose wrap, and the phone uses separate scroll views to expose the whole panel. No images were cropped, composited, retouched or regenerated, and no product styling was changed for evidence.

## Integrity

The author independently checked each PNG signature, dimensions, byte count and SHA-256 against the transfer manifest, and verified the copied files remain byte-identical. Four PNGs plus the original manifest total 520,774 bytes.

| File                        | PNG dimensions |   Bytes | SHA-256                                                            |
| --------------------------- | -------------- | ------: | ------------------------------------------------------------------ |
| `desktop-context.png`       | 1440×960       |  93,233 | `be911e90fcb4cbd1790ff46c4eff11f86876db869ee39b0a180d3ab5adf500cd` |
| `desktop-documentation.png` | 1440×960       |  93,290 | `c2221a4d373a42846ddc83c70bff97940c9cae4eda5ba881d1b6a26c414185bd` |
| `phone-context.png`         | 1170×1992      | 161,667 | `73b955a401bbcaded08bce85b1a2fb83942e553d5bb9dfc81720a3719550eb82` |
| `phone-documentation.png`   | 1170×1992      | 170,738 | `fafe92880af1d1438de4da8c6d33c7466cfc4469ef5e0c9a53d18a2dc9eba9e5` |
