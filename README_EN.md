# Network Capture Assistant (Chrome Extension)

English | [中文](./README.md)

A powerful Chrome extension built on Manifest V3 designed to capture browser network requests based on custom rules and save them as JSON files in real-time.

## Features

- **Regex-based Filtering**: Support for multiple URL regex rules with include/exclude combinations and HTTP method filtering
- **Waterfall Visualization**: Real-time request timeline with search and filtering capabilities
- **Context Menu**: Quick copy as cURL/fetch()/URL formats
- **Side Panel**: Independent panel display, unaffected by download overlays (Chrome 114+)
- **Data Packaging**: One-click package today's data or select custom folders to ZIP
- **Real-time Auto-export**: Matched requests are automatically saved to your downloads folder as individual JSON files
- **Comprehensive Data Capture**: Capture request headers, request bodies, response headers, response bodies, and performance metrics
- **Hotkeys**: Quickly toggle capture on/off using keyboard shortcuts
- **Live Statistics**: Real-time status display and request statistics in the popup menu
- **Data Customization**: Choose whether to capture request bodies, response bodies, or performance data to optimize performance

## Installation

Since this extension is in development mode, you need to install it manually:

1. Clone or download this repository to your local machine.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **"Developer mode"** in the top right corner.
4. Click **"Load unpacked"** in the top left corner.
5. Select the project folder (the one containing `manifest.json`).
6. (Optional) Pin the extension to your toolbar for easy access.

## Quick Start

### 1. Open Side Panel (Recommended)
- Right-click the extension icon → Select "Open in Side Panel"
- Or click the extension icon → Click "Open Side Panel" button
- Requires Chrome 114+ for Side Panel support

### 2. Configure Filtering Rules
- Go to **Settings** page
- Add Include Rules (what to capture) and Exclude Rules (what to ignore)
- Supports regex patterns and HTTP method filtering

### 3. Start Capturing
- Click "Enable Capture" in Side Panel or Popup
- Or use the default shortcut:
  - **Windows/Linux**: `Ctrl + Shift + K`
  - **macOS**: `Command + Shift + K`

### 4. View and Manage
- **Waterfall Tab**: Visualize request timeline in real-time with search/filter
- **Context Menu**: Right-click any request to copy as cURL/fetch()/URL
- **Statistics**: Hover to see detailed capture statistics

### 5. Export Data

**Real-time Export**: Matched requests are automatically saved with filenames:
- `YYYYMMDD_HHMMSS_method_domain_status_id.json`

**Batch Packaging**:
- **Package Today's Data**: One-click ZIP all captured data from today
- **Custom Folder Package**: Select any folder in Settings to package as ZIP

### Context Menu Features

Right-click any request in the waterfall or list:
- **Copy as cURL**: Generate complete cURL command (with headers)
- **Copy as fetch()**: Generate JavaScript fetch code
- **Copy URL**: Copy only the request URL

## Exported File Format

Matching requests generate JSON files with the following naming convention:
`YYYYMMDD_HHMMSS_method_domain_status_id.json`

The JSON content includes:
- `request`: URL, method, headers, and body.
- `response`: Status code, headers, and body.
- `performance`: Start time, end time, and total duration (ms).
- `match`: Information about the rule that triggered the capture.

## Keyboard Shortcuts

To customize the toggle shortcut, go to:
- `chrome://extensions/shortcuts`
- Look for **"Network Capture Assistant"** and modify the `capture-toggle` command.

## Technical Details

### Core Architecture

- **chrome.webRequest**: Captures request metadata (URL, method, headers, status, timing) with extraHeaders support for Cookie/Authorization
- **Content Script + Page Injection (Main World)**: Hooks into `fetch` and `XMLHttpRequest` to reliably read request/response bodies using `chrome.scripting.executeScript`
- **chrome.storage.local**: Persists user settings and recent capture summaries
- **chrome.downloads**: Handles real-time file writing process
- **Side Panel API**: Provides independent panel interface (Chrome 114+), resolves download overlay issues

### Memory Management

- **Waterfall Optimization**: Only stores metadata (no full response bodies), controlled by `waterfall_max_records` setting (default 50, range 10-500)
- **Body Truncation**: Default limit 200KB, customizable via `max_body_length` setting
- **Auto Cleanup**: Automatically removes oldest records when limit is exceeded

## Limitations & Notes

- **Real-time Saving**: Capturing many requests can result in a large number of small files. Use filtering rules wisely and organize them into subfolders using the "Save Path" setting
- Chrome extensions cannot write to arbitrary local paths; `save_path` is relative to the Downloads directory
- Some cross-origin, binary, or streaming responses may not have their bodies fully captured
- To prevent high memory usage, large bodies are truncated (default limit: 200KB, configurable in settings)
- **Side Panel Requirement**: Requires Chrome 114+; older versions can only use Popup mode
- **Waterfall Performance**: For high request volumes, consider setting a lower `waterfall_max_records` value to optimize performance

## Version History

### v1.1.0 (2026-02-22)
- ✨ Add Waterfall Visualization Tab with search and filtering
- ✨ Add Context Menu for copying as cURL/fetch()/URL
- ✨ Add Side Panel mode (resolves download overlay issue)
- ✨ Add data packaging feature (today's data + custom folder packaging)
- ✨ Add `waterfall_max_records` configuration (default 50, range 10-500)
- 🔧 Enhanced webRequest listener with extraHeaders support
- 🐱‍💻 Refactored sidepanel.js for better maintainability

### v1.0.0
- 🎉 Initial release
- Multi-rule URL filtering (include/exclude)
- Real-time auto-export as JSON
- Keyboard shortcut toggle
- Popup real-time status display

## License

MIT
