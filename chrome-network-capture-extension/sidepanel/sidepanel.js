/*
 * Side Panel 模式 - 不会受到下载进度条遮挡
 * 适用于 Chrome 114+ 浏览器
 *
 * 新增功能：
 *  1. 瀑布图 Tab - 可视化请求时间线
 *  2. 右键菜单 - 复制为 cURL / fetch() / URL
 *
 * 内存安全原则：
 *  - 瀑布图仅使用 recent_records 中的元数据（无 response body）
 *  - 代码生成仅使用 request headers / method / url / request_body
 *  - 不在 UI 层缓存完整 body，防止内存泄漏
 */

// ============================================================
// DOM 引用
// ============================================================

const statusTextEl       = document.getElementById('statusText');
const ruleCountValueEl   = document.getElementById('ruleCountValue');
const rulePreviewValueEl = document.getElementById('rulePreviewValue');
const savePathValueEl    = document.getElementById('savePathValue');
const totalRequestsEl    = document.getElementById('totalRequests');
const matchedRequestsEl  = document.getElementById('matchedRequests');
const capturedRequestsEl = document.getElementById('capturedRequests');
const errorCountEl       = document.getElementById('errorCount');
const lastCaptureEl      = document.getElementById('lastCapture');
const messageEl          = document.getElementById('message');
const chromeVersionEl    = document.getElementById('chromeVersion');

const toggleBtn        = document.getElementById('toggleBtn');
const clearBtn         = document.getElementById('clearBtn');
const optionsBtn       = document.getElementById('optionsBtn');
const refreshBtn       = document.getElementById('refreshBtn');
const openFolderBtn    = document.getElementById('openFolderBtn');
const downloadScriptBtn = document.getElementById('downloadScriptBtn');
const packTodayBtn     = document.getElementById('packTodayBtn');

const statsCard            = document.getElementById('statsCard');
const statsHoverCard       = document.getElementById('statsHoverCard');
const statsLoading         = document.getElementById('statsLoading');
const ruleStatsHoverContent = document.getElementById('ruleStatsHoverContent');

// 瀑布图相关
const waterfallList    = document.getElementById('waterfallList');
const waterfallBadge   = document.getElementById('waterfallBadge');
const waterfallSearch  = document.getElementById('waterfallSearch');
const clearWaterfallBtn = document.getElementById('clearWaterfallBtn');

// 右键菜单
const ctxMenu      = document.getElementById('ctxMenu');
const ctxCopyCurl  = document.getElementById('ctxCopyCurl');
const ctxCopyFetch = document.getElementById('ctxCopyFetch');
const ctxCopyUrl   = document.getElementById('ctxCopyUrl');

// ============================================================
// 全局状态（仅元数据，无 body）
// ============================================================

let latestState   = null;
let hoverTimer    = null;
let isHoverCard   = false;

/**
 * 瀑布图记录池 —— 仅存储渲染所需的轻量元数据
 * 结构：Map<id, WaterfallMeta>
 * WaterfallMeta = { id, url, method, status, startTime, endTime, durationMs,
 *                   requestHeaders, requestBody（仅含 type/value，已截断）}
 *
 * 内存上限：由 settings.waterfall_max_records 动态控制，超出时删最旧的
 */
const wfRecordMap = new Map(); // id -> WaterfallMeta（有序插入）

/** 当前右键菜单绑定的目标记录 id */
let ctxTargetId = null;

// ============================================================
// 工具函数
// ============================================================

function setMessage(text, isError = false) {
  messageEl.textContent = text || '';
  messageEl.style.color = isError ? '#de3c4b' : '#6b7688';
}

function formatTime(isoTime) {
  if (!isoTime) return '-';
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) return isoTime;
  return date.toLocaleString();
}

