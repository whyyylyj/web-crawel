# Network Capture Assistant（Chrome 扩展）

[English](./README_EN.md) | 中文

一个基于 Manifest V3 的网络请求捕获扩展，支持：

- **多规则 URL 正则过滤**：支持多条规则及其 HTTP 方法过滤（OR 逻辑）
- **快捷键触发**：使用 `Ctrl+Shift+K`（Mac: `Cmd+Shift+K`）快速开关捕获
- **灵活的数据捕获选项**：可选捕获请求体/响应体/性能数据
- **实时自动导出**：匹配的请求会实时保存为 JSON 文件到下载目录
- **按日期归档**：自动按日期创建文件夹（`YYYY-MM-DD/`格式）
- **实时状态统计**：在 popup 实时显示捕获状态和请求数据
- **规则统计 Hover 显示**：鼠标悬停在统计卡片上查看各规则捕获详情
- **一键操作**：打开今日文件夹、生成压缩包

## 目录结构

```text
chrome-network-capture-extension/
├── manifest.json
├── background.js       # Service Worker - 核心逻辑
├── content/
│   ├── content.js      # Content Script - 页面脚本注入
│   └── page-script.js  # 注入页面的脚本 - Hook fetch/XHR
├── popup/
│   ├── popup.html      # Popup UI
│   ├── popup.js        # Popup 逻辑
│   └── popup.css       # Popup 样式
├── options/
│   ├── options.html    # 设置页面
│   ├── options.js      # 设置逻辑
│   └── options.css     # 设置样式
├── lib/
│   └── jszip.min.js    # JSZip 库 - 用于压缩包生成
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 核心特性

### 1. 多规则 URL 过滤

支持添加多条正则表达式规则，每条规则可以：
- 设置独立的正则表达式模式
- 选择要匹配的 HTTP 方法（GET/POST/PUT/DELETE/PATCH 等）
- 独立开启/关闭

**过滤逻辑**：只要满足任一启用的规则，就会捕获该请求（OR 逻辑）

### 2. 实时文件导出

匹配的请求会在完成后实时保存为单个 JSON 文件：
- **文件命名**：`YYYYMMDD_HHMMSS_method_rule_summary_status_id.json`
- **目录结构**：按日期自动归档到 `YYYY-MM-DD/` 文件夹
- **完整数据**：包含请求头、响应头、请求体、响应体（根据设置）

### 3. 内存优化

v1.0.0 版本实现了深度内存优化：
- 内存占用降低 **98.75%**（从 ~600MB 降至 ~7.5MB）
- 策略：内存中只保留元数据，完整数据保存在磁盘文件中
- 详见 [MEMORY_OPTIMIZATION.md](./MEMORY_OPTIMIZATION.md)

### 4. UI 交互优化

- **规则统计 Hover**：鼠标悬停在"实时统计"卡片上即可查看各规则的捕获详情
- **齿轮图标设置**：右上角齿轮按钮快速打开设置页面
- **响应式布局**：自适应窗口大小的网格布局

### 5. 一键功能

- **打开文件夹**：直接打开今日数据的保存位置
- **生成压缩包**：将今日捕获的所有数据打包为 ZIP 文件

## 默认设置

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

## 安装方式

### 开发模式加载

1. 打开 Chrome，进入 `chrome://extensions/`
2. 开启右上角"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `chrome-network-capture-extension` 文件夹

### 从 Chrome Web Store 安装

即将上线...

## 使用说明

### 1. 基本使用流程

1. **配置规则**
   - 点击扩展图标打开 popup
   - 点击右上角齿轮图标进入设置
   - 添加 URL 过滤规则（支持正则表达式）
   - 可选：指定要匹配的 HTTP 方法
   - 保存设置

2. **开启捕获**
   - 在 popup 点击"开启捕获"按钮
   - 或使用快捷键 `Ctrl+Shift+K`（Mac: `Cmd+Shift+K`）

3. **访问目标网站**
   - 正常浏览网页，扩展会自动捕获匹配规则的请求
   - 每个匹配的请求会实时保存为 JSON 文件

4. **查看数据**
   - 点击"打开文件夹"按钮直接打开今日数据目录
   - 或进入 `chrome://downloads/` 查看下载列表

### 2. 规则示例

