# API Reference in Developer Settings

## Goal

Move the Riot Client REST API reference out of the primary navbar and into
Settings → Developer so the navbar stays focused and compact.

## Design

- Remove the `swagger` route and “API Reference” tab from the navbar.
- Add an “API Reference” setting row under the Developer section with the
  description “Riot Client REST API”.
- The row opens the existing `SwaggerPage` as a full-page panel owned by the
  Settings page. The panel includes a back button that returns to Settings.
- Preserve the existing raw OpenAPI JSON URL, open, and copy controls below the
  new row.
- Keep the existing lazy loading and error boundary behavior for Swagger UI.

## Verification

- A source-level navigation test verifies that the navbar no longer owns the
  Swagger route and Settings owns the API-reference entry.
- `bun run build:vite` verifies TypeScript and the production frontend build.