function formatRulePreview(rules) {
  const enabledRules = (Array.isArray(rules) ? rules : [])
    .filter((r) => r?.enabled !== false && String(r?.pattern || '').trim())
    .map((r) => String(r.pattern).trim());

  if (enabledRules.length === 0) return '(未设置)';
  if (enabledRules.length === 1) return enabledRules[0];
  return `${enabledRules[0]} +${enabledRules.length - 1} 条`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** 格式化耗时为人类友好字符串 */
function formatDuration(ms) {
  if (ms == null || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** 根据 HTTP 状态码返回色系类名 */
function statusClass(code) {
  if (!code) return 's-pending';
  if (code < 300) return 's-2xx';
  if (code < 400) return 's-3xx';
  if (code < 500) return 's-4xx';
  return 's-5xx';
}

/** 耗时速度等级 */
function durationClass(ms) {
  if (ms == null) return '';
  if (ms > 3000) return 'very-slow';
  if (ms > 1000) return 'slow';
  return '';
}

/** Method 徽章的色系类名 */
function methodClass(method) {
  return `m-${String(method || 'get').toLowerCase()}`;
}

// ============================================================
// Tab 切换
// ============================================================

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === target);
      b.setAttribute('aria-selected', String(b.dataset.tab === target));
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${target}`);
    });
  });
});

// ============================================================
// 瀑布图渲染（纯元数据，无 body）
// ============================================================

/**
 * 从 state.recent_records 提取轻量元数据并更新 wfRecordMap。
 * recent_records 中的 record 已是 toPersistedRecord() 的输出，
 * request_body / response_body 均为 null，不含敏感大体积数据。
 *
 * maxRecords 来自 settings.waterfall_max_records，默认 50。
 */
function updateWaterfallPool(recentRecords, maxRecords) {
  if (!Array.isArray(recentRecords)) return;
  const limit = Math.min(500, Math.max(10, Number(maxRecords) || 50));

  for (const rec of recentRecords) {
    if (!rec?.id) continue;

    const incomingHeaders = Array.isArray(rec.request?.request_headers)
      ? rec.request.request_headers
      : [];

    // 时序竞争修复：
    // onBeforeRequest 先触发 → 2s 轮询写入 wfRecordMap（此时 headers 为空）
    // onBeforeSendHeaders 后触发 → 再次轮询时 id 已存在，被旧逻辑 continue 跳过
    // 修复策略：若 id 已存在但 headers 仍为空，允许覆盖更新（补填 headers）
    const existing = wfRecordMap.get(rec.id);
    if (existing && existing.requestHeaders.length > 0) continue;

    const meta = {
      id:             rec.id,
      url:            rec.request?.url || '',
      method:         String(rec.request?.method || 'GET').toUpperCase(),
      status:         rec.response?.status_code ?? null,
      startTime:      rec.performance?.start_time ?? null,
      endTime:        rec.performance?.end_time ?? null,
      durationMs:     rec.performance?.duration_ms ?? null,
      fromCache:      Boolean(rec.performance?.from_cache),
      requestHeaders: incomingHeaders,
      bodyPreview:    rec.request?.body_preview || '',
      hasBody:        Boolean(rec.request?.has_body),
    };

    wfRecordMap.set(rec.id, meta);

    // 超出上限时删最旧的（Map 保持插入顺序）
    if (wfRecordMap.size > limit) {
      const firstKey = wfRecordMap.keys().next().value;
      wfRecordMap.delete(firstKey);
    }
  }
}

/**
 * 计算所有记录中最小 startTime 和最大 endTime，用于归一化进度条位置。
 * 只处理符合过滤条件的记录。
 */
function calcTimeRange(records) {
  let minStart = Infinity;
  let maxEnd   = -Infinity;

  for (const rec of records) {
    const s = typeof rec.startTime === 'number' ? rec.startTime : null;
    const e = rec.endTime != null ? rec.endTime : (s != null && rec.durationMs != null ? s + rec.durationMs : null);
    if (s != null && s < minStart) minStart = s;
    if (e != null && e > maxEnd)   maxEnd   = e;
  }

  if (!isFinite(minStart) || !isFinite(maxEnd) || maxEnd <= minStart) {
    return { minStart: 0, totalSpan: 1 };
  }
  return { minStart, totalSpan: maxEnd - minStart };
}

/** 当前搜索关键词（小写） */
let wfFilterText = '';

/** 根据关键词过滤记录 */
function filterWfRecords() {
  const all = Array.from(wfRecordMap.values()).reverse(); // 最新在上
  if (!wfFilterText) return all;
  return all.filter((r) => {
    const q = wfFilterText;
    return (
      r.url.toLowerCase().includes(q) ||
      r.method.toLowerCase().includes(q) ||
      String(r.status || '').includes(q)
    );
  });
}

/**
 * 渲染瀑布图列表。
 * 使用 DocumentFragment 批量插入，避免多次 reflow。
 * 不操作 DOM 之外的大对象，防止内存泄漏。
 */
function renderWaterfall() {
  const records = filterWfRecords();

  // 更新 badge
  const total = wfRecordMap.size;
  waterfallBadge.textContent = total > 99 ? '99+' : String(total);
  waterfallBadge.style.display = total > 0 ? '' : 'none';

  if (records.length === 0) {
    waterfallList.innerHTML = '<div class="waterfall-empty">暂无匹配记录</div>';
    return;
  }

  const { minStart, totalSpan } = calcTimeRange(records);

  const frag = document.createDocumentFragment();

  for (const rec of records) {
    const row = document.createElement('div');
    row.className = 'wf-row';
    row.dataset.id = rec.id;
    row.setAttribute('role', 'listitem');
    row.title = rec.url;

    // —— Method 徽章
    const methodEl = document.createElement('span');
    methodEl.className = `wf-method ${methodClass(rec.method)}`;
    methodEl.textContent = rec.method.slice(0, 7); // 最多显示 7 字符
    row.appendChild(methodEl);

    // —— URL（只显示 pathname + search，host 太长）
    const urlEl = document.createElement('span');
    urlEl.className = 'wf-url';
    try {
      const u = new URL(rec.url);
      urlEl.textContent = u.pathname + (u.search ? u.search.slice(0, 40) : '');
    } catch {
      urlEl.textContent = rec.url;
    }
    row.appendChild(urlEl);

    // —— 瀑布进度条
    const barWrap = document.createElement('div');
    barWrap.className = 'wf-bar-wrap';

    const bar = document.createElement('div');
    const sc = statusClass(rec.status);
    bar.className = `wf-bar ${sc}`;

    // 归一化位置
    const s = typeof rec.startTime === 'number' ? rec.startTime : minStart;
    const e = rec.endTime != null
      ? rec.endTime
      : (rec.durationMs != null ? s + rec.durationMs : s + 1);

    const leftPct  = totalSpan > 0 ? ((s - minStart) / totalSpan) * 100 : 0;
    const widthPct = totalSpan > 0 ? Math.max(((e - s) / totalSpan) * 100, 2) : 100;

    bar.style.left  = `${Math.max(0, Math.min(leftPct, 98))}%`;
    bar.style.width = `${Math.max(2, Math.min(widthPct, 100 - leftPct))}%`;

    barWrap.appendChild(bar);
    row.appendChild(barWrap);

    // —— 耗时
    const durEl = document.createElement('span');
    const dc = durationClass(rec.durationMs);
    durEl.className = `wf-duration${dc ? ' ' + dc : ''}`;
    durEl.textContent = formatDuration(rec.durationMs);
    row.appendChild(durEl);

    // 右键事件
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, rec.id);
    });

    frag.appendChild(row);
  }

  waterfallList.innerHTML = '';
  waterfallList.appendChild(frag);
}

// ============================================================
// 右键菜单
// ============================================================

function showCtxMenu(x, y, recordId) {
  ctxTargetId = recordId;

  // 防止菜单超出视口
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const menuW = 180;
  const menuH = 120;

  ctxMenu.style.left = `${Math.min(x, vw - menuW - 8)}px`;
  ctxMenu.style.top  = `${Math.min(y, vh - menuH - 8)}px`;
  ctxMenu.style.display = 'block';
}

function hideCtxMenu() {
  ctxMenu.style.display = 'none';
  ctxTargetId = null;
}

document.addEventListener('click', (e) => {
  if (!ctxMenu.contains(e.target)) hideCtxMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideCtxMenu();
});

// ============================================================
// cURL / fetch() 代码生成（仅用请求头和方法，不读 response body）
// ============================================================

/**
 * 对 header value 中的单引号进行转义，防止注入 shell 命令。
 */
function escapeShellSingleQuote(str) {
  return String(str ?? '').replace(/'/g, "'\\''");
}

/**
 * 将 requestHeaders 数组转为 Map（忽略大小写 key）
 */
function headersToMap(headers) {
  const map = new Map();
  for (const h of (Array.isArray(headers) ? headers : [])) {
    if (h?.name) map.set(h.name.toLowerCase(), h.value ?? '');
  }
  return map;
}

/**
 * 生成 cURL 命令。
 * 注意：仅使用 request metadata，不读取 response body。
 * body_preview 是可选的（settings.persist_body_preview 默认关闭），
 * 未启用时为空字符串，直接跳过 --data 参数。
 *
 * Accept-Encoding 处理策略（与 DevTools "Copy as cURL" 一致）：
 *   - 若请求头包含 Accept-Encoding（含 gzip/br/zstd），curl 收到压缩响应后
 *     不会自动解压，输出原始字节流（乱码/blob）。
 *   - 修复：过滤掉 Accept-Encoding，改为追加 --compressed 标志，
 *     让 curl 自行协商压缩并在本地解压，与 DevTools 行为完全一致。
 */
function buildCurlCommand(meta) {
  const headers = Array.isArray(meta.requestHeaders) ? meta.requestHeaders : [];

  // 检测原始请求是否声明了压缩编码（含 gzip / br / zstd / deflate）
  const hasEncoding = headers.some(
    (h) => /^accept-encoding$/i.test(h?.name ?? '') &&
           /gzip|br|zstd|deflate/i.test(h?.value ?? '')
  );

  // GET/HEAD 时 -X 可省略（与 DevTools 一致），其他方法保留
  const methodPart = (meta.method === 'GET' || meta.method === 'HEAD')
    ? `curl`
    : `curl -X ${meta.method}`;

  const lines = [methodPart];

  // 若有压缩编码，追加 --compressed（解压交给 curl）
  if (hasEncoding) lines.push('  --compressed');

  // Headers：过滤伪头、content-length、Accept-Encoding（已由 --compressed 接管）
  const SKIP_HEADERS = /^(:authority|:method|:path|:scheme|content-length|accept-encoding)$/i;
  for (const h of headers) {
    if (!h?.name) continue;
    if (SKIP_HEADERS.test(h.name)) continue;
    const name = escapeShellSingleQuote(h.name);
    const val  = escapeShellSingleQuote(h.value ?? '');
    lines.push(`  -H '${name}: ${val}'`);
  }

  // Request body（仅当 persist_body_preview 开启且有内容时）
  if (meta.hasBody && meta.bodyPreview) {
    const safeBody = escapeShellSingleQuote(meta.bodyPreview);
    lines.push(`  --data '${safeBody}'`);
  }

  lines.push(`  '${escapeShellSingleQuote(meta.url)}'`);
  return lines.join(' \\\n');
}

/**
 * 生成 fetch() 代码片段。
 * 同上，不读取 response body，只使用 request 元数据。
 */
function buildFetchSnippet(meta) {
  const headersObj = {};
  for (const h of (Array.isArray(meta.requestHeaders) ? meta.requestHeaders : [])) {
    if (!h?.name) continue;
    if (/^(:authority|:method|:path|:scheme|content-length)$/i.test(h.name)) continue;
    headersObj[h.name] = h.value ?? '';
  }

  const options = {
    method: meta.method,
    headers: headersObj,
  };

  // Request body
  if (meta.hasBody && meta.bodyPreview) {
    options.body = meta.bodyPreview;
  }

  const optStr = JSON.stringify(options, null, 2);
  const urlStr = JSON.stringify(meta.url);

  return `const response = await fetch(${urlStr}, ${optStr});\nconst data = await response.json();`;
}

/** 复制文本到剪贴板并弹 Toast */
async function copyToClipboard(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`已复制 ${label}`);
  } catch {
    // 降级方案
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast(`已复制 ${label}`);
  }
}

/** 轻量 Toast 提示（单例，自动消失） */
let toastEl = null;
let toastTimer = null;

function showToast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'copy-toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
  }, 1800);
}

// 右键菜单点击处理
// 注意：先快照 ctxTargetId，再调 hideCtxMenu()，否则 hideCtxMenu 会将其清空
ctxCopyCurl.addEventListener('click', () => {
  const id = ctxTargetId;
  hideCtxMenu();
  if (!id) return;
  const meta = wfRecordMap.get(id);
  if (!meta) return;
  copyToClipboard(buildCurlCommand(meta), 'cURL 命令');
});

ctxCopyFetch.addEventListener('click', () => {
  const id = ctxTargetId;
  hideCtxMenu();
  if (!id) return;
  const meta = wfRecordMap.get(id);
  if (!meta) return;
  copyToClipboard(buildFetchSnippet(meta), 'fetch() 代码');
});

ctxCopyUrl.addEventListener('click', () => {
  const id = ctxTargetId;
  hideCtxMenu();
  if (!id) return;
  const meta = wfRecordMap.get(id);
  if (!meta) return;
  copyToClipboard(meta.url, 'URL');
});

// 搜索过滤
waterfallSearch.addEventListener('input', () => {
  wfFilterText = waterfallSearch.value.trim().toLowerCase();
  renderWaterfall();
});

// 清空瀑布图
clearWaterfallBtn.addEventListener('click', () => {
  wfRecordMap.clear();
  wfFilterText = '';
  waterfallSearch.value = '';
  renderWaterfall();
  setMessage('已清空瀑布图记录');
});

// ============================================================
// 概览渲染
// ============================================================

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
      if (item.type === 'all') icon = '🔄';
      else if (item.count >= total_records * 0.3) icon = '🟢';
      else if (item.count >= total_records * 0.1) icon = '🟡';

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
  if (!state) return;
  latestState = state;

  const { settings, stats } = state;
  const enabled = Boolean(settings.capture_enabled);
  const rules = Array.isArray(settings.url_filter_rules) ? settings.url_filter_rules : [];
  const activeRules = rules.filter((r) => r?.enabled !== false && String(r?.pattern || '').trim());

  statusTextEl.textContent = `状态：${enabled ? '捕获中' : '未开启'}`;
  statusTextEl.classList.toggle('status-on', enabled);
  statusTextEl.classList.toggle('status-off', !enabled);
  toggleBtn.textContent = enabled ? '停止捕获' : '开启捕获';

  const activeCount = Number.isFinite(state.active_rule_count)
    ? state.active_rule_count
    : activeRules.length;

  ruleCountValueEl.textContent  = String(activeCount);
  rulePreviewValueEl.textContent = formatRulePreview(rules);
  savePathValueEl.textContent   = settings.save_path || '下载目录根路径';

  totalRequestsEl.textContent    = String(stats.total_requests || 0);
  matchedRequestsEl.textContent  = String(stats.matched_requests || 0);
  capturedRequestsEl.textContent = String(stats.captured_requests || 0);
  errorCountEl.textContent       = String(stats.error_count || 0);
  lastCaptureEl.textContent      = `最近捕获：${formatTime(stats.last_capture_time)}`;

  // 更新瀑布图数据（仅元数据，无 body），上限由 settings.waterfall_max_records 控制
  updateWaterfallPool(state.recent_records, settings.waterfall_max_records);
  renderWaterfall();

  if (stats.last_error) {
    setMessage(stats.last_error, true);
    return;
  }

  if ((stats.captured_requests || 0) > 0) {
    const savePath = settings.save_path || '下载目录根路径';
    setMessage(`匹配请求会实时保存到下载目录：${savePath}`);
  }
}

// ============================================================
// 状态请求 & 消息监听
// ============================================================

async function requestState() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (!res?.ok) throw new Error(res?.error || '获取状态失败');
    render(res.payload);
  } catch (error) {
    setMessage(error.message, true);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'STATE_UPDATED') render(message.payload);
});

// ============================================================
// 按钮事件绑定
// ============================================================

toggleBtn.addEventListener('click', async () => {
  try {
    const enabled = !latestState?.settings?.capture_enabled;
    const res = await chrome.runtime.sendMessage({ type: 'TOGGLE_CAPTURE', enabled });
    if (!res?.ok) throw new Error(res?.error || '切换捕获状态失败');
    render(res.payload);
    setMessage(enabled ? '已开启捕获' : '已停止捕获');
  } catch (error) {
    setMessage(error.message, true);
  }
});

clearBtn.addEventListener('click', async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CLEAR_CAPTURE' });
    if (!res?.ok) throw new Error(res?.error || '清空数据失败');
    // 同时清空瀑布图
    wfRecordMap.clear();
    render(res.payload);
    renderWaterfall();
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
    await chrome.tabs.create({ url: `chrome://downloads/?q=${today}` });
    setMessage('请在下载页面选中文件，右键选择"压缩为..."', false);
  } catch (error) {
    setMessage(error.message, true);
  }
});

