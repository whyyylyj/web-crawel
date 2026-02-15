# Network Capture Assistant (Chrome Extension)

English | [中文](./README.md)

A powerful Chrome extension built on Manifest V3 designed to capture browser network requests based on custom rules and save them as JSON files in real-time.

## Features

- **Regex-based Filtering**: Support for multiple URL regex rules with specific HTTP method filtering.
- **Real-time Auto-export**: Matched requests are automatically saved to your downloads folder as individual JSON files.
- **Comprehensive Data Capture**: Capture request headers, request bodies, response headers, response bodies, and performance metrics.
- **Hotkeys**: Quickly toggle capture on/off using keyboard shortcuts.
- **Live Statistics**: Real-time status display and request statistics in the popup menu.
- **Data Customization**: Choose whether to capture request bodies, response bodies, or performance data to optimize performance.

## Installation

Since this extension is in development mode, you need to install it manually:

1. Clone or download this repository to your local machine.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **"Developer mode"** in the top right corner.
4. Click **"Load unpacked"** in the top left corner.
5. Select the project folder (the one containing `manifest.json`).
6. (Optional) Pin the extension to your toolbar for easy access.

## Quick Start

### 1. Enable Capture
- Click the extension icon to open the popup and toggle the **"Capture Status"** switch.
- Or use the default shortcut:
  - **Windows/Linux**: `Ctrl + Shift + K`
  - **macOS**: `Command + Shift + K`

### 2. Configure Save Path
- Open the **Options** page (click "Settings" in the popup or right-click the extension icon and select "Options").
- Set a **Save Path** (e.g., `my_captures`). 
  - *Note: Files are saved relative to your Chrome "Downloads" directory due to browser security restrictions.*

### 3. Set Up Filtering Rules
- In the Options page, add a new rule:
  - **Regex Pattern**: The regex to match URLs (e.g., `api\.example\.com/.*`).
  - **HTTP Method**: Specific methods to capture (leave empty to match all).
  - **Enable/Disable**: Toggle individual rules as needed.
- Click **"Save Settings"** to apply.

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

- **Manifest V3**: Complies with the latest Chrome extension standards.
- **`chrome.webRequest`**: Used for capturing request metadata (headers, timing, status).
- **Injected Content Script (Main World)**: Hooks into `fetch` and `XMLHttpRequest` to reliably read request/response bodies.
- **`chrome.downloads`**: Handles the real-time file writing process.
- **`chrome.storage.local`**: Persists user settings and capture summaries.

## Limitations & Notes

- **Real-time Saving**: Capturing many requests can result in a large number of small files. Use filtering rules wisely and organize them into subfolders using the "Save Path" setting.
- **Body Truncation**: To prevent high memory usage, large bodies are truncated (default limit: 20MB, configurable in settings).
- **Streaming/CORS**: Some cross-origin requests or streaming responses (like video/websockets) may not have their bodies fully captured.

## License

MIT
