# Telemetry screenshots for Everything PR #24

Screenshots from the controlled isolated storage/browser E2E fixture at source commit f125318ca49c337b869bf7b6a772d3305d8aa928. Synthetic example records, not production/customer telemetry. Default free-text excerpt withholding mode.

- 01-navigation-location.png: pixel crop from the dashboard, showing desktop left navigation and Telemetry after Keys. Crop only; no UI redrawing.
- 02-dashboard.png: full native Telemetry Events explorer with desktop navigation visible.
- 03-error-detail.png: structured model/provider error detail with default-safe diagnostics.
- 04-spans.png: Spans explorer showing provider request, model prompt and teammate turn records.

Images are hosted on this separate asset-only branch so the implementation PR head/diff remains unchanged. No release or deployment. Original retained evidence stays unchanged.
