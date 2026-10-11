# User Surfaces

Exported from [ChatGPT Pages](https://chatgpt.com/space/page_b5de4204a0808191a448e59fce061e9e) on 2026-10-11. Source last updated 2026-10-10.

[Back to the overview](overview.md)

## Web app

The React web app is Everything's primary user surface. It uses Tailwind CSS and is served by the UI pod, as described in [Architecture](architecture.md).

### Visual design and themes

Midnight is Everything's default theme, paired with Signal's grid artwork and the constellation logo. Multiple color themes are a product requirement: the desktop web app and iPhone PWA use shared semantic design tokens for surfaces, text, actions, borders, and other visual roles. Components keep the same layout, typography, and behavior across themes.

The [interactive UI concept](https://everything-ui-concept.solar-tapir-0156.chatgpt.site) includes two dark themes (Midnight and Graphite) and two light themes (Daylight and Sand), with a theme picker and a remembered selection. Carry this token-based approach into the React and Tailwind implementation.

## iPhone progressive web app

**Decision: Everything will support installation on iPhone as a progressive web app (PWA).** This uses the same React application and UI pod. Users add it to their Home Screen through Safari, with Open as Web App enabled. [Apple installation instructions](https://support.apple.com/en-lamr/guide/iphone/iphea86e5236/ios)

### Push notifications

Push notifications are a core requirement for user-facing agent messages and updates, including when the app is closed. On iPhone, users install the app on the Home Screen and explicitly enable notifications from within it. Home Screen Web Push is supported on iOS 16.4 and later and does not require paid Apple Developer Program membership. [WebKit Web Push documentation](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

The Everything backend handles Web Push delivery. Agents continue running on the server while the phone app is closed.
