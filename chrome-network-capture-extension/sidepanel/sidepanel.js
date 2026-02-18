/*
 * Side Panel 模式 - 不会受到下载进度条遮挡
 * 适用于 Chrome 114+ 浏览器
 */

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
const chromeVersionEl = document.getElementById('chromeVersion');

const toggleBtn = document.getElementById('toggleBtn');
const clearBtn = document.getElementById('clearBtn');
const optionsBtn = document.getElementById('optionsBtn');
const refreshBtn = document.getElementById('refreshBtn');
const openFolderBtn = document.getElementById('openFolderBtn');
const downloadScriptBtn = document.getElementById('downloadScriptBtn');
const packTodayBtn = document.getElementById('packTodayBtn');

const statsCard = document.getElementById('statsCard');
const statsHoverCard = document.getElementById('statsHoverCard');
const statsLoading = document.getElementById('statsLoading');
const ruleStatsHoverContent = document.getElementById('ruleStatsHoverContent');

let latestState = null;
let hoverTimer = null;
let isHoverCard = false;

// 检测并显示 Chrome 版本
function detectChromeVersion() {
  const userAgent = navigator.userAgent;
  const match = userAgent.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
  if (match) {
    const version = match[1];
    const majorVersion = parseInt(version.split('.')[0], 10);
    chromeVersionEl.textContent = `Chrome 版本：${version} (支持 Side Panel API)`;

    if (majorVersion < 114) {
      chromeVersionEl.textContent += ' - 注意：Side Panel API 需要 Chrome 114+';
      chromeVersionEl.style.color = 'var(--danger)';
    }
  } else {
    chromeVersionEl.textContent = '无法检测 Chrome 版本';
  }
}

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

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderRuleStatsHover(statsPayload) {
  if (!statsPayload) {
    ruleStatsHoverContent.innerHTML = '<div class="stats-hover-empty">暂无统计数据</div>';
    return;
  }

  const { total_records, total_captured, rule_stats } = statsPayload;
  const captureRate = total_records > 0 ? ((total_captured / total_records) * 100).toFixed(1) : '0.0';
  let html = `
    <div class="stats-hover-summary">
      <span class="capture-rate">捕获率 ${captureRate}%</span>
      <span class="total-count">总数 ${total_records} 条</span>
    </div>
  `;

  if (rule_stats && rule_stats.length > 0) {
    const sortedStats = [...rule_stats].sort((a, b) => b.count - a.count);
    html += '<div class="stats-hover-list">';
    for (let i = 0; i < sortedStats.length; i++) {
      const item = sortedStats[i];
      const itemClass = i < 3 ? 'stats-hover-item top-rule' : 'stats-hover-item';
      const percent = total_records > 0 ? ((item.count / total_records) * 100).toFixed(1) : '0.0';

      let icon = '⚪';
      if (item.type === 'all') {
        icon = '🔄';
      } else if (item.count >= total_records * 0.3) {
        icon = '🟢';
      } else if (item.count >= total_records * 0.1) {
        icon = '🟡';
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
  }
}

async function requestState() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (!res?.ok) {
      throw new Error(res?.error || '获取状态失败');
    }
    render(res.payload);
  } catch (error) {
    setMessage(error.message, true);
  }
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

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = '⏳';
  try {
    await requestState();
    setMessage('状态已刷新');
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    setTimeout(() => {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '🔄';
    }, 500);
  }
});

openFolderBtn.addEventListener('click', async () => {
  try {
    const today = new Date().toISOString().split('T')[0];
    await chrome.tabs.create({
      url: `chrome://downloads/?q=${today}`
    });
    setMessage('请在下载页面选中文件，右键选择"压缩为..."', false);
  } catch (error) {
    setMessage(error.message, true);
  }
});

async function detectPlatform() {
  const userAgent = navigator.userAgent;
  if (userAgent.includes('Windows')) {
    return 'windows';
  } else if (userAgent.includes('Mac') || userAgent.includes('Linux')) {
    return 'unix';
  }
  return 'unix';
}

