const statusTextEl = document.getElementById('statusText');
const ruleCountValueEl = document.getElementById('ruleCountValue');
const rulePreviewValueEl = document.getElementById('rulePreviewValue');
const savePathValueEl = document.getElementById('savePathValue');
const totalRequestsEl = document.getElementById('totalRequests');
const matchedRequestsEl = document.getElementById('matchedRequests');
const capturedRequestsEl = document.getElementById('capturedRequests');
const errorCountEl = document.getElementById('errorCount');
const lastCaptureEl = document.getElementById('lastCapture');
const messageEl = document.getElementById('message');

const toggleBtn = document.getElementById('toggleBtn');
const clearBtn = document.getElementById('clearBtn');
const optionsBtn = document.getElementById('optionsBtn');
const openFolderBtn = document.getElementById('openFolderBtn');
const downloadScriptBtn = document.getElementById('downloadScriptBtn');

// Hover 统计卡片相关元素
const statsCard = document.getElementById('statsCard');
const statsHoverCard = document.getElementById('statsHoverCard');
const statsLoading = document.getElementById('statsLoading');
const ruleStatsHoverContent = document.getElementById('ruleStatsHoverContent');

let latestState = null;

function setMessage(text, isError = false) {
  messageEl.textContent = text || '';
  messageEl.style.color = isError ? '#de3c4b' : '#6b7688';
}

function formatTime(isoTime) {
  if (!isoTime) {
    return '-';
  }

  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) {
    return isoTime;
  }

  return date.toLocaleString();
}

function formatRulePreview(rules) {
  const enabledRules = (Array.isArray(rules) ? rules : [])
    .filter((rule) => rule?.enabled !== false && String(rule?.pattern || '').trim())
    .map((rule) => String(rule.pattern).trim());

  if (enabledRules.length === 0) {
    return '(未设置)';
  }

  if (enabledRules.length === 1) {
    return enabledRules[0];
  }

  return `${enabledRules[0]} +${enabledRules.length - 1} 条`;
}

// Hover 统计浮层渲染函数
function renderRuleStatsHover(statsPayload) {
  if (!statsPayload) {
    ruleStatsHoverContent.innerHTML = '<div class="stats-hover-empty">暂无统计数据</div>';
    return;
  }

  const { total_records, total_captured, rule_stats } = statsPayload;

  // 计算捕获率
  const captureRate = total_records > 0
    ? ((total_captured / total_records) * 100).toFixed(1)
    : '0.0';

  // 构建统计列表 HTML
  let html = `
    <div class="stats-hover-summary">
      <span class="capture-rate">捕获率 ${captureRate}%</span>
      <span class="total-count">总数 ${total_records} 条</span>
    </div>
  `;

  if (rule_stats && rule_stats.length > 0) {
    // 按捕获量降序排列
    const sortedStats = [...rule_stats].sort((a, b) => b.count - a.count);

    html += '<div class="stats-hover-list">';
    for (let i = 0; i < sortedStats.length; i++) {
      const item = sortedStats[i];
      const itemClass = i < 3 ? 'stats-hover-item top-rule' : 'stats-hover-item';
      const percent = total_records > 0 ? ((item.count / total_records) * 100).toFixed(1) : '0.0';

      // 根据类型选择图标
      let icon = '⚪';
      if (item.type === 'all') {
        icon = '🔄';
      } else if (item.count >= total_records * 0.3) {
        icon = '🟢'; // 高流量
      } else if (item.count >= total_records * 0.1) {
        icon = '🟡'; // 中流量
      }

      html += `
        <div class="${itemClass}">
          <div class="rule-info">
            <span class="rule-icon">${icon}</span>
            <span class="rule-pattern" title="${escapeHtml(item.pattern)}">${escapeHtml(item.pattern)}</span>
          </div>
          <div class="rule-stats">
            <span class="rule-count">${item.count}</span>
            <span class="rule-percent">${percent}%</span>
          </div>
        </div>
      `;
    }
    html += '</div>';
  } else {
    html += '<div class="stats-hover-empty">暂无规则统计数据</div>';
  }

  ruleStatsHoverContent.innerHTML = html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function render(state) {
  if (!state) {
    return;
  }

  latestState = state;

  const { settings, stats } = state;
  const enabled = Boolean(settings.capture_enabled);
  const rules = Array.isArray(settings.url_filter_rules) ? settings.url_filter_rules : [];
  const activeRules = rules.filter((rule) => rule?.enabled !== false && String(rule?.pattern || '').trim());

  statusTextEl.textContent = `状态：${enabled ? '捕获中' : '未开启'}`;
  statusTextEl.classList.toggle('status-on', enabled);
  statusTextEl.classList.toggle('status-off', !enabled);
  toggleBtn.textContent = enabled ? '停止捕获' : '开启捕获';

  // active_rule_count 由后台编译结果提供，若缺失则回退为前端统计
  const activeCount = Number.isFinite(state.active_rule_count)
    ? state.active_rule_count
    : activeRules.length;

  ruleCountValueEl.textContent = String(activeCount);
  rulePreviewValueEl.textContent = formatRulePreview(rules);
  savePathValueEl.textContent = settings.save_path || '下载目录根路径';

  totalRequestsEl.textContent = String(stats.total_requests || 0);
  matchedRequestsEl.textContent = String(stats.matched_requests || 0);
  capturedRequestsEl.textContent = String(stats.captured_requests || 0);
  errorCountEl.textContent = String(stats.error_count || 0);
  lastCaptureEl.textContent = `最近捕获：${formatTime(stats.last_capture_time)}`;

  if (stats.last_error) {
    setMessage(stats.last_error, true);
    return;
  }

  if ((stats.captured_requests || 0) > 0) {
    const savePath = settings.save_path || '下载目录根路径';
    setMessage(`匹配请求会实时保存到下载目录：${savePath}`);
    return;
  }
}

async function requestState() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (!res?.ok) {
    throw new Error(res?.error || '获取状态失败');
  }
  render(res.payload);
}

