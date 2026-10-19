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

## Animations

Your team cards opt into the `idle` animation. The chat's teammate card shows `idle`, and both it and the phone chat header switch to `thinking` while the teammate's main session works. Active rows in the chat's Workspaces card opt into `typing`. Sidebar images, profile details, editor previews, and the avatar picker keep the original still image. Persisted IDs continue to identify characters; animation names are presentation choices and never enter the API or saved profile.

The [animation registry](../src/agent/service/avatar-animation-registry.ts) accepts named React effects through `register(name, component, optionalStillPose)`. Register new effects alongside `idle` in the [browser composition root](../src/application/bootstrap/client.tsx), then opt in with `<TeammateAvatar animation="name" animationSeed={teammate.id} />`. Effects receive the character's stable `avatarId` and an instance `seed`, and render a decorative layer over the original image. Registration rejects duplicate names; an unknown name leaves the still image visible. Consumers depend on the lookup interface rather than the registry implementation.

The avatar renderer waits for the original artwork to load. The shared [playback component](../src/agent/component/avatar-animation.tsx) then plays effects while the avatar is onscreen, the document is visible, and reduced motion is off. Otherwise it renders the registered still pose, if any. Motion preference changes take effect immediately. Effects that also supply their still pose gate CSS animations on `data-animation-active="true"`; other effects should clean up any resources they create when unmounted.

The first effect adds brief closed-eye frames approximately every three seconds, with a stable duration and phase derived from each teammate's ID so matching avatars do not blink together. The [eye regions](../src/agent/model/avatar-idle-eyes.ts) align to the 128 × 128 pixel artwork for all 64 characters; the moon retains its already-closed eye. SVG eyelid overlays and stepped CSS timing preserve the original silhouettes and pixel style without additional bitmap assets or image requests. Update the corresponding eye regions if character artwork changes.

The [typing effect](../src/agent/component/typing-avatar-animation.tsx) combines the saved character artwork, alternating hands in the [character's palette](../src/agent/model/avatar-typing-colors.ts), and a single shared [laptop asset](../src/agent/component/avatar-laptop.tsx). Reduced motion retains the laptop with no animation. Workspace rows always reserve the avatar's space, and show it for 30 seconds after the teammate or one of its private forks interacts with that workspace. Activity in another teammate's chat does not trigger the effect.

The [thinking effect](../src/agent/component/thinking-avatar-animation.tsx) rests a paw in the same palette on the character's chin under a single shared [thought cloud](../src/agent/component/avatar-thought-cloud.tsx). The artwork shrinks slightly toward the lower left to make room for the cloud. The [pose](../src/agent/model/avatar-thinking-pose.ts) places each paw below the mouth using the eye regions, so update both together if character artwork changes. While motion plays, the paw scratches and the cloud drifts; reduced motion keeps the same pose, still. The avatar keeps its size, so the header and card don't move.

The chat shows `thinking` only while the runtime status reports `mainRunning`, from a successful read made since the conversation opened. It covers the main session's whole turn, including tools, summarizing older context, writing a reply, and a turn woken by a fork's result. Background teammates working alone change only the background count, and both cues appear together when both are working. Completion, failure, Stop, a failed refresh awaiting Reconnect, and a cached status from an earlier visit all show the ordinary avatar. A visually hidden status tells screen readers "*name* is working" when the turn starts; the motion itself is never announced. Other teammate images, such as the sidebar and team cards, don't show the effect, because only the open conversation reads its teammate's status.

[Screenshots](assets/thinking-avatar/README.md) show the pose on desktop and phone.