function generateWindowsScript(savePath) {
  const relativePathTemplate = savePath
    ? `${savePath}\\%TODAY%`
    : '%TODAY%';

  return `@echo off
chcp 65001 > nul
set "TODAY="
set "PS_CMD="
where pwsh > nul 2>&1
if not errorlevel 1 set "PS_CMD=pwsh"
if not defined PS_CMD (
    where powershell > nul 2>&1
    if not errorlevel 1 set "PS_CMD=powershell"
)
if defined PS_CMD (
    for /f %%I in ('%PS_CMD% -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd')" 2^>nul') do set "TODAY=%%I"
)
if not defined TODAY (
    for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul') do set datetime=%%I
    if defined datetime set "TODAY=%datetime:~0,4%-%datetime:~4,2%-%datetime:~6,2%"
)
if not defined TODAY (
    echo [警告] 无法自动获取日期，请手动输入（格式：YYYY-MM-DD）
    set /p "TODAY=请输入日期："
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
if not exist "%SOURCE_DIR%" (
    echo [错误] 文件夹不存在：%SOURCE_DIR%
    pause
    exit /b 1
)
set "COMPRESS_OK="
if defined PS_CMD (
    %PS_CMD% -NoProfile -Command "Compress-Archive -Path '%SOURCE_DIR%' -DestinationPath '%ZIP_FILE%' -Force" > nul 2>&1
    if not errorlevel 1 set "COMPRESS_OK=1"
)
if not defined COMPRESS_OK (
    where tar > nul 2>&1
    if not errorlevel 1 (
        tar -a -c -f "%ZIP_FILE%" -C "%SOURCE_DIR%\\.." "%SOURCE_BASENAME%" > nul 2>&1
        if not errorlevel 1 set "COMPRESS_OK=1"
    )
)
if not defined COMPRESS_OK (
    echo [错误] 压缩失败
    pause
    exit /b 1
)
explorer /select,"%ZIP_FILE%"
timeout /t 2 > nul
`;
}

function generateUnixScript(savePath) {
  const relativePathTemplate = savePath
    ? `${savePath}/\${TODAY}`
    : '${TODAY}';

  return `#!/bin/bash
TODAY=$(date +%Y-%m-%d)
ZIP_FILE="network-capture-\${TODAY}.zip"
SOURCE_DIR="$HOME/Downloads/${relativePathTemplate}"
if [ ! -d "$SOURCE_DIR" ]; then
  echo "[错误] 文件夹不存在：$SOURCE_DIR"
  read -p "按回车键退出..."
  exit 1
fi
cd "$SOURCE_DIR/.."
SOURCE_BASENAME="$(basename "$SOURCE_DIR")"
COMPRESS_OK=0
if command -v zip >/dev/null 2>&1; then
  zip -r "$ZIP_FILE" "$SOURCE_BASENAME" >/dev/null 2>&1 && COMPRESS_OK=1
fi
if [ "$COMPRESS_OK" -ne 1 ] && command -v ditto >/dev/null 2>&1; then
  ditto -c -k --keepParent "$SOURCE_BASENAME" "$ZIP_FILE" >/dev/null 2>&1 && COMPRESS_OK=1
fi
if [ "$COMPRESS_OK" -ne 1 ] && command -v tar >/dev/null 2>&1; then
  tar -a -c -f "$ZIP_FILE" "$SOURCE_BASENAME" >/dev/null 2>&1 && COMPRESS_OK=1
fi
if [ "$COMPRESS_OK" -ne 1 ]; then
  echo "[错误] 压缩失败"
  read -p "按回车键退出..."
  exit 1
fi
if command -v open >/dev/null 2>&1; then
  open -R "$ZIP_FILE"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$ZIP_FILE" 2>/dev/null || true
fi
`;
}

