import type { ArtifactFailure } from "@everything/artifact-contracts";

/** Escape text for HTML element content. */
function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** A small, self-contained page explaining why an app cannot be shown. */
export function hostPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; }
  main { max-width: 32rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { margin: 0; line-height: 1.5; opacity: 0.8; }
</style>
</head>
<body><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body>
</html>
`;
}

/** Copy for each reason the app host cannot show an app. */
export const hostMessages = {
  notFound: {
    title: "App not found",
    message: "This app doesn't exist, or it was deleted.",
  },
  unpublished: {
    title: "Nothing published yet",
    message:
      "A teammate hasn't published or deployed this app yet. Check back later.",
  },
  unavailable: {
    title: "This app isn't available",
    message:
      "Its owner hasn't published it yet or has stopped it. Try again later.",
  },
  stopped: {
    title: "This app is stopped",
    message:
      "This app was stopped. Start it from Apps in Everything, or ask a teammate.",
  },
  unreachable: {
    title: "This app isn't responding",
    message: "It may still be starting. Wait a moment, then reload the page.",
  },
  blockedResponse: {
    title: "This app's response was blocked",
    message:
      "We couldn't safely forward this response. Ask a teammate to check the app for exposed credentials.",
  },
  expiredLink: {
    title: "This link has expired",
    message: "Open the app again from Everything.",
  },
  signInRequired: {
    title: "Sign in to view this app",
    message: "Open the app from Everything to sign in.",
  },
  passExpired: {
    title: "This teammate link has expired",
    message:
      "Teammate links work for a few minutes. Get a new link to keep viewing this app.",
  },
} as const;

/** JSON answer to a request whose API key opens nothing; every reason looks the same. */
export const apiKeyRejection: ArtifactFailure = {
  code: "INVALID_API_KEY",
  message:
    "This app didn't accept the API key. Send the app's current key in a single X-Api-Key header.",
};