toggleBtn.addEventListener('click', async () => {
  try {
    const enabled = !latestState?.settings?.capture_enabled;
    const res = await chrome.runtime.sendMessage({
      type: 'TOGGLE_CAPTURE',
      enabled
    });
    if (!res?.ok) {
      throw new Error(res?.error || '切换捕获状态失败');
    }
    render(res.payload);
    setMessage(enabled ? '已开启捕获' : '已停止捕获');
  } catch (error) {
    setMessage(error.message, true);
  }
});

clearBtn.addEventListener('click', async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CLEAR_CAPTURE' });
    if (!res?.ok) {
      throw new Error(res?.error || '清空数据失败');
    }
    render(res.payload);
    setMessage('已清空捕获数据');
  } catch (error) {
    setMessage(error.message, true);
  }
});

optionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// 按钮 1：打开今日文件夹
openFolderBtn.addEventListener('click', async () => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // 打开下载管理页面并搜索今天的文件
    await chrome.tabs.create({
      url: `chrome://downloads/?q=${today}`
    });

    setMessage('请在下载页面选中文件，右键选择"压缩为..."', false);
  } catch (error) {
    setMessage(error.message, true);
  }
});

// 按钮 2：生成压缩脚本
downloadScriptBtn.addEventListener('click', async () => {
  try {
    // 1. 获取用户配置（包括 save_path）
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (!res?.ok) {
      throw new Error(res?.error || '获取配置失败');
    }

    const { settings } = res.payload;
    const platform = await detectPlatform();
    const savePath = settings.save_path || '';  // 获取用户配置的保存路径

    let scriptContent, scriptFilename;

    if (platform === 'windows') {
      scriptContent = generateWindowsScript(savePath);
      scriptFilename = 'network-capture-compress.bat';
    } else {
      // macOS 或 Linux
      scriptContent = generateUnixScript(savePath);
      scriptFilename = 'network-capture-compress.sh';
    }

    // 创建脚本 Blob 并下载
    const scriptBlob = new Blob([scriptContent], {
      type: platform === 'windows' ? 'text/plain' : 'text/x-shell-script'
    });
    const scriptUrl = URL.createObjectURL(scriptBlob);

    await chrome.downloads.download({
      url: scriptUrl,
      filename: scriptFilename,
      saveAs: false,
      conflictAction: 'uniquify'
    });

    // 清理 URL
    setTimeout(() => URL.revokeObjectURL(scriptUrl), 1000);

    setMessage(`已下载压缩脚本：${scriptFilename}（每天通用，无需重复下载）`, false);
  } catch (error) {
    setMessage(error.message, true);
  }
});

// Hover 统计浮层交互逻辑
let hoverTimer = null;
let isHoverCard = false;

// 显示统计浮层
async function showStatsHover() {
  statsLoading.classList.add('active');

  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_RULE_STATS' });
    if (!res?.ok) {
      throw new Error(res?.error || '获取统计失败');
    }

    // 渲染统计数据
    renderRuleStatsHover(res.payload);
    statsHoverCard.classList.add('show');
  } catch (error) {
    console.error('Failed to load stats:', error);
    ruleStatsHoverContent.innerHTML = '<div class="stats-hover-empty">加载失败</div>';
    statsHoverCard.classList.add('show');
  } finally {
    statsLoading.classList.remove('active');
  }
}

