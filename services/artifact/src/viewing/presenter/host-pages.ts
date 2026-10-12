/** Escape text for HTML element content. */
function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** A small, self-contained page explaining why an artifact cannot be shown. */
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

/** Copy for each reason the artifact host cannot show an artifact. */
export const hostMessages = {
  notFound: {
    title: "Artifact not found",
    message: "This artifact doesn't exist, or it was deleted.",
  },
  unpublished: {
    title: "Nothing published yet",
    message:
      "A teammate hasn't published or deployed this artifact yet. Check back later.",
  },
  stopped: {
    title: "This artifact is stopped",
    message:
      "A teammate stopped this artifact. Ask a teammate to deploy it again.",
  },
  unreachable: {
    title: "This artifact isn't responding",
    message:
      "Its app may still be starting. Wait a moment, then reload the page.",
  },
  expiredLink: {
    title: "This link has expired",
    message: "Open the artifact again from Everything.",
  },
  signInRequired: {
    title: "Sign in to view this artifact",
    message: "Open the artifact from Everything to sign in.",
  },
} as const;