downloadScriptBtn.addEventListener('click', async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (!res?.ok) {
      throw new Error(res?.error || '获取配置失败');
    }

    const { settings } = res.payload;
    const platform = await detectPlatform();
    const savePath = settings.save_path || '';

    let scriptContent;
    let scriptFilename;
    if (platform === 'windows') {
      scriptContent = generateWindowsScript(savePath);
      scriptFilename = 'network-capture-compress.bat';
    } else {
      scriptContent = generateUnixScript(savePath);
      scriptFilename = 'network-capture-compress.sh';
    }

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

    setTimeout(() => URL.revokeObjectURL(scriptUrl), 1000);
    setMessage(`已下载压缩脚本：${scriptFilename}（每天通用，无需重复下载）`, false);
  } catch (error) {
    setMessage(error.message, true);
  }
});

async function showStatsHover() {
  statsLoading.classList.add('active');

  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_RULE_STATS' });
    if (!res?.ok) {
      throw new Error(res?.error || '获取统计失败');
    }
    renderRuleStatsHover(res.payload);
    statsHoverCard.classList.add('show');
  } catch (error) {
    ruleStatsHoverContent.innerHTML = '<div class="stats-hover-empty">加载失败</div>';
    statsHoverCard.classList.add('show');
  } finally {
    statsLoading.classList.remove('active');
  }
}

function hideStatsHover() {
  statsHoverCard.classList.remove('show');
  setTimeout(() => {
    if (!statsHoverCard.classList.contains('show')) {
      ruleStatsHoverContent.innerHTML = '';
    }
  }, 200);
}

statsCard.addEventListener('mouseenter', () => {
  // 添加 2 秒延迟再触发 hover 浮层
  hoverTimer = setTimeout(() => {
    showStatsHover();
  }, 2000);
});

statsCard.addEventListener('mouseleave', () => {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  setTimeout(() => {
    if (!isHoverCard) {
      hideStatsHover();
    }
  }, 100);
});

statsHoverCard.addEventListener('mouseenter', () => {
  isHoverCard = true;
});

statsHoverCard.addEventListener('mouseleave', () => {
  isHoverCard = false;
  hideStatsHover();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'STATE_UPDATED') {
    render(message.payload);
  }
});

// 初始化
detectChromeVersion();
requestState().catch((error) => setMessage(error.message, true));

// Side Panel 模式下轮询间隔更长（2 秒），因为不会因为下载而关闭
setInterval(() => {
  requestState().catch(() => {
    // Side Panel 关闭或 service worker 暂时休眠时静默忽略
  });
}, 2000);

// ========== ZIP 打包今日数据功能 ==========

/**
 * Normalize path separators (Windows/Unix compatible)
 */
function normalizePath(path) {
  if (!path) return '';
  return path.replace(/\\/g, '/');
}

/**
 * Extract filename from full path
 */
function extractFilename(fullPath) {
  if (!fullPath) return '';
  const normalized = normalizePath(fullPath);
  const parts = normalized.split('/');
  return parts[parts.length - 1] || '';
}

/**
 * Check if file is a network capture JSON file
 * Filename format: {HHmmss}_{METHOD}_{HOST}_..._{STATUS}_{HASH}.json
 */
function isCaptureFile(filename) {
  if (!filename) return false;
  const basename = extractFilename(filename);
  // Must end with .json
  if (!basename.match(/\.json$/i)) return false;
  // Must start with 6-digit timestamp + underscore + HTTP method
  if (!basename.match(/^\d{6}_[a-z]+_/)) return false;
  return true;
}

/**
 * Pack today's capture data into ZIP
 * 
 * 说明：使用手动选择文件夹方式，直接从文件系统读取最新文件内容
 * 原因：chrome.downloads.search() 返回的 blob URL 可能指向过期内容
 */
