# Network Capture Assistant 使用指南

> 一个强大的 Chrome 网络请求捕获扩展，支持实时保存和智能过滤

## 📦 简介

Network Capture Assistant 是一个基于 Manifest V3 的 Chrome 扩展，可以帮助开发者：

- 🔍 **实时捕获网络请求**：自动捕获匹配规则的 HTTP/HTTPS 请求
- 💾 **自动保存为 JSON**：每个请求实时保存为独立的 JSON 文件
- 🎯 **智能过滤**：支持多条正则表达式规则 + HTTP 方法过滤
- 📊 **统计分析**：实时查看捕获状态和规则统计
- 📁 **按日期归档**：自动按日期组织文件（`YYYY-MM-DD/` 格式）
- ⚡ **内存优化**：内存占用降低 98.75%，不影响浏览器性能

## 🚀 快速开始

### 安装扩展

1. 下载扩展源码
2. 打开 Chrome，进入 `chrome://extensions/`
3. 开启"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择 `chrome-network-capture-extension` 文件夹

### 基本使用

1. **配置过滤规则**
   - 点击扩展图标打开 popup
   - 点击右上角齿轮图标进入设置
   - 添加 URL 过滤规则（支持正则表达式）

2. **开启捕获**
   - 在 popup 点击"开启捕获"
   - 或使用快捷键 `Ctrl+Shift+K`（Mac: `Cmd+Shift+K`）

3. **查看数据**
   - 点击"打开文件夹"直接打开今日数据目录
   - 或点击"生成压缩包"打包所有数据

## 🎯 核心功能

### 1. 多规则过滤

支持添加多条规则，每条规则可以：
- ✅ 设置独立的正则表达式
- ✅ 选择要匹配的 HTTP 方法（GET/POST/PUT/DELETE 等）
- ✅ 独立开启/关闭

**过滤逻辑**：满足任一启用规则即捕获（OR 逻辑）

**规则示例**：

```
# 捕获所有 API 请求
.*/api/.*

# 捕获特定域名
https://api\.github\.com/.*

# 只捕获 POST 请求
.*/api/.* + 方法: POST

# 多个路径
规则1: .*/api/users/.*
规则2: .*/api/orders/.*
```

### 2. 实时文件导出

每个匹配的请求会立即保存为 JSON 文件：

```
文件命名: 20260217_143022_POST_api_users_summary_200_abc123.json
目录结构: 2026-02-17/
  ├── 20260217_143022_...
  ├── 20260217_143145_...
  └── ...
```

**数据格式**：

```json
{
  "saved_at": "2026-02-17T14:30:22.123Z",
  "record": {
    "request": {
      "url": "https://api.example.com/users",
      "method": "POST",
      "headers": {...},
      "body": {...}
    },
    "response": {
      "status_code": 200,
      "headers": {...},
      "body": {...}
    },
    "performance": {
      "duration_ms": 1234
    }
  }
}
```

### 3. 统计分析

**实时统计**（popup 主界面）：
- 总请求数
- 匹配请求数
- 已记录数
- 错误数

**规则统计**（hover 查看详情）：
- 每条规则的捕获量
- 捕获率百分比
- 流量等级标识（🟢高 🟡中 ⚪低）

### 4. 一键功能

- **打开文件夹**：直接打开今日数据的保存位置
- **生成压缩包**：将今日所有数据打包为 ZIP 文件

## 🛠️ 配置说明

### 设置项说明

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| capture_enabled | 捕获开关 | false |
| url_filter_rules | URL 过滤规则数组 | [] |
| save_path | 保存路径（下载目录下相对路径） | "" |
| capture_request_data | 是否捕获请求体 | true |
| capture_response_data | 是否捕获响应体 | true |
| capture_performance_data | 是否捕获性能数据 | false |
| max_body_length | 最大 body 长度（字节） | 20000000 (20MB) |

### 快捷键配置

默认快捷键：`Ctrl+Shift+K`（Mac: `Cmd+Shift+K`）

自定义快捷键：
1. 打开 `chrome://extensions/shortcuts`
2. 找到 "Network Capture Assistant"
3. 修改 `capture-toggle` 快捷键

## 📊 性能特性

### 内存优化（v1.0.0）

| 指标 | 优化前 | 优化后 | 改善 |
|------|--------|--------|------|
| 单条记录 | ~400KB | ~5KB | ↓ 98.75% |
| 1500 条总计 | ~600MB | ~7.5MB | ↓ 98.75% |

**优化策略**：
- 内存中只保留元数据
- 完整数据保存到磁盘文件
- 查看详情时引导用户打开文件

### 性能影响

- **内存占用**：~7.5MB（1500 条记录）
- **CPU 占用**：webRequest 监听开销很小
- **磁盘空间**：每个文件 5KB - 400KB

## 🔧 高级用法

### 场景 1：API 接口调试

```javascript
// 规则配置
规则: https://api\.yourdomain\.com/.*
方法: 留空（所有方法）

// 预期结果
// - 捕获所有 API 请求
// - 查看请求/响应数据
// - 分析性能指标
```

### 场景 2：前端性能优化

```javascript
// 规则配置
规则: .*\.(js|css|jpg|png|webp)$
方法: ["GET"]
开启性能数据: true

// 预期结果
// - 捕获所有资源请求
// - 查看加载时间
// - 识别慢速资源
```

### 场景 3：移动端 H5 调试

```javascript
// 规则配置
规则1: .*/h5/api/.*
规则2: .*/mobile/api/.*

// 预期结果
// - 捕获移动端接口
// - 在 Chrome 远程调试时查看请求
// - 导出数据分析问题
```

## ⚠️ 注意事项

### 1. 文件数量

实时保存会产生大量文件：
- ✅ 建议使用"保存路径"分类存储
- ✅ 合理配置过滤规则
- ✅ 定期使用"生成压缩包"整理

### 2. Chrome 限制

- 无法写入任意本地路径（只能保存到 Downloads 目录）
- 某些跨域请求可能无法读取 body
- 响应体超过 `max_body_length` 会被截断

### 3. 性能影响

- 内存中只保留最近 1500 条元数据
- 超出后会自动清理旧记录
- 磁盘文件不受限制

## 📚 相关资源

- **源码地址**：`chrome-network-capture-extension/`
- **详细文档**：`chrome-network-capture-extension/README.md`
- **内存优化说明**：`chrome-network-capture-extension/MEMORY_OPTIMIZATION.md`

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 开源协议

MIT License