// ============================================================
// Hover 统计浮层
// ============================================================

async function showStatsHover() {
  statsLoading.classList.add('active');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_RULE_STATS' });
    if (!res?.ok) throw new Error(res?.error || '获取统计失败');
    renderRuleStatsHover(res.payload);
    statsHoverCard.classList.add('show');
  } catch {
    ruleStatsHoverContent.innerHTML = '<div class="stats-hover-empty">加载失败</div>';
    statsHoverCard.classList.add('show');
  } finally {
    statsLoading.classList.remove('active');
  }
}

function hideStatsHover() {
  statsHoverCard.classList.remove('show');
  setTimeout(() => {
    if (!statsHoverCard.classList.contains('show')) ruleStatsHoverContent.innerHTML = '';
  }, 200);
}

statsCard.addEventListener('mouseenter', () => {
  hoverTimer = setTimeout(() => showStatsHover(), 2000);
});
statsCard.addEventListener('mouseleave', () => {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  setTimeout(() => { if (!isHoverCard) hideStatsHover(); }, 100);
});
statsHoverCard.addEventListener('mouseenter', () => { isHoverCard = true; });
statsHoverCard.addEventListener('mouseleave', () => { isHoverCard = false; hideStatsHover(); });

// ============================================================
// Chrome 版本检测
// ============================================================