async function packTodayData() {
  const btn = document.getElementById('packTodayBtn');
  const progressCard = document.getElementById('packProgress');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const progressCount = document.getElementById('progressCount');
  const progressTime = document.getElementById('progressTime');

  if (!btn) return;

  const startTime = Date.now();
  btn.disabled = true;
  progressCard.style.display = 'block';
  progressFill.style.width = '0%';
  progressFill.classList.remove('error');
  progressText.textContent = '请选择包含捕获数据的文件夹...';

  try {
    // 提示用户选择文件夹
    const manualBtn = document.createElement('button');
    manualBtn.className = 'btn primary';
    manualBtn.textContent = '📂 选择文件夹';
    manualBtn.style.marginTop = '8px';
    
    manualBtn.onclick = async () => {
      try {
        manualBtn.disabled = true;
        manualBtn.textContent = '正在打开文件夹选择...';

        const dirHandle = await window.showDirectoryPicker();
        progressText.textContent = '正在读取文件夹...';

        const files = [];
        for await (const entry of dirHandle.values()) {
          if (entry.kind === 'file' && isCaptureFile(entry.name)) {
            files.push({ name: entry.name, handle: entry });
          }
        }

        if (files.length === 0) {
          throw new Error('该文件夹中没有捕获数据文件');
        }

        progressText.textContent = `找到 ${files.length} 个文件，正在打包...`;
        await processFilesForZip(files, progressFill, progressText, progressCount, progressTime, startTime);
      } catch (err) {
        if (err.name === 'AbortError') {
          progressText.textContent = '用户已取消文件夹选择';
        } else {
          progressFill.classList.add('error');
          progressText.textContent = `错误：${err.message}`;
        }
      } finally {
        manualBtn.remove();
        btn.disabled = false;
      }
    };

    progressText.appendChild(document.createElement('br'));
    progressText.appendChild(manualBtn);

  } catch (error) {
    progressFill.classList.add('error');
    progressText.textContent = `打包失败：${error.message}`;
    console.error('Pack today data error:', error);
    btn.disabled = false;
  }
}

/**
 * Process files and create ZIP
 * 
 * 说明：直接从文件系统读取文件内容，不使用 chrome.downloads 的 blob URL
 */
async function processFilesForZip(files, progressFill, progressText, progressCount, progressTime, startTime) {
  const JSZip = (window.JZip || window.JSZip);
  if (!JSZip) {
    throw new Error('JSZip 库未加载，请刷新页面重试');
  }

  const zip = new JSZip();
  const today = new Date().toISOString().split('T')[0];
  let successCount = 0;
  let failCount = 0;

  progressText.textContent = `找到 ${files.length} 个文件，正在读取...`;

  // 批量处理文件
  const batchSize = 50;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, Math.min(i + batchSize, files.length));
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(files.length / batchSize);

    progressText.textContent = `处理批次 ${batchNum}/${totalBatches}...`;

    for (const item of batch) {
      try {
        // 直接从文件系统读取文件内容
        const file = await item.handle.getFile();
        const content = await file.text();

        const filename = item.name;
        zip.file(filename, content);
        successCount++;
      } catch (err) {
        console.error(`Failed to read file:`, item, err);
        failCount++;
      }
    }

    const progress = Math.round(((i + batch.length) / files.length) * 100);
    progressFill.style.width = `${progress}%`;
    progressCount.textContent = `${i + batch.length}/${files.length}`;
  }

  progressText.textContent = '正在压缩...';
  progressFill.style.width = '100%';

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  const zipUrl = URL.createObjectURL(zipBlob);

  const downloadFileName = `network-capture-${today}.zip`;

  try {
    await chrome.downloads.download({
      url: zipUrl,
      filename: downloadFileName,
      saveAs: true
    });
  } finally {
    URL.revokeObjectURL(zipUrl);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const sizeKB = (zipBlob.size / 1024).toFixed(0);

  progressText.innerHTML = `✅ 打包完成！<br>成功：${successCount} | 失败：${failCount}<br>ZIP 大小：${sizeKB} KB | 耗时：${elapsed}s`;
  progressTime.textContent = elapsed + 's';
}

// 绑定 ZIP 打包按钮事件
if (packTodayBtn) {
  packTodayBtn.addEventListener('click', packTodayData);
}
