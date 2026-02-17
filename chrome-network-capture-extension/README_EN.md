# Network Capture Assistant (Chrome Extension)

English | [中文](./README.md)

A Manifest V3-based network request capture extension that supports:

- **Multi-rule URL regex filtering**: Multiple rules with HTTP method filtering (OR logic)
- **Keyboard shortcut toggle**: Use `Ctrl+Shift+K` (Mac: `Cmd+Shift+K`) to quickly toggle capture
- **Flexible data capture options**: Optionally capture request body/response body/performance data
- **Real-time automatic export**: Matched requests are instantly saved as JSON files to the Downloads folder
- **Date-based archiving**: Automatically creates folders by date (`YYYY-MM-DD/` format)
- **Real-time statistics**: Displays capture status and request data in popup
- **Rule statistics on hover**: Hover over the statistics card to see per-rule capture details
- **One-click actions**: Open today's folder, generate ZIP archive

## Directory Structure

```text
chrome-network-capture-extension/
├── manifest.json
├── background.js       # Service Worker - Core logic
├── content/
│   ├── content.js      # Content Script - Page script injection
│   └── page-script.js  # Injected page script - Hook fetch/XHR
├── popup/
│   ├── popup.html      # Popup UI
│   ├── popup.js        # Popup logic
│   └── popup.css       # Popup styles
├── options/
│   ├── options.html    # Settings page
│   ├── options.js      # Settings logic
│   └── options.css     # Settings styles
├── lib/
│   └── jszip.min.js    # JSZip library - For ZIP generation
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Core Features

### 1. Multi-rule URL Filtering

Add multiple regex expression rules, each can:
- Set independent regex pattern
- Select HTTP methods to match (GET/POST/PUT/DELETE/PATCH, etc.)
- Toggle on/off independently

**Filtering logic**: Any enabled rule match triggers capture (OR logic)

### 2. Real-time File Export

Matched requests are saved as individual JSON files in real-time:
- **File naming**: `YYYYMMDD_HHMMSS_method_rule_summary_status_id.json`
- **Directory structure**: Auto-archived to `YYYY-MM-DD/` folder by date
- **Complete data**: Includes request headers, response headers, request body, response body (based on settings)

### 3. Memory Optimization

Version 1.0.0 implements deep memory optimization:
- Memory usage reduced by **98.75%** (from ~600MB to ~7.5MB)
- Strategy: Keep only metadata in memory, complete data saved to disk
- See [MEMORY_OPTIMIZATION.md](./MEMORY_OPTIMIZATION.md) for details

### 4. UI Interaction Enhancements

- **Rule statistics hover**: Hover over the "Real-time Statistics" card to see per-rule capture details
- **Gear icon settings**: Quick access to settings via gear button in header
- **Responsive layout**: Adaptive grid layout based on window size

### 5. One-click Features

- **Open folder**: Directly open today's data save location
- **Generate ZIP**: Package all today's captured data into a ZIP file

## Default Settings

```json
{
  "capture_enabled": false,
  "url_filter_rules": [],
  "save_path": "",
  "capture_request_data": true,
  "capture_response_data": true,
  "capture_performance_data": false,
  "max_body_length": 20000000
}
```

## Installation

### Developer Mode Load

1. Open Chrome, go to `chrome://extensions/`
2. Enable "Developer mode" in the top right
3. Click "Load unpacked"
4. Select the `chrome-network-capture-extension` folder

### Install from Chrome Web Store

Coming soon...

## Usage Guide

### 1. Basic Workflow

1. **Configure Rules**
   - Click the extension icon to open popup
   - Click the gear icon in the top right to enter settings
   - Add URL filter rules (supports regex)
   - Optional: Specify HTTP methods to match
   - Save settings

2. **Start Capture**
   - Click "Start Capture" button in popup
   - Or use keyboard shortcut `Ctrl+Shift+K` (Mac: `Cmd+Shift+K`)

3. **Visit Target Websites**
   - Browse normally, the extension will automatically capture matched requests
   - Each matched request is saved as a JSON file in real-time

4. **View Data**
   - Click "Open Folder" button to open today's data directory
   - Or go to `chrome://downloads/` to see download list

### 2. Rule Examples

**Capture all API requests**:
```javascript
Rule: .*/api/.*
Methods: Leave empty (matches all methods)
```

**Capture specific domain**:
```javascript
Rule: https://api\.example\.com/.*
Methods: Leave empty (matches all methods)
```

**Only capture POST requests**:
```javascript
Rule: .*/api/.*
Methods: ["POST"]
```

