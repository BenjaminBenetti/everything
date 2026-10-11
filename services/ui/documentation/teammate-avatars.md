# Teammate avatars

The catalog ships 64 individually generated static pixel-art characters with transparent backgrounds. The artwork was created with the built-in image-generation tool, with one generation request per character. No image-generation API, external stock collection, or runtime image service is involved.

## Assets and prompts

- [Bundled artwork](../public/teammate-avatars): `avatar-01.webp` through `avatar-64.webp`.
- [Animals, 01–32](teammate-avatar-prompts-01-32.md): exact prompts and original generation paths.
- [Characters and objects, 33–57](teammate-avatar-prompts-33-57.md): exact prompts and original generation paths.
- [Objects, 58–64](teammate-avatar-prompts-58-64.md): exact prompts and original generation paths.

Original tool outputs were packaged as 128 × 128 lossless WebP files using Sharp 0.35.5. Nearest-neighbor resizing retains the square-pixel style; containment preserves the full silhouette and transparent padding. Packaging changes resolution and encoding only. The 64 files total 752,880 bytes. The application serves them from its own origin and uses `image-rendering: pixelated` at display sizes of 24–64 CSS pixels. Sharp is a one-time artwork preparation tool, not an application dependency.

All 64 final images were checked for distinct content, matching catalog IDs, dimensions, and alpha transparency. Original PNGs are retained at their generated source paths and, for this workspace session, under `.local/teammate-avatar-originals/`; the deployment includes only the optimized WebP files.

## Ownership and reuse

Stable IDs and the default selection belong to `@everything/agent-contracts/avatar`. The API validates and persists IDs; it does not accept arbitrary image URLs. Existing teammates receive `avatar-01` through the tracked migration.

The UI's [catalog](../src/agent/model/teammate-avatars.ts) adds display names, groups, and image paths. [TeammateAvatar](../src/agent/component/teammate-avatar.tsx) renders every card, detail, editor preview, and sidebar image. [AvatarPicker](../src/agent/component/avatar-picker.tsx) provides search and category filters using the same reusable choice cards as Preferences.

Each new teammate draft starts with a random avatar from the full catalog. The choice stays stable while editing the draft, and existing teammates open with their saved avatar. Avatar choices stay in the profile draft until Save changes or Create teammate succeeds. Back discards only an unconfirmed picker selection, while Cancel discards the complete profile draft. Failed requests preserve the draft for retry.

Animations remain a future task. Persisted IDs identify characters rather than files or animation states, so future renderers can add states without changing saved teammate selections.