**捕获所有 API 请求**：
```javascript
规则: .*/api/.*
方法: 留空（匹配所有方法）
```

**捕获特定域名**：
```javascript
规则: https://api\.example\.com/.*
方法: 留空（匹配所有方法）
```

**只捕获 POST 请求**：
```javascript
规则: .*/api/.*
方法: ["POST"]
```

**捕获多个路径**：
```javascript
规则1: .*/api/users/.*
规则2: .*/api/orders/.*
方法: 留空（OR 逻辑匹配任一规则）
```

### 3. 快捷键自定义

Chrome 扩展全局快捷键由 Chrome 统一管理。请在：

- `chrome://extensions/shortcuts`

页面中修改本扩展命令：
- `capture-toggle`（默认 `Ctrl+Shift+K` / Mac: `Cmd+Shift+K`）

### 4. 数据格式说明

每条捕获记录包含以下字段：

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

## 技术方案说明

### 架构设计

扩展使用 **双源捕获机制**：

1. **webRequest API**（background.js）
   - 捕获请求元数据（URL、方法、头、状态码、时序等）
   - 监听所有网络请求，性能开销小

2. **Content Script Injection**（content/content.js）
   - 注入页面脚本到 Main World
   - Hook `fetch` 和 `XMLHttpRequest` 读取请求/响应体
   - 使用 `window.postMessage` 跨越隔离边界

3. **数据合并**
   - 使用 `requestIndexById` 和 `mergeCandidatesByKey` 映射
   - 将两个源的数据合并为完整记录

### 关键技术点

- **Manifest V3**：使用 Service Worker 替代 Background Page
- **chrome.scripting.executeScript**：动态注入脚本提高可靠性
- **chrome.storage.local**：持久化用户设置与最近捕获摘要
- **chrome.downloads**：实时自动保存 JSON 文件
- **JSZip**：生成压缩包（可选功能）

## 注意事项

### 1. 文件数量

由于采用实时自动保存方案，可能会在短时间内产生大量文件：
- 建议通过"保存路径"设置将其分类到子文件夹
- 合理配置过滤规则，避免捕获过多无关请求
- 使用"生成压缩包"功能整理数据

### 2. Chrome 限制

- **无法直接写任意本地路径**：`save_path` 实际是下载目录下子路径
- **某些跨域/二进制响应**：可能无法完整读取 body
- **内存限制**：会截断超长 body（默认 20MB，可在设置中修改）
- **本地记录限制**：内存中仅保留最近 1500 条元数据

### 3. 性能影响

- **内存占用**：优化后约 7.5MB（1500 条记录）
- **CPU 占用**：webRequest 监听开销很小
- **磁盘空间**：每个 JSON 文件约 5KB - 400KB（取决于 body 大小）

## 常见问题

### Q: 为什么捕获不到某些请求？

A: 检查以下几点：
1. 确认捕获开关已打开
2. 检查过滤规则是否正确（使用正则表达式）
3. 确认 HTTP 方法是否匹配
4. 查看浏览器控制台是否有错误

### Q: 如何只捕获特定域名的请求？

A: 在设置中添加规则，例如：
```javascript
规则: https://api\.github\.com/.*
```

### Q: 响应体为什么是空的？

A: 可能的原因：
1. 目标服务器未返回 body（如 204 No Content）
2. 跨域限制导致无法读取
3. 响应体被截断（超过 max_body_length 设置）

### Q: 如何导出所有数据？

A: 点击 popup 中的"生成压缩包"按钮，会将今日所有数据打包为 ZIP 文件。

## 更新日志

### v1.0.0 (2026-02-17)

**新功能**：
- 按日期自动归档（`YYYY-MM-DD/` 文件夹）
- Hover 显示规则统计详情
- 齿轮图标设置按钮
- 一键打开今日文件夹
- 一键生成 ZIP 压缩包
- 实时状态显示优化

**优化**：
- 内存占用降低 98.75%（~600MB → ~7.5MB）
- 内存中只保留元数据，完整数据保存到磁盘
- UI 响应速度提升

**修复**：
- 修复 ESLint 代码规范问题
- 修复动态脚本注入逻辑

## 开发与测试

### E2E 测试

```bash
cd tests/
npm install
npm run install:browsers
npm test
```

### 单个测试

```bash
npx playwright test -g "test name"
```

## 开源协议

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request！
