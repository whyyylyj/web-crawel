# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Network Capture Assistant** Chrome extension (Manifest V3) that captures browser network requests with configurable filtering rules. It supports regex-based URL filtering, keyboard shortcuts, request/response body capture, and JSON export.

## Development Commands

### Load Extension in Chrome

```bash
# 1. Package the extension (no build step required - plain JS)
# The extension root is the current directory

# 2. Load in Chrome
# Open chrome://extensions/
# Enable "Developer mode"
# Click "Load unpacked"
# Select this directory
```

### E2E Testing (Playwright)

```bash
cd tests/
npm install
npm run install:browsers  # Install Chromium
npm test                  # Run tests
npm run test:headed       # Run with visible browser
```

### Single Test

```bash
cd tests/
npx playwright test -g "test name"
```

## Architecture

### Data Flow: Two-Source Capture Model

The extension uses **two parallel capture mechanisms** that merge results:

1. **webRequest API** (background.js) - Captures request metadata (URL, method, headers, status, timing)
2. **Content Script Injection** (content/content.js) - Injects page script to hook `fetch`/`XMLHttpRequest` for request/response bodies

The two sources are merged using:
- `requestIndexById` - Maps requestId to record index
- `mergeCandidatesByKey` - Maps `(tabId, method, normalizedUrl)` to candidate indices for matching content script data with webRequest metadata

### Key Components

**background.js** (Service Worker):
- State management: `settings`, `stats`, `records`
- `compileFilterRegex()` - Compiles enabled regex rules for filtering
- `shouldCaptureUrl()` - OR logic: matches if ANY enabled rule matches (empty rules = capture all)
- `mergeContentCapture()` - Merges content script data with webRequest records
- Message handlers: `GET_STATE`, `TOGGLE_CAPTURE`, `EXPORT_CAPTURE`, `UPDATE_SETTINGS`, `CONTENT_NETWORK_EVENT`

**content/content.js**:
- `injectPageScript()` - Injects script into page context to hook fetch/XHR
- Uses `window.postMessage` to bridge isolated worlds (page script → content script → background)
- `MAX_LEN = 200000` - Truncates large bodies to prevent memory issues

**popup/popup.js**:
- Real-time status display with 1.5s polling via `requestState()`
- Badge sync with `chrome.action.setBadgeText()`

**options/options.js**:
- Multi-rule management (add/remove/enable/disable rules)
- Regex syntax validation before saving
- Uses callback-style `chrome.runtime.sendMessage()` wrapper to avoid silent failures

### Storage Schema

**Settings** (`chrome.storage.local` key: `settings`):
```javascript
{
  capture_enabled: boolean,
  url_filter_rules: [{ id, pattern, enabled }],  // NEW: multi-rule array
  save_path: string,           // Relative path under Downloads
  capture_request_data: boolean,
  capture_response_data: boolean,
  capture_performance_data: boolean
}
```

**Stats** (key: `capture_stats`):
```javascript
{
  total_requests: number,
  matched_requests: number,
  captured_requests: number,
  error_count: number,
  last_capture_time: string,  // ISO timestamp
  last_export_time: string,
  last_error: string
}
```

**Records** (key: `capture_data`):
```javascript
{
  id: string,
  created_at: string,        // ISO timestamp
  source: ['webRequest'|'contentScript'],
  request: { request_id, tab_id, url, method, type, initiator, headers, body },
  response: { status_code, status_line, headers, body },
  performance: { start_time, end_time, duration_ms, from_cache, source },
  errors: []
}
```

### Important Constraints

1. **Manifest V3**: No background page - service worker only
2. **No native file access**: Export via `chrome.downloads` to Downloads directory only
3. **Memory limits**: `MAX_RECORDS = 1500`, `MAX_BODY_LENGTH = 200000` (truncated with marker)
4. **Rule limit**: `MAX_URL_RULES = 20`
5. **Content script isolation**: Page script injected via `document.createElement('script')` to access page-level fetch/XHR

### Migration Notes

- Legacy `url_filter_regex` (single string) auto-migrates to `url_filter_rules` array on load
- Extension uses `crypto.randomUUID()` with fallback to timestamp-based IDs

## Testing Strategy

Playwright tests use `chromium.launchPersistentContext()` with `--load-extension` to load the unpacked extension. Tests verify:
- Extension loading and badge state
- Multi-rule add/delete/enable/disable
- OR logic filtering (any rule match triggers capture)
- JSON export structure and file download

## Common Modifications

**Add new capture field**: Add to `createBaseRecord()`, handle in `handleWebRequest*` functions, persist via `persistData()`

**Change filter logic**: Modify `shouldCaptureUrl()` - currently OR logic, could change to AND or add rule types

**Modify export format**: Change `exportCaptureData()` payload structure, update E2E test expectations