function detectChromeVersion() {
  const match = navigator.userAgent.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
  if (match) {
    const version = match[1];
    const major = parseInt(version.split('.')[0], 10);
    chromeVersionEl.textContent = `Chrome 版本：${version} (支持 Side Panel API)`;
    if (major < 114) {
      chromeVersionEl.textContent += ' - 注意：Side Panel API 需要 Chrome 114+';
      chromeVersionEl.style.color = 'var(--danger)';
    }
  } else {
    chromeVersionEl.textContent = '无法检测 Chrome 版本';
  }
}

// ============================================================
// 脚本生成（备用方案）
// ============================================================

async function detectPlatform() {
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'windows';
  return 'unix';
}

function generateWindowsScript(savePath) {
  const relativePathTemplate = savePath ? `${savePath}\\%TODAY%` : '%TODAY%';
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
    for /f %%I in ('%PS_CMD% -NoProfile -Command "(Get-Date).ToString(''yyyy-MM-dd'')" 2^>nul') do set "TODAY=%%I"
)
if not defined TODAY (
    for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul') do set datetime=%%I
    if defined datetime set "TODAY=%datetime:~0,4%-%datetime:~4,2%-%datetime:~6,2%"
)
if not defined TODAY (
    echo [警告] 无法自动获取日期，请手动输入（格式：YYYY-MM-DD）
    set /p "TODAY=请输入日期："
)
if not defined TODAY (echo [错误] 日期不能为空 & pause & exit /b 1)
set "ZIP_FILE=network-capture-%TODAY%.zip"
set "SOURCE_DIR=%USERPROFILE%\\Downloads\\${relativePathTemplate}"
if not exist "%SOURCE_DIR%" (echo [错误] 文件夹不存在：%SOURCE_DIR% & pause & exit /b 1)
if defined PS_CMD (
    %PS_CMD% -NoProfile -Command "Compress-Archive -Path '%SOURCE_DIR%' -DestinationPath '%ZIP_FILE%' -Force" > nul 2>&1
)
explorer /select,"%ZIP_FILE%"
timeout /t 2 > nul
`;
}

function generateUnixScript(savePath) {
  const relativePathTemplate = savePath ? `${savePath}/\${TODAY}` : '${TODAY}';
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
if command -v zip > /dev/null 2>&1; then
  zip -r "$ZIP_FILE" "$SOURCE_BASENAME" > /dev/null 2>&1 && COMPRESS_OK=1
fi
if [ "$COMPRESS_OK" -ne 1 ] && command -v ditto > /dev/null 2>&1; then
  ditto -c -k --keepParent "$SOURCE_BASENAME" "$ZIP_FILE" > /dev/null 2>&1 && COMPRESS_OK=1
fi
if [ "$COMPRESS_OK" -ne 1 ]; then echo "[错误] 压缩失败"; exit 1; fi
if command -v open > /dev/null 2>&1; then open -R "$ZIP_FILE"; fi
`;
}

