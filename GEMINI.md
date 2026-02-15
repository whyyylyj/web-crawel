# Gemini Project Context: Network Capture Assistant

This project is a Chrome extension built with Manifest V3 designed to capture, filter, and export network requests from the browser.

## Project Overview

- **Purpose**: Real-time network request capture with regex filtering and JSON export.
- **Main Technologies**: 
  - JavaScript (Vanilla ES6+)
  - Chrome Extension APIs (Manifest V3)
    - `webRequest`: Metadata capture (headers, status, timing).
    - `storage.local`: Persistent settings and records.
    - `downloads`: JSON data export.
    - `commands`: Keyboard shortcuts (`Ctrl+Shift+K` to toggle, `Ctrl+Shift+J` to export).
    - `scripting`: Content script injection.
  - **Testing**: Playwright for E2E testing.

## Architecture: Two-Source Capture Model

The extension uses two parallel mechanisms to capture data, which are merged in the background service worker:

1.  **`background.js` (Service Worker)**: 
    - Uses `chrome.webRequest` to capture request metadata (URL, method, headers, status code, performance timing).
    - Acts as the central state manager (settings, stats, records).
    - Handles OR-logic filtering: a request is captured if it matches *any* enabled regex rule.
2.  **`content/content.js` (Content Script)**:
    - Injects a script into the page's main world to hook `window.fetch` and `XMLHttpRequest`.
    - Captures request/response bodies which are not accessible via `webRequest` in MV3.
    - Sends data back to the service worker via `window.postMessage` and `chrome.runtime.sendMessage`.

### Data Merging
Records are merged using `(tabId, method, normalizedUrl)` as keys to associate `webRequest` metadata with body data from the content script.

## Development Workflows

### Loading the Extension
1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the project root directory.

### Running Tests
The project uses Playwright for E2E tests located in the `tests/` directory.

```bash
cd tests
npm install
npm run install:browsers  # Install Chromium if needed
npm test                  # Run all tests
npm run test:headed       # Run tests with a visible browser
```

## Development Conventions & Constraints

- **Manifest V3**: Strictly follows MV3 standards (e.g., no background pages, service worker for background tasks).
- **Memory & Storage Safety**:
  - `MAX_RECORDS`: Limited to 1500 records in `storage.local` to prevent bloat.
  - `MAX_BODY_LENGTH`: Bodies are truncated at 200,000 characters with a `...<TRUNCATED>` marker.
  - `MAX_URL_RULES`: Maximum of 20 concurrent filtering rules.
- **Filtering Logic**: 
  - Compiled regex rules are used for matching.
  - OR logic: if multiple rules are enabled, any match triggers capture.
  - Empty rule list results in capturing all requests.
- **Exporting**: Files are exported via `chrome.downloads` and must be relative to the user's Downloads directory.
- **Communication**: Uses a request-response pattern via `chrome.runtime.sendMessage` with `STATE_UPDATED` broadcasts for real-time UI updates in popup and options pages.

## Key Files
- `manifest.json`: Extension configuration and permissions.
- `background.js`: Main logic, filtering, and data management.
- `content/content.js`: Body capture via page-level injection.
- `popup/`: UI for status monitoring and quick actions.
- `options/`: Configuration UI for rules and settings.
- `tests/e2e.spec.js`: E2E test suite.
