# Network Capture Assistant（Chrome 扩展）

[English](./README_EN.md) | 中文

一个基于 Manifest V3 的网络请求捕获扩展，支持：

- **URL 正则过滤**：支持多条规则及其 HTTP 方法过滤，支持包含/排除规则组合
- **瀑布图可视化**：实时展示请求时间线，支持搜索和筛选
- **右键菜单**：快速复制请求为 cURL/fetch()/URL 格式
- **Side Panel 侧边栏**：独立面板展示，不受下载遮挡（Chrome 114+）
- **数据打包**：支持今日数据一键打包，或自定义选择文件夹打包为 ZIP
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
├── sidepanel/           # 新增：Side Panel 侧边栏
│   ├── sidepanel.html
│   ├── sidepanel.js
│   └── sidepanel.css
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
  "exclude_filter_rules": [],
  "save_path": "",
  "capture_request_data": true,
  "capture_response_data": true,
  "capture_performance_data": false,
  "max_body_length": 200000,
  "waterfall_max_records": 50
}
```

## 安装方式

1. 打开 Chrome，进入 `chrome://extensions/`
2. 开启右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择 `chrome-network-capture-extension` 文件夹

## 使用说明

### 基本流程

1. **开启 Side Panel 侧边栏**（推荐）
   - 右键点击扩展图标 → 选择「在侧边栏中打开」
   - 或点击扩展图标后点击「打开侧边栏」按钮

2. **配置过滤规则**
   - 进入「设置」页
   - 添加过滤规则（包含）和排除规则
   - 支持正则表达式和 HTTP 方法筛选

3. **开始捕获**
   - 在 Side Panel 或 Popup 中点击「开启捕获」
   - 或使用快捷键 `Ctrl+Shift+K`（Mac: `Command+Shift+K`）

4. **查看和管理**
   - **瀑布图 Tab**：实时可视化请求时间线，支持搜索筛选
   - **右键菜单**：点击任一请求可复制为 cURL/fetch()/URL
   - **统计数据**：悬浮查看详细统计信息

### 数据导出

**实时导出**：匹配的请求自动保存，文件名格式：
- `YYYYMMDD_HHMMSS_method_url_rule_status_id.json`

**批量打包**：
- **今日数据打包**：一键打包当天捕获的所有数据为 ZIP
- **自定义文件夹打包**：在设置页选择任意文件夹进行打包

### 右键菜单功能

在瀑布图或列表中右键点击任一请求：
- **复制为 cURL**：生成完整的 cURL 命令（含 headers）
- **复制为 fetch()**：生成 JavaScript fetch 代码
- **复制 URL**：仅复制请求地址

## 快捷键自定义

Chrome 扩展全局快捷键由 Chrome 统一管理。请在：

- `chrome://extensions/shortcuts`

页面中修改本扩展命令：

- `capture-toggle`（默认 `Ctrl+Shift+K`）

## 技术方案说明

### 核心架构

- **chrome.webRequest**：捕获请求元数据（URL、方法、头、状态码、时序等），支持 extraHeaders 获取 Cookie/Authorization 等敏感头
- **content script + 页面注入 (Main World)**：Hook `fetch/XMLHttpRequest` 以读取 body（采用 `chrome.scripting.executeScript` 提高可靠性）
- **chrome.storage.local**：持久化用户设置与最近捕获摘要
- **chrome.downloads**：将捕获结果**实时**自动保存为 JSON
- **Side Panel API**：提供独立侧边栏界面（Chrome 114+），解决下载遮挡问题

### 内存管理

- **瀑布图优化**：仅存储元数据（不含完整 body），由 `waterfall_max_records` 控制记录数（默认 50，范围 10-500）
- **Body 截断**：默认限制 200KB，可在设置中自定义 `max_body_length`
- **自动清理**：超出记录上限时自动删除最旧记录

## 注意事项

- **实时保存**：由于采用实时自动保存方案，可能会在短时间内产生大量小文件，建议通过”保存路径”将其分类到子文件夹，并合理配置过滤规则
- Chrome 扩展无法直接写任意本地绝对路径；`save_path` 实际是下载目录下子路径
- 某些跨域、二进制、流式响应可能无法完整读取 body
- 为防止内存占用过高，扩展会截断超长 body（可在设置中自定义限制，默认 200KB），并在本地仅保留最近一部分记录摘要
- **Side Panel 要求**：需要 Chrome 114+ 版本，旧版本仅可使用 Popup 模式
- **瀑布图性能**：大量请求时建议设置较低的 `waterfall_max_records` 值以优化性能

## 版本历史

### v1.1.0 (2026-02-22)
- ✨ 新增瀑布图可视化 Tab，支持搜索和筛选
- ✨ 新增右键菜单，支持复制为 cURL/fetch()/URL
- ✨ 新增 Side Panel 侧边栏模式（解决下载遮挡问题）
- ✨ 新增数据打包功能（今日数据打包 + 自定义文件夹打包）
- ✨ 新增 `waterfall_max_records` 配置项（默认 50，范围 10-500）
- 🔧 增强 webRequest 监听器，支持捕获 extraHeaders
- 🐱‍💻 重构 sidepanel.js 代码结构，提升可维护性

### v1.0.0
- 🎉 初始版本发布
- 支持多规则 URL 过滤（包含/排除）
- 实时自动导出为 JSON
- 快捷键切换捕获开关
- Popup 实时状态展示