**Capture multiple paths**:
```javascript
Rule1: .*/api/users/.*
Rule2: .*/api/orders/.*
Methods: Leave empty (OR logic matches any rule)
```

### 3. Customize Keyboard Shortcuts

Chrome extension global shortcuts are managed by Chrome. Go to:

- `chrome://extensions/shortcuts`

To modify this extension's command:
- `capture-toggle` (default `Ctrl+Shift+K` / Mac: `Cmd+Shift+K`)

### 4. Data Format

Each captured record contains the following fields:

```json
{
  "saved_at": "2026-02-17T11:30:22.123Z",
  "mode": "realtime-single-record",
  "record": {
    "id": "1234567890_abc123",
    "created_at": "2026-02-17T11:30:22.123Z",
    "source": "webRequest",
    "request": {
      "request_id": "12345",
      "tab_id": 123,
      "url": "https://api.example.com/data",
      "method": "POST",
      "type": "xmlhttprequest",
      "initiator": "https://example.com",
      "request_headers": {...},
      "has_body": true,
      "body_size": 204800
    },
    "response": {
      "status_code": 200,
      "status_line": "HTTP/1.1 200 OK",
      "response_headers": {...},
      "has_body": true,
      "body_size": 199500
    },
    "performance": {
      "start_time": 1234567890123.456,
      "end_time": 1234567892345.678,
      "duration_ms": 1222.222,
      "from_cache": false
    }
  }
}
```

## Technical Architecture

### Architecture Design

The extension uses a **dual-source capture mechanism**:

1. **webRequest API** (background.js)
   - Captures request metadata (URL, method, headers, status code, timing, etc.)
   - Monitors all network requests with minimal performance overhead

2. **Content Script Injection** (content/content.js)
   - Injects page script into Main World
   - Hooks `fetch` and `XMLHttpRequest` to read request/response bodies
   - Uses `window.postMessage` to bridge isolated worlds

3. **Data Merging**
   - Uses `requestIndexById` and `mergeCandidatesByKey` mappings
   - Merges data from both sources into complete records

### Key Technologies

- **Manifest V3**: Uses Service Worker instead of Background Page
- **chrome.scripting.executeScript**: Dynamic script injection for improved reliability
- **chrome.storage.local**: Persists user settings and recent capture summaries
- **chrome.downloads**: Real-time automatic JSON file saving
- **JSZip**: ZIP archive generation (optional feature)

## Important Notes

### 1. File Count

Due to real-time auto-save, many files may be generated in a short time:
- Recommend using "Save Path" setting to categorize into subfolders
- Configure filter rules appropriately to avoid capturing too many irrelevant requests
- Use "Generate ZIP" feature to organize data

### 2. Chrome Limitations

- **Cannot write to arbitrary local paths**: `save_path` is actually a subpath under Downloads
- **Some cross-domain/binary responses**: May not be able to read complete body
- **Memory limits**: Truncates oversized bodies (default 20MB, configurable in settings)
- **Local record limit**: Only keeps recent 1500 metadata records in memory

### 3. Performance Impact

- **Memory usage**: ~7.5MB after optimization (1500 records)
- **CPU usage**: webRequest monitoring overhead is minimal
- **Disk space**: Each JSON file ~5KB - 400KB (depends on body size)

## FAQ

### Q: Why are some requests not being captured?

A: Check the following:
1. Confirm capture toggle is on
2. Check if filter rules are correct (using regex)
3. Verify HTTP methods match
4. Check browser console for errors

### Q: How to capture only specific domain requests?

A: Add a rule in settings, for example:
```javascript
Rule: https://api\.github\.com/.*
```

### Q: Why is the response body empty?

A: Possible reasons:
1. Target server didn't return body (e.g., 204 No Content)
2. CORS restrictions prevent reading
3. Response body truncated (exceeds max_body_length setting)

### Q: How to export all data?

A: Click the "Generate ZIP" button in popup to package all today's data into a ZIP file.

## Changelog

### v1.0.0 (2026-02-17)

**New features**:
- Auto-archiving by date (`YYYY-MM-DD/` folder)
- Rule statistics hover display
- Gear icon settings button
- One-click open today's folder
- One-click generate ZIP archive
- Real-time status display optimization

**Optimizations**:
- Memory usage reduced by 98.75% (~600MB → ~7.5MB)
- Only metadata in memory, complete data saved to disk
- UI response speed improved

**Fixes**:
- ESLint code compliance issues
- Dynamic script injection logic

## Development & Testing

### E2E Tests

```bash
cd tests/
npm install
npm run install:browsers
npm test
```

### Single Test

```bash
npx playwright test -g "test name"
```

## License

MIT License

## Contributing

Issues and Pull Requests are welcome!
