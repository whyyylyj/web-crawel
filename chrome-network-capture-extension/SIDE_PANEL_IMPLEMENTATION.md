# Side Panel 功能实现说明

## 🎯 功能概述

实现了 Side Panel（侧边栏）模式，解决了下载时面板被遮挡的问题。同时保持了完整的前向和后向兼容性。

## 📋 实现方案

### 核心策略：渐进增强 + 优雅降级

1. **Chrome 114+**：自动使用 Side Panel 模式（推荐）
2. **Chrome < 114**：降级到独立窗口模式
3. **始终保留 Popup**：作为备用访问方式

## 📁 新增文件

### Side Panel 相关
```
sidepanel/
├── sidepanel.html    # 侧边栏页面结构
├── sidepanel.css     # 侧边栏样式（适配侧边栏布局）
└── sidepanel.js      # 侧边栏逻辑（包含版本检测）
```

### 主要特性
- **宽度自适应**：Side Panel 宽度由浏览器控制，不需要固定 360px
- **高度填满**：使用 `min-height: 100vh` 确保填满侧边栏
- **版本显示**：显示 Chrome 版本信息
- **功能完整**：包含 popup 的所有功能

## 🔧 修改文件

### manifest.json
```json
{
  "version": "1.1.0",
  "permissions": [
    "sidePanel"  // 新增权限
  ],
  "action": {
    "default_title": "Network Capture - 点击打开侧边栏"
    // 移除 default_popup，让 Side Panel 接管
  },
  "side_panel": {
    "default_path": "sidepanel/sidepanel.html"
  }
}
```

### background.js
新增功能：
1. **Side Panel 检测**：`isSidePanelAvailable()`
2. **自动配置**：`initSidePanel()` - 设置点击图标打开侧边栏
3. **降级处理**：`chrome.action.onClicked` - 旧版打开独立窗口

### popup/popup.html
新增元素：
```html
<section class="info-banner" id="infoBanner">
  <p>💡 提示：下载时面板会被遮挡</p>
  <button id="openSidePanelBtn">打开侧边栏</button>
</section>
```

### popup/popup.js
新增功能：
1. **版本检测**：`getChromeVersion()` - 获取主版本号
2. **API 检测**：`isSidePanelAvailable()` - 检测 Side Panel 支持
3. **横幅显示**：`showSidePanelBanner()` - 显示升级提示
4. **侧边栏打开**：`openSidePanel()` - 打开侧边栏面板

### popup/popup.css
新增样式：
```css
.info-banner {
  /* 黄色提示横幅 */
  background: linear-gradient(135deg, #fff9e6 0%, #fff3d6 100%);
  border: 1px solid #ffd966;
}

.btn.small {
  /* 小尺寸按钮 */
  padding: 6px 10px;
  font-size: 11px;
}
```

## 🚀 使用方式

### Chrome 114+ (推荐)
1. **点击扩展图标** → 自动打开侧边栏
2. **侧边栏固定在浏览器右侧**，不会受到下载影响
3. **支持所有操作**：开启/停止捕获、清空数据、查看统计

### Chrome < 114 (降级)
1. **点击扩展图标** → 打开独立窗口
2. **或者右键图标** → 选择"打开弹出窗口"
3. **Popup 内提示**：显示升级到 Chrome 114+ 的建议

### 从 Popup 打开 Side Panel
即使在 Popup 中，也可以点击"打开侧边栏"按钮切换到 Side Panel 模式。

## 🧪 测试要点

### 功能测试
- [ ] Chrome 114+ 点击图标打开侧边栏
- [ ] Chrome < 114 点击图标打开独立窗口
- [ ] Side Panel 中所有按钮功能正常
- [ ] 下载时 Side Panel 不受影响
- [ ] Popup 中的"打开侧边栏"按钮可用

### 兼容性测试
- [ ] Chrome 113 (不支持 Side Panel)
- [ ] Chrome 114 (首次支持)
- [ ] Chrome 最新版本
- [ ] 不同操作系统 (Windows, macOS, Linux)

### 边缘情况
- [ ] Service Worker 休眠后重新激活
- [ ] 同时打开 Popup 和 Side Panel
- [ ] 切换标签页时 Side Panel 状态同步

## 🔍 技术细节

### 版本检测机制
```javascript
// 1. 检测 API 是否存在
typeof chrome?.sidePanel?.open === 'function'

// 2. 解析 User-Agent
const match = navigator.userAgent.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
const majorVersion = parseInt(match[1].split('.')[0], 10);

// 3. 双重验证
if (majorVersion >= 114 && isSidePanelAvailable()) {
  // 使用 Side Panel
}
```

### 降级策略
```javascript
chrome.action.onClicked.addListener(async (tab) => {
  if (isSidePanelAvailable()) {
    return; // Side Panel 由 setPanelBehavior 自动处理
  }

  // 降级：打开独立窗口
  await chrome.windows.create({
    url: chrome.runtime.getURL('popup/popup.html'),
    type: 'popup',
    width: 380,
    height: 600
  });
});
```

### 状态同步
- **background.js** → **Side Panel**：通过 `chrome.runtime.onMessage`
- **background.js** → **Popup**：通过 `chrome.runtime.onMessage`
- **两个面板同时打开**：共享同一个 `chrome.storage.local` 数据源

## 📊 性能考虑

### Side Panel 优势
1. **不受下载影响**：侧边栏固定在浏览器窗口
2. **持续可用**：不会因点击外部而关闭
3. **无需重新加载**：状态保持更持久

### 轮询频率
- **Popup**：1.5 秒（可能被关闭）
- **Side Panel**：2 秒（通常保持打开）

## 🐛 已知限制

1. **Chrome 最低版本**：114 (2023年5月发布)
2. **移动版 Chrome**：不支持 Side Panel API
3. **多窗口**：每个浏览器窗口有独立的 Side Panel

## 🔄 升级路径

### 从旧版扩展升级
1. **自动迁移**：现有配置和捕获数据不受影响
2. **首次使用**：点击图标自动打开 Side Panel
3. **回退选项**：可通过右键菜单打开 Popup

### 迁移到 Popup
如果用户更喜欢 Popup 模式：
1. 右键点击扩展图标
2. 选择"打开弹出窗口"
3. 或在 Side Panel 中关闭，再点击图标

## 📝 更新日志

### v1.1.0 (2025-02-18)
- ✨ 新增 Side Panel 支持 (Chrome 114+)
- ✨ 新增版本检测和降级处理
- ✨ 新增从 Popup 打开 Side Panel 的快捷按钮
- 🐛 修复下载时面板被遮挡的问题
- 📚 更新文档和用户提示

---

**实现完成时间**：2025-02-18
**测试状态**：待测试
**向后兼容**：完全兼容 Chrome 114+，降级支持更早版本