downloadScriptBtn.addEventListener('click', async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (!res?.ok) throw new Error(res?.error || '获取配置失败');
    const { settings } = res.payload;
    const platform = await detectPlatform();
    const savePath = settings.save_path || '';
    let scriptContent, scriptFilename;
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
      url: scriptUrl, filename: scriptFilename,
      saveAs: false, conflictAction: 'uniquify'
    });
    setTimeout(() => URL.revokeObjectURL(scriptUrl), 1000);
    setMessage(`已下载压缩脚本：${scriptFilename}（每天通用，无需重复下载）`, false);
  } catch (error) {
    setMessage(error.message, true);
  }
});

// ============================================================
// ZIP 打包功能
// ============================================================

function normalizePath(path) {
  if (!path) return '';
  return path.replace(/\\/g, '/');
}

function extractFilename(fullPath) {
  if (!fullPath) return '';
  const normalized = normalizePath(fullPath);
  const parts = normalized.split('/');
  return parts[parts.length - 1] || '';
}

function isCaptureFile(filename) {
  if (!filename) return false;
  const basename = extractFilename(filename);
  if (!basename.match(/\.json$/i)) return false;
  if (!basename.match(/^\d{6}_[a-z]+_/)) return false;
  return true;
}

async function packTodayData() {
  const btn = document.getElementById('packTodayBtn');
  const progressCard = document.getElementById('packProgress');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const progressCount = document.getElementById('progressCount');
  const progressTime  = document.getElementById('progressTime');
  if (!btn) return;

  const startTime = Date.now();
  btn.disabled = true;
  progressCard.style.display = 'block';
  progressFill.style.width = '0%';
  progressFill.classList.remove('error');
  progressText.textContent = '请选择包含捕获数据的文件夹...';

  try {
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
        if (files.length === 0) throw new Error('该文件夹中没有捕获数据文件');
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
    btn.disabled = false;
  }
}

