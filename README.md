# Network Capture Assistant（Chrome 扩展）

一个基于 Manifest V3 的网络请求捕获扩展，支持：

- URL 正则过滤（支持多条规则及其 HTTP 方法过滤）
- 快捷键触发开关
- 可选捕获请求体/响应体/性能数据
- **实时自动导出**：匹配的请求会实时作为单条 JSON 文件保存到下载目录
- 实时状态和统计展示

## 目录结构

```text
chrome-network-capture-extension/
├── manifest.json
├── background.js
├── content/
│   ├── content.js
│   └── page-script.js
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── options/
│   ├── options.html
│   ├── options.js
│   └── options.css
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 默认设置

```json
{
  "capture_enabled": false,
  "url_filter_rules": [],
  "save_path": "",
  "capture_request_data": true,
  "capture_response_data": true,
  "capture_performance_data": false
}
```

## 安装方式

1. 打开 Chrome，进入 `chrome://extensions/`
2. 开启右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择 `chrome-network-capture-extension` 文件夹

## 使用说明

1. 点击扩展图标打开 popup。
2. 在“设置”页配置：
- URL 正则过滤规则（可指定匹配的 HTTP 方法）
- 保存路径（下载目录下相对路径）
- 要采集的数据类型
3. 在 popup 点击“开启捕获”，或使用快捷键 `Ctrl+Shift+K`。
4. 访问目标网站产生请求。
5. **实时导出**：匹配的请求在完成后（若开启捕获响应体，则在获取到响应体后）会自动保存，文件名格式：
- `YYYYMMDD_HHMMSS_method_url_rule_status_id.json`

## 快捷键自定义

Chrome 扩展全局快捷键由 Chrome 统一管理。请在：

- `chrome://extensions/shortcuts`

页面中修改本扩展命令：

- `capture-toggle`（默认 `Ctrl+Shift+K`）

## 技术方案说明

- `chrome.webRequest`：捕获请求元数据（URL、方法、头、状态码、时序等）。
- `content script + 页面注入 (Main World)`：Hook `fetch/XMLHttpRequest` 以读取 body（采用 `chrome.scripting.executeScript` 提高可靠性）。
- `chrome.storage.local`：持久化用户设置与最近捕获摘要。
- `chrome.downloads`：将捕获结果**实时**自动保存为 JSON。

## 注意事项

- **实时保存**：由于采用实时自动保存方案，可能会在短时间内产生大量小文件，建议通过“保存路径”将其分类到子文件夹，并合理配置过滤规则。
- Chrome 扩展无法直接写任意本地绝对路径；`save_path` 实际是下载目录下子路径。
- 某些跨域、二进制、流式响应可能无法完整读取 body。
- 为防止内存占用过高，扩展会截断超长 body，并在本地仅保留最近一部分记录摘要。