// 隐藏统计浮层
function hideStatsHover() {
  statsHoverCard.classList.remove('show');
  // 清空内容，避免下次显示时闪烁
  setTimeout(() => {
    if (!statsHoverCard.classList.contains('show')) {
      ruleStatsHoverContent.innerHTML = '';
    }
  }, 200);
}

// 鼠标进入统计卡片
statsCard.addEventListener('mouseenter', () => {
  // 延迟 300ms 显示
  hoverTimer = setTimeout(() => {
    showStatsHover();
  }, 300);
});

// 鼠标离开统计卡片
statsCard.addEventListener('mouseleave', () => {
  // 清除延迟定时器
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }

  // 延迟隐藏，给用户时间移动到浮层上
  setTimeout(() => {
    if (!isHoverCard) {
      hideStatsHover();
    }
  }, 100);
});

// 鼠标进入浮层
statsHoverCard.addEventListener('mouseenter', () => {
  isHoverCard = true;
});

// 鼠标离开浮层
statsHoverCard.addEventListener('mouseleave', () => {
  isHoverCard = false;
  hideStatsHover();
});

// 辅助函数：检测操作系统
async function detectPlatform() {
  const userAgent = navigator.userAgent;
  if (userAgent.includes('Windows')) {
    return 'windows';
  } else if (userAgent.includes('Mac') || userAgent.includes('Linux')) {
    return 'unix';
  }
  return 'unix'; // 默认按 Unix 处理
}

// 辅助函数：生成 Windows 批处理脚本
function generateWindowsScript(savePath) {
  // 路径模板中的日期部分会在运行时动态获取
  const relativePathTemplate = savePath
    ? `${savePath}\\%TODAY%`
    : '%TODAY%';

  return `@echo off
chcp 65001 > nul

set "TODAY="
set "PS_CMD="

rem 优先使用 pwsh / powershell 获取日期，兼容较新系统
where pwsh > nul 2>&1
if not errorlevel 1 set "PS_CMD=pwsh"
if not defined PS_CMD (
    where powershell > nul 2>&1
    if not errorlevel 1 set "PS_CMD=powershell"
)

if defined PS_CMD (
    for /f %%I in ('%PS_CMD% -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd')" 2^>nul') do set "TODAY=%%I"
)

rem 降级到 wmic（旧系统可用）
if not defined TODAY (
    for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul') do set datetime=%%I
    if defined datetime set "TODAY=%datetime:~0,4%-%datetime:~4,2%-%datetime:~6,2%"
)

rem 再降级为手动输入，避免脚本不可用
if not defined TODAY (
    echo [警告] 无法自动获取日期，请手动输入（格式：YYYY-MM-DD）
    set /p "TODAY=请输入日期: "
)

if not defined TODAY (
    echo [错误] 日期不能为空
    pause
    exit /b 1
)
echo %TODAY% | findstr /R "^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$" > nul
if errorlevel 1 (
    echo [错误] 日期格式无效，应为 YYYY-MM-DD
    pause
    exit /b 1
)

set "ZIP_FILE=network-capture-%TODAY%.zip"
set "SOURCE_DIR=%USERPROFILE%\\Downloads\\${relativePathTemplate}"
for %%I in ("%SOURCE_DIR%") do set "SOURCE_BASENAME=%%~nxI"

echo ========================================
echo   网络捕获数据压缩工具
echo   目标日期: %TODAY%
echo ========================================
echo.

if not exist "%SOURCE_DIR%" (
    echo [错误] 文件夹不存在: %SOURCE_DIR%
    echo 请先开启捕获并访问一些网站
    pause
    exit /b 1
)

echo [1/3] 正在查找今日捕获的文件...
dir "%SOURCE_DIR%" /b 2>nul | find /c /v "" > nul
if errorlevel 1 (
    echo [错误] 文件夹为空
    pause
    exit /b 1
)
echo [完成] 找到文件

echo.
echo [2/3] 正在压缩文件夹...
set "COMPRESS_OK="

if defined PS_CMD (
    %PS_CMD% -NoProfile -Command "Compress-Archive -Path '%SOURCE_DIR%' -DestinationPath '%ZIP_FILE%' -Force" > nul 2>&1
    if not errorlevel 1 set "COMPRESS_OK=1"
)

rem PowerShell 不可用或失败时，降级使用 tar（Windows 10+ 常见）
if not defined COMPRESS_OK (
    where tar > nul 2>&1
    if not errorlevel 1 (
        tar -a -c -f "%ZIP_FILE%" -C "%SOURCE_DIR%\\.." "%SOURCE_BASENAME%" > nul 2>&1
        if not errorlevel 1 set "COMPRESS_OK=1"
    )
)

if not defined COMPRESS_OK (
    echo [错误] 压缩失败：未找到可用压缩器（PowerShell/tar）或执行失败
    pause
    exit /b 1
)
echo [完成] 压缩成功

echo.
echo [3/3] 压缩完成！
echo.
echo ========================================
echo   压缩完成！
echo   文件位置: %ZIP_FILE%
echo ========================================
echo.
echo 脚本可重复使用，无需每天重新下载
echo.
set /p "DELETE_SCRIPT=是否删除脚本自身？(Y/N，默认=N): "
if /i "%DELETE_SCRIPT%"=="Y" (
    echo 正在删除脚本...
    del "%~f0" > nul 2>&1
    echo 脚本已删除
) else (
    echo 脚本已保留，可继续使用
)

echo.
explorer /select,"%ZIP_FILE%"

timeout /t 3 > nul
`;
}