async function processFilesForZip(files, progressFill, progressText, progressCount, progressTime, startTime) {
  const JSZip = (window.JZip || window.JSZip);
  if (!JSZip) throw new Error('JSZip 库未加载，请刷新页面重试');

  const zip = new JSZip();
  const today = new Date().toISOString().split('T')[0];
  let successCount = 0;
  let failCount = 0;

  progressText.textContent = `找到 ${files.length} 个文件，正在读取...`;

  const batchSize = 50;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, Math.min(i + batchSize, files.length));
    for (const item of batch) {
      try {
        const file = await item.handle.getFile();
        const content = await file.text();
        zip.file(item.name, content);
        successCount++;
      } catch (err) {
        console.error('Failed to read file:', item.name, err);
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
  try {
    await chrome.downloads.download({
      url: zipUrl,
      filename: `network-capture-${today}.zip`,
      saveAs: true
    });
  } finally {
    URL.revokeObjectURL(zipUrl);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const sizeKB  = (zipBlob.size / 1024).toFixed(0);
  progressText.innerHTML = `✅ 打包完成！<br>成功：${successCount} | 失败：${failCount}<br>ZIP 大小：${sizeKB} KB | 耗时：${elapsed}s`;
  progressTime.textContent = elapsed + 's';
}

if (packTodayBtn) {
  packTodayBtn.addEventListener('click', packTodayData);
}

// ============================================================
// 初始化
// ============================================================

detectChromeVersion();
requestState().catch((error) => setMessage(error.message, true));

// Side Panel 轮询（2 秒）
setInterval(() => {
  requestState().catch(() => {});
}, 2000);
