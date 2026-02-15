# Repository Guidelines

## Project Structure & Module Organization
This is a Manifest V3 Chrome extension with plain JavaScript modules.

- `manifest.json`: extension entry, permissions, commands, and page wiring.
- `background.js`: service worker; capture pipeline, filtering, state, and export.
- `content/content.js`: injects page hooks for `fetch`/`XMLHttpRequest` body capture.
- `popup/`: popup UI (`popup.html`, `popup.js`, `popup.css`) for runtime control and stats.
- `options/`: settings UI for regex rules and capture options.
- `icons/`: packaged extension icons.
- `tests/`: Playwright E2E workspace (`e2e.spec.js`, `playwright.config.js`, own `package.json`).

## Build, Test, and Development Commands
No bundling/build step is required for the extension itself.

- Load locally: open `chrome://extensions`, enable Developer Mode, then **Load unpacked** this repo.
- Install test deps: `cd tests && npm ci`
- Install Playwright browser: `cd tests && npm run install:browsers`
- Run E2E tests: `cd tests && npm test`
- Run headed tests: `cd tests && npm run test:headed`
- CI-style run: `cd tests && HEADLESS=1 npm test`

## Coding Style & Naming Conventions
- Use plain ES2020+ JavaScript with 2-space indentation and semicolons.
- Prefer `const`/`let`; avoid global mutable state outside extension lifecycle needs.
- Naming:
  - `camelCase` for variables/functions (`sanitizeSavePath`).
  - `UPPER_SNAKE_CASE` for constants (`MAX_BODY_LENGTH`).
  - kebab-case for Chrome command IDs (`capture-toggle`).
- Keep modules focused by responsibility (capture in background, UI logic in popup/options).
- No formatter/linter config is currently enforced; match existing style in touched files.

## Testing Guidelines
- Framework: Playwright (`@playwright/test`) in `tests/`.
- Keep tests deterministic: single worker, explicit waits/polls, isolated temp dirs.
- Naming: place E2E specs in `*.spec.js`; use descriptive `test('...', ...)` titles for user flows.
- Cover critical flows: load extension, toggle capture, rule CRUD, export behavior.

## Commit & Pull Request Guidelines
Git history is not available in this workspace, so follow a consistent convention:

- Commit format: `type(scope): summary` (e.g., `fix(background): prevent oversized body writes`).
- Keep commits small and single-purpose; include tests for behavior changes.
- PRs should include:
  - what changed and why,
  - affected areas (`background`, `popup`, `options`, `tests`),
  - test evidence (command + result),
  - screenshots/GIFs for UI changes (`popup`/`options`).

## Security & Configuration Tips
- Minimize changes to `permissions`/`host_permissions`; justify them in PR text.
- Do not persist secrets or sensitive payloads in captured records.
- Keep `save_path` relative to Chrome downloads (no absolute paths).
