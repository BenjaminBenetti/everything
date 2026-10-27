# Apps public-access — screenshots for PR #27

Screenshots of the "make an app public" feature and of the public/private isolation fix.
Captured from the real UI and the real artifact-service hosts using synthetic demo data only —
no real saved app was changed and no real user content or credentials appear. Feature source head:
`18407c4` on `splash/apps-user-public`.

## Feature (Apps UI)

| | Desktop | Phone |
|---|---|---|
| Apps screen, Private/Public badges | feature/desktop-01-apps.png | feature/phone-01-apps.png |
| Make-public confirmation (audience + security warning) | feature/desktop-02-make-public.png | feature/phone-02-make-public.png |
| Public state: copy/open public link, make private | feature/desktop-03-public-link.png | feature/phone-03-public-link.png |
| Signed-out visitor opening a public demo app | feature/desktop-04-visitor-public-app.png | feature/phone-04-visitor-public-app.png |

The public link shown is the stable, token-free URL on the public apps origin
(`public-apps.example.com` in the demo), not a sign-in or viewer-pass link.

## Isolation (security evidence)

Real browser (Chromium), real artifact-service hosts over HTTP, real view-link session auth,
disposable local fixture apps with a synthetic canary string.

- **before-public-reads-private.png** — on the unchanged feature head `3a239be` (single shared
  origin), a public app's page reads the owner's private app's canary same-origin. The hole.
- **after-01-owner-private-canary.png** — with the fix, the signed-in owner still reads their
  private app directly (positive control).
- **after-02-public-cannot-read-private.png** — with the fix, a public app on its own origin can
  read its own content (OK) but its cross-origin read of the private app is blocked by the browser.

These images are examples; they are not a proof of every security property. The full before/after
checks and tests are described in the PR and its review notes.