// 辅助函数：生成 Unix Shell 脚本
function generateUnixScript(savePath) {
  // 路径模板中的日期部分会在运行时动态获取
  const relativePathTemplate = savePath
    ? `${savePath}/\${TODAY}`
    : '${TODAY}';

  return `#!/bin/bash

# 网络捕获数据压缩工具
# 动态获取当天日期（格式：YYYY-MM-DD）
TODAY=$(date +%Y-%m-%d)

ZIP_FILE="network-capture-\${TODAY}.zip"
SOURCE_DIR="$HOME/Downloads/${relativePathTemplate}"

echo "========================================"
echo "  网络捕获数据压缩工具"
echo "  目标日期: \${TODAY}"
echo "  保存路径: ${savePath || '下载目录根路径'}/\${TODAY}"
echo "========================================"
echo

if [ ! -d "$SOURCE_DIR" ]; then
  echo "[错误] 文件夹不存在: $SOURCE_DIR"
  echo "请先开启捕获并访问一些网站"
  read -p "按回车键退出..."
  exit 1
fi

FILE_COUNT=$(find "$SOURCE_DIR" -type f | wc -l | tr -d ' ')
if [ "$FILE_COUNT" -eq 0 ]; then
  echo "[错误] 文件夹为空"
  read -p "按回车键退出..."
  exit 1
fi

echo "[1/3] 正在查找今日捕获的文件..."
echo "找到 $FILE_COUNT 个文件"
echo "[完成]"

echo
echo "[2/3] 正在压缩文件夹..."
cd "$SOURCE_DIR/.."
SOURCE_BASENAME="$(basename "$SOURCE_DIR")"
COMPRESS_OK=0

if command -v zip >/dev/null 2>&1; then
  zip -r "$ZIP_FILE" "$SOURCE_BASENAME" >/dev/null 2>&1 && COMPRESS_OK=1
fi

# macOS 常见降级方案
if [ "$COMPRESS_OK" -ne 1 ] && command -v ditto >/dev/null 2>&1; then
  ditto -c -k --keepParent "$SOURCE_BASENAME" "$ZIP_FILE" >/dev/null 2>&1 && COMPRESS_OK=1
fi

# Linux/部分系统的通用降级方案
if [ "$COMPRESS_OK" -ne 1 ] && command -v tar >/dev/null 2>&1; then
  tar -a -c -f "$ZIP_FILE" "$SOURCE_BASENAME" >/dev/null 2>&1 && COMPRESS_OK=1
fi

if [ "$COMPRESS_OK" -ne 1 ]; then
  echo "[错误] 压缩失败：未找到可用压缩器（zip/ditto/tar）或执行失败"
  read -p "按回车键退出..."
  exit 1
fi
echo "[完成] 压缩成功"

echo
echo "========================================"
echo "  压缩完成！"
echo "  文件位置: $(pwd)/$ZIP_FILE"
echo "========================================"
echo
echo "脚本可重复使用，无需每天重新下载"
echo

# 询问是否删除脚本
read -p "是否删除脚本自身？(y/N，默认=N): " DELETE_SCRIPT
if [[ "$DELETE_SCRIPT" =~ ^[Yy]$ ]]; then
  SCRIPT_PATH="$0"
  rm -f "$SCRIPT_PATH"
  echo "脚本已删除"
else
  echo "脚本已保留，可继续使用"
fi

echo

# 尝试打开文件管理器并选中文件
if command -v open >/dev/null 2>&1; then
  # macOS
  open -R "$ZIP_FILE"
elif command -v xdg-open >/dev/null 2>&1; then
  # Linux
  xdg-open "$ZIP_FILE" 2>/dev/null || nautilus "$ZIP_FILE" 2>/dev/null || dolphin "$ZIP_FILE" 2>/dev/null
fi
`;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'STATE_UPDATED') {
    render(message.payload);
  }
});

requestState().catch((error) => setMessage(error.message, true));
setInterval(() => {
  requestState().catch(() => {
    // popup 关闭或 service worker 暂时休眠时静默忽略
  });
}, 1500);
