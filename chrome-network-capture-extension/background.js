/*
 * 后台 Service Worker
 * 负责：
 * 1) 监听 webRequest 获取网络元数据
 * 2) 接收 content script 上报的 fetch/XHR body
 * 3) 统一做 URL 规则过滤（支持多规则 OR 逻辑）
 * 4) 维护实时统计信息
 * 5) 将匹配请求实时保存为单条 JSON
 */

const MAX_URL_RULES = 20;

const DEFAULT_SETTINGS = {
  capture_enabled: false,
  // 新结构：规则数组，每项结构为 { id, pattern, enabled, methods }
  // methods 为可选数组，包含要匹配的 HTTP 方法（不填则匹配所有方法）
  url_filter_rules: [],
  save_path: '',
  capture_request_data: true,
  capture_response_data: true,
  capture_performance_data: false,
  max_body_length: 20_000_000 // 默认 20MB (约 2000万字符)
};

const DEFAULT_STATS = {
  total_requests: 0,
  matched_requests: 0,
  captured_requests: 0,
  error_count: 0,
  last_capture_time: null,
  last_export_time: null,
  last_error: ''
};

const STORAGE_KEYS = {
  SETTINGS: 'settings',
  CAPTURE_DATA: 'capture_data',
  STATS: 'capture_stats'
};

// 限制 body 长度，防止扩展内存过高
const MAX_BODY_LENGTH = 200_000;
// 只保留最近 N 条，避免 local storage 被写满
const MAX_RECORDS = 1500;
// 写入 storage.local 时仅持久化最近少量摘要，避免触发配额导致设置无法保存
const MAX_PERSISTED_RECORDS = 120;
const REALTIME_SAVE_DELAY_MS = 2500;

let settings = { ...DEFAULT_SETTINGS };
let stats = { ...DEFAULT_STATS };
let records = [];
// 编译后的有效规则列表，仅包含启用且正则语法正确的规则
let compiledRegexRules = [];

// requestId -> recordIndex
const requestIndexById = new Map();
// requestId -> { startTime, tabId, url, method }
const requestMetaById = new Map();
// key(tab|method|url) -> [recordIndex...]
const mergeCandidatesByKey = new Map();
const pendingRecordSaveTimers = new Map();
const savedRecordIds = new Set();

function logInfo(...args) {
  console.info('[NetworkCapture]', ...args);
}

function logWarn(...args) {
  console.warn('[NetworkCapture]', ...args);
}

function logError(...args) {
  console.error('[NetworkCapture]', ...args);
}

function nowIso() {
  return new Date().toISOString();
}

function createRuleId() {
  // MV3 环境可用 crypto.randomUUID；降级时使用时间戳+随机串
  if (globalThis.crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeUrlRules(rawRules, legacyRegex = '') {
  const source = Array.isArray(rawRules) ? rawRules : [];

  // 支持的所有 HTTP 方法（大写）
  const VALID_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];

  const normalized = source
    .map((rule) => {
      const pattern = String(rule?.pattern || '').trim();
      if (!pattern) {
        return null;
      }

      // 处理 methods 字段：确保是数组且只包含有效方法
      let methods = [];
      if (Array.isArray(rule?.methods) && rule.methods.length > 0) {
        methods = rule.methods
          .map(m => String(m || '').toUpperCase().trim())
          .filter(m => VALID_METHODS.includes(m));
        // 去重
        methods = [...new Set(methods)];
      }

      return {
        id: String(rule?.id || createRuleId()),
        pattern,
        enabled: rule?.enabled !== false,
        methods: methods.length > 0 ? methods : null
      };
    })
    .filter(Boolean)
    .slice(0, MAX_URL_RULES);

  // 向后兼容：如果新结构为空但存在旧字段 url_filter_regex，则迁移为一条启用规则
  if (normalized.length === 0 && typeof legacyRegex === 'string' && legacyRegex.trim()) {
    normalized.push({
      id: createRuleId(),
      pattern: legacyRegex.trim(),
      enabled: true,
      methods: null
    });
    logInfo('检测到旧字段 url_filter_regex，已自动迁移到 url_filter_rules。');
  }

  return normalized;
}

function sanitizeSettings(raw = {}) {
  const safe = {
    ...DEFAULT_SETTINGS,
    capture_enabled: Boolean(raw.capture_enabled),
    save_path: sanitizeSavePath(raw.save_path),
    capture_request_data:
      raw.capture_request_data === undefined
        ? DEFAULT_SETTINGS.capture_request_data
        : Boolean(raw.capture_request_data),
    capture_response_data:
      raw.capture_response_data === undefined
        ? DEFAULT_SETTINGS.capture_response_data
        : Boolean(raw.capture_response_data),
    capture_performance_data:
      raw.capture_performance_data === undefined
        ? DEFAULT_SETTINGS.capture_performance_data
        : Boolean(raw.capture_performance_data),
    max_body_length:
      raw.max_body_length === undefined
        ? DEFAULT_SETTINGS.max_body_length
        : Number(raw.max_body_length) || DEFAULT_SETTINGS.max_body_length
  };

  safe.url_filter_rules = normalizeUrlRules(raw.url_filter_rules, raw.url_filter_regex);
  return safe;
}

function clampText(value, max = null) {
  const limit = typeof max === 'number' ? max : settings.max_body_length;
  if (typeof value !== 'string') {
    return value;
  }
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n...<TRUNCATED ${value.length - limit} chars>`;
}

function normalizeUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    // 为了更稳定匹配，去掉 hash
    url.hash = '';
    return url.toString();
  } catch {
    // 非标准 URL（如 data:）直接去掉 hash 部分
    return String(rawUrl).split('#')[0];
  }
}

function buildKey(tabId, method, rawUrl) {
  return `${tabId}|${String(method || 'GET').toUpperCase()}|${normalizeUrl(rawUrl)}`;
}

function compileFilterRegex(rules) {
  compiledRegexRules = [];

  const invalidMessages = [];

  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule?.enabled) {
      continue;
    }

    const pattern = String(rule.pattern || '').trim();
    if (!pattern) {
      continue;
    }

    try {
      compiledRegexRules.push({
        id: String(rule.id || createRuleId()),
        pattern,
        regex: new RegExp(pattern),
        // 保存 methods 数组，null 表示匹配所有方法
        methods: Array.isArray(rule.methods) && rule.methods.length > 0 ? rule.methods : null
      });
    } catch (error) {
      invalidMessages.push(`规则「${pattern}」无效: ${error.message}`);
    }
  }

  if (invalidMessages.length > 0) {
    stats.last_error = invalidMessages.join(' | ');
    logWarn('存在无效过滤规则，已跳过：', invalidMessages);
  } else {
    stats.last_error = '';
  }

  logInfo(
    `过滤规则编译完成。总规则=${Array.isArray(rules) ? rules.length : 0}，启用且有效=${compiledRegexRules.length}`
  );

  return invalidMessages.length === 0;
}

function getUrlMatchMeta(rawUrl, method = 'GET') {
  // 当没有"启用且有效"的规则时，默认不过滤（全量捕获）
  if (compiledRegexRules.length === 0) {
    return {
      matched: true,
      mode: 'all',
      rule_pattern: '',
      methods: null
    };
  }

  try {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const matchedRule = compiledRegexRules.find((item) => {
      // 首先检查 URL 是否匹配
      if (!item.regex.test(rawUrl)) {
        return false;
      }
      // 如果规则指定了 methods，检查 HTTP 方法是否匹配
      if (item.methods && !item.methods.includes(normalizedMethod)) {
        return false;
      }
      return true;
    });

    if (!matchedRule) {
      return {
        matched: false,
        mode: 'rule',
        rule_pattern: '',
        methods: null
      };
    }

    return {
      matched: true,
      mode: 'rule',
      rule_pattern: matchedRule.pattern,
      methods: matchedRule.methods
    };
  } catch {
    return {
      matched: false,
      mode: 'rule',
      rule_pattern: '',
      methods: null
    };
  }
}

function sanitizeSavePath(path) {
  if (!path) {
    return '';
  }

  // downloads.filename 只能是下载目录下的相对路径
  // 统一分隔符并过滤非法字符，防止写到意外位置
  const cleaned = String(path)
    .replace(/\\/g, '/')
    .replace(/[:*?"<>|]/g, '_')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.{2,}/g, '_')
    .trim();

  return cleaned.replace(/\/+$/, '');
}

function toJsonDataUrl(payload) {
  const jsonString = JSON.stringify(payload, null, 2);
  const bytes = new TextEncoder().encode(jsonString);

  // Service Worker 环境不保证 URL.createObjectURL 可用，使用 base64 data URL 最稳妥
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  if (typeof btoa === 'function') {
    const base64 = btoa(binary);
    return `data:application/json;base64,${base64}`;
  }

  // 极少数环境的兜底方案
  return `data:application/json;charset=utf-8,${encodeURIComponent(jsonString)}`;
}

function sanitizeFilenameSegment(input, maxLen = 42) {
  const cleaned = String(input || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!cleaned) {
    return 'na';
  }

  return cleaned.slice(0, maxLen);
}

function getUrlFileHint(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = sanitizeFilenameSegment(url.hostname, 28);
    const path = sanitizeFilenameSegment(url.pathname.replace(/\//g, '_'), 28);
    return `${host}_${path || 'root'}`;
  } catch {
    return sanitizeFilenameSegment(rawUrl, 44);
  }
}

function resolveCapturedUrl(rawUrl, sender) {
  const value = String(rawUrl || '').trim();
  if (!value) {
    return '';
  }

  try {
    return new URL(value).toString();
  } catch {
    // ignore
  }

  const baseCandidates = [sender?.url, sender?.tab?.url];
  for (const base of baseCandidates) {
    if (!base) {
      continue;
    }

    try {
      return new URL(value, base).toString();
    } catch {
      // try next base
    }
  }

  return value;
}

function buildRealtimeRecordFileName(record) {
  const createdAt = new Date(record?.created_at || Date.now());
  const timestamp = Number.isNaN(createdAt.getTime())
    ? formatTimestampForFile(new Date())
    : formatTimestampForFile(createdAt);

  const savePath = sanitizeSavePath(settings.save_path);
  const method = sanitizeFilenameSegment(record?.request?.method || 'GET', 10).toLowerCase();
  const urlHint = getUrlFileHint(record?.request?.url || '');
  const ruleRaw = record?.match?.mode === 'rule' ? record?.match?.rule_pattern : 'all';
  const ruleHint = sanitizeFilenameSegment(ruleRaw || 'all', 28);
  const status = sanitizeFilenameSegment(String(record?.response?.status_code ?? 'na'), 8);
  const shortId = sanitizeFilenameSegment(String(record?.id || '').slice(-8), 12);

  const fileName = `${timestamp}_${method}_${urlHint}_${ruleHint}_${status}_${shortId}.json`;
  return savePath ? `${savePath}/${fileName}` : fileName;
}

function toPersistedRecord(record) {
  // 持久化时保留完整的 request/response body 数据
  // 这样导出时不会丢失 response_body
  return {
    id: record.id,
    created_at: record.created_at,
    source: Array.isArray(record.source) ? record.source : [],
    match: record.match || { mode: 'all', rule_pattern: '' },
    request: {
      request_id: record.request?.request_id || '',
      tab_id: record.request?.tab_id ?? -1,
      url: record.request?.url || '',
      normalized_url: record.request?.normalized_url || '',
      method: record.request?.method || '',
      type: record.request?.type || '',
      initiator: record.request?.initiator || '',
      request_headers: record.request?.request_headers || null,
      request_body: record.request?.request_body || null
    },
    response: {
      status_code: record.response?.status_code ?? null,
      status_line: record.response?.status_line || '',
      response_headers: record.response?.response_headers || null,
      response_body: record.response?.response_body || null
    },
    performance: {
      start_time: record.performance?.start_time ?? null,
      end_time: record.performance?.end_time ?? null,
      duration_ms: record.performance?.duration_ms ?? null,
      from_cache: Boolean(record.performance?.from_cache),
      source: record.performance?.source || 'webRequest'
    },
    errors: Array.isArray(record.errors) ? record.errors.slice(0, 3) : []
  };
}

function shouldSaveRealtimeRecord(record) {
  if (!settings.capture_response_data) {
    return true;
  }

  const responseBody = record?.response?.response_body;
  return responseBody !== null && responseBody !== undefined;
}

async function saveRecordAsRealtimeFile(record) {
  const payload = {
    saved_at: nowIso(),
    mode: 'realtime-single-record',
    settings_snapshot: settings,
    record
  };

  const fileName = buildRealtimeRecordFileName(record);
  const dataUrl = toJsonDataUrl(payload);
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: fileName,
    conflictAction: 'uniquify',
    saveAs: false
  });

  if (!Number.isInteger(downloadId) || downloadId <= 0) {
    throw new Error('chrome.downloads.download 未返回有效任务 ID');
  }
}

function queueRealtimeSave(record, options = {}) {
  const forceReschedule = Boolean(options.forceReschedule);

  if (!record?.id || savedRecordIds.has(record.id)) {
    return;
  }

  if (pendingRecordSaveTimers.has(record.id) && !forceReschedule) {
    return;
  }

  if (pendingRecordSaveTimers.has(record.id) && forceReschedule) {
    clearTimeout(pendingRecordSaveTimers.get(record.id));
    pendingRecordSaveTimers.delete(record.id);
  }

  const timerId = setTimeout(() => {
    pendingRecordSaveTimers.delete(record.id);

    if (!shouldSaveRealtimeRecord(record)) {
      return;
    }

    saveRecordAsRealtimeFile(record)
      .then(async () => {
        savedRecordIds.add(record.id);
        stats.last_error = '';
        await persistData();
        broadcastState();
      })
      .catch(async (error) => {
        stats.error_count += 1;
        stats.last_error = `实时保存失败: ${error.message}`;
        logError(stats.last_error);
        await persistData();
        broadcastState();
      });
  }, REALTIME_SAVE_DELAY_MS);

  pendingRecordSaveTimers.set(record.id, timerId);
}

function formatTimestampForFile(date = new Date()) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

function parseRequestBody(requestBody) {
  if (!requestBody) {
    return null;
  }

  try {
    if (requestBody.formData) {
      return {
        type: 'formData',
        value: requestBody.formData
      };
    }

    if (Array.isArray(requestBody.raw) && requestBody.raw.length > 0) {
      const bytes = requestBody.raw[0]?.bytes;
      if (bytes) {
        const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        return {
          type: 'raw',
          value: clampText(decoded)
        };
      }

      return {
        type: 'raw',
        value: '[binary body]'
      };
    }
  } catch (error) {
    return {
      type: 'unknown',
      value: `解析请求体失败: ${error.message}`
    };
  }

  return null;
}

function createBaseRecord(details, matchMeta = { mode: 'all', rule_pattern: '' }) {
  return {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    created_at: nowIso(),
    source: ['webRequest'],
    match: {
      mode: matchMeta.mode === 'rule' ? 'rule' : 'all',
      rule_pattern: String(matchMeta.rule_pattern || '')
    },
    request: {
      request_id: details.requestId,
      tab_id: details.tabId,
      url: details.url,
      normalized_url: normalizeUrl(details.url),
      method: details.method,
      type: details.type,
      initiator: details.initiator || '',
      request_headers: null,
      request_body: null
    },
    response: {
      status_code: null,
      status_line: '',
      response_headers: null,
      response_body: null
    },
    performance: {
      start_time: details.timeStamp || null,
      end_time: null,
      duration_ms: null,
      from_cache: false,
      source: 'webRequest'
    },
    errors: []
  };
}

function pushRecord(record) {
  records.push(record);
  if (records.length > MAX_RECORDS) {
    const removeCount = records.length - MAX_RECORDS;
    records = records.slice(removeCount);

    // records 裁剪后，索引整体左移，需要同步修正内部映射
    for (const [requestId, index] of requestIndexById.entries()) {
      const nextIndex = index - removeCount;
      if (nextIndex < 0 || nextIndex >= records.length) {
        requestIndexById.delete(requestId);
        requestMetaById.delete(requestId);
      } else {
        requestIndexById.set(requestId, nextIndex);
      }
    }

    for (const [key, indexList] of mergeCandidatesByKey.entries()) {
      const nextList = indexList
        .map((idx) => idx - removeCount)
        .filter((idx) => idx >= 0 && idx < records.length);
      if (nextList.length === 0) {
        mergeCandidatesByKey.delete(key);
      } else {
        mergeCandidatesByKey.set(key, nextList);
      }
    }
  }
  stats.captured_requests = records.length;
  stats.last_capture_time = nowIso();
}

function updateBadge() {
  const enabled = settings.capture_enabled;
  chrome.action.setBadgeBackgroundColor({ color: enabled ? '#0f9d58' : '#9e9e9e' });
  chrome.action.setBadgeText({ text: enabled ? 'ON' : 'OFF' });
}

function isInjectableTabUrl(url) {
  return typeof url === 'string' && /^(https?:|file:|ftp:)/i.test(url);
}

async function reinjectContentScripts() {
  // 只在捕获开启时注入
  if (!settings.capture_enabled) {
    return;
  }

  try {
    const tabs = await chrome.tabs.query({});
    const targets = tabs.filter((tab) => Number.isInteger(tab.id) && isInjectableTabUrl(tab.url));

    for (const tab of targets) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content/content.js']
        });
      } catch (error) {
        // 忽略单个 tab 注入失败（如受限页面）
        logWarn(`重注入 content script 失败 (tab=${tab.id}): ${error.message}`);
      }
    }

    if (targets.length > 0) {
      logInfo(`已尝试重注入 content script 到 ${targets.length} 个标签页`);
    }
  } catch (error) {
    logWarn(`重注入 content script 失败: ${error.message}`);
  }
}

function getStatePayload() {
  return {
    settings,
    stats,
    record_count: records.length,
    // 提供当前生效规则数，避免 popup/options 重复计算
    active_rule_count: compiledRegexRules.length,
    recent_records: records.slice(-5).reverse()
  };
}

function broadcastState() {
  chrome.runtime
    .sendMessage({ type: 'STATE_UPDATED', payload: getStatePayload() })
    .catch(() => {
      // popup/options 未打开时会抛异常，这里忽略即可
    });
}

async function persistData() {
  try {
    const persistedRecords = records
      .slice(-MAX_PERSISTED_RECORDS)
      .map((record) => toPersistedRecord(record));

    await chrome.storage.local.set({
      [STORAGE_KEYS.CAPTURE_DATA]: persistedRecords,
      [STORAGE_KEYS.STATS]: stats
    });
  } catch (error) {
    stats.last_error = `保存捕获数据失败: ${error.message}`;
    logError(stats.last_error);
  }
}

async function loadData() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.CAPTURE_DATA,
    STORAGE_KEYS.STATS
  ]);

  settings = sanitizeSettings(data[STORAGE_KEYS.SETTINGS] || {});
  stats = { ...DEFAULT_STATS, ...(data[STORAGE_KEYS.STATS] || {}) };
  records = Array.isArray(data[STORAGE_KEYS.CAPTURE_DATA]) ? data[STORAGE_KEYS.CAPTURE_DATA] : [];

  compileFilterRegex(settings.url_filter_rules);
  updateBadge();
  logInfo('加载配置完成：', {
    capture_enabled: settings.capture_enabled,
    rule_count: settings.url_filter_rules.length,
    save_path: settings.save_path
  });
}

async function saveSettings(nextSettings) {
  settings = sanitizeSettings(nextSettings || {});

  compileFilterRegex(settings.url_filter_rules);

  await chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: settings
  });

  if (settings.capture_enabled) {
    await reinjectContentScripts();
  }

  updateBadge();
  broadcastState();

  logInfo('设置已保存到 storage.local：', {
    capture_enabled: settings.capture_enabled,
    rule_count: settings.url_filter_rules.length,
    save_path: settings.save_path
  });
}

async function setCaptureEnabled(enabled) {
  settings.capture_enabled = Boolean(enabled);

  await chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: settings
  });

  if (settings.capture_enabled) {
    await reinjectContentScripts();
  }

  updateBadge();
  broadcastState();
}

function pruneCandidateIndexes(indexes) {
  // 清除失效索引（例如 records 裁剪后）
  return indexes.filter((idx) => idx >= 0 && idx < records.length);
}

function addMergeCandidate(tabId, method, url, index) {
  const key = buildKey(tabId, method, url);
  const list = mergeCandidatesByKey.get(key) || [];
  list.push(index);
  mergeCandidatesByKey.set(key, pruneCandidateIndexes(list).slice(-20));
}

function findBestMergeCandidate(tabId, method, url) {
  // 策略1: 精确匹配 (tabId + method + normalized URL)
  const exactKey = buildKey(tabId, method, url);
  const exactList = pruneCandidateIndexes(mergeCandidatesByKey.get(exactKey) || []);
  mergeCandidatesByKey.set(exactKey, exactList);

  for (let i = exactList.length - 1; i >= 0; i -= 1) {
    const idx = exactList[i];
    const record = records[idx];
    if (!record) {
      continue;
    }
    // 首选：没有 response_body 的记录（可以填充）
    if (!record.response.response_body) {
      logInfo(`精确匹配成功 (tabId=${tabId})，找到候选 idx=${idx}`);
      return idx;
    }
  }

  // 如果精确匹配有结果但都有 body，返回最近的
  if (exactList.length > 0) {
    const idx = exactList[exactList.length - 1];
    if (idx >= 0 && idx < records.length) {
      logInfo(`精确匹配成功但已有 body，使用最近的 idx=${idx}`);
      return idx;
    }
  }

  // 策略2: 宽松匹配 (忽略 tabId，只匹配 method + URL)
  // 处理 content script tabId 为 -1 或不匹配的情况
  const normalizedUrl = normalizeUrl(url);
  const now = Date.now();
  const timeWindowMs = 10000; // 10秒时间窗口

  // 在最近的记录中查找相同 method 和 URL 的记录
  for (let i = records.length - 1; i >= Math.max(0, records.length - 100); i -= 1) {
    const record = records[i];
    if (!record) {
      continue;
    }

    // 检查是否在时间窗口内
    const recordTime = new Date(record.created_at).getTime();
    if (now - recordTime > timeWindowMs) {
      continue; // 超过时间窗口
    }

    // 匹配 method 和 normalized URL
    if (record.request?.method === method &&
        record.request?.normalized_url === normalizedUrl) {
      // 优先选择没有 response_body 的记录
      if (!record.response.response_body) {
        logInfo(`宽松匹配成功 (忽略 tabId)，找到候选 idx=${i}, record.tabId=${record.request?.tab_id}, search.tabId=${tabId}`);
        return i;
      }
    }
  }

  logWarn(`未找到任何匹配记录 (tabId=${tabId}, method=${method}, url=${url?.substring(0, 50)}...)`);

  return null;
}

async function clearCaptureData() {
  records = [];
  stats = { ...DEFAULT_STATS };
  requestIndexById.clear();
  requestMetaById.clear();
  mergeCandidatesByKey.clear();
  for (const timerId of pendingRecordSaveTimers.values()) {
    clearTimeout(timerId);
  }
  pendingRecordSaveTimers.clear();
  savedRecordIds.clear();
  await persistData();
  broadcastState();
}

async function exportCaptureData() {
  try {
    const timestamp = formatTimestampForFile(new Date());
    const baseName = `network_capture_${timestamp}.json`;
    const savePath = sanitizeSavePath(settings.save_path);
    const fileName = savePath ? `${savePath}/${baseName}` : baseName;

    const payload = {
      exported_at: nowIso(),
      settings_snapshot: settings,
      stats_snapshot: stats,
      total_records: records.length,
      records
    };

    const dataUrl = toJsonDataUrl(payload);

    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: fileName,
      conflictAction: 'uniquify',
      saveAs: false
    });

    if (!Number.isInteger(downloadId) || downloadId <= 0) {
      throw new Error('chrome.downloads.download 未返回有效任务 ID');
    }

    stats.last_export_time = nowIso();
    stats.last_error = '';
    await persistData();
    broadcastState();

    return { ok: true, file_name: fileName };
  } catch (error) {
    stats.error_count += 1;
    stats.last_error = `导出失败: ${error.message}`;
    await persistData();
    broadcastState();
    return { ok: false, error: stats.last_error };
  }
}

function safeHeaderArray(headers) {
  if (!Array.isArray(headers)) {
    return null;
  }
  return headers.map((h) => ({ name: h.name, value: h.value ?? '' }));
}

function handleWebRequestBefore(details) {
  if (!settings.capture_enabled) {
    return;
  }

  stats.total_requests += 1;

  const matchMeta = getUrlMatchMeta(details.url, details.method);
  if (!matchMeta.matched) {
    return;
  }

  stats.matched_requests += 1;

  const record = createBaseRecord(details, matchMeta);

  if (settings.capture_request_data) {
    record.request.request_body = parseRequestBody(details.requestBody);
  }

  const index = records.length;
  pushRecord(record);

  requestIndexById.set(details.requestId, index);
  requestMetaById.set(details.requestId, {
    startTime: details.timeStamp,
    tabId: details.tabId,
    method: details.method,
    url: details.url
  });

  addMergeCandidate(details.tabId, details.method, details.url, index);
}

function handleWebRequestSendHeaders(details) {
  const idx = requestIndexById.get(details.requestId);
  if (idx === undefined) {
    return;
  }

  const record = records[idx];
  if (!record) {
    return;
  }

  if (settings.capture_request_data) {
    record.request.request_headers = safeHeaderArray(details.requestHeaders);
  }
}

function handleWebRequestHeaders(details) {
  const idx = requestIndexById.get(details.requestId);
  if (idx === undefined) {
    return;
  }

  const record = records[idx];
  if (!record) {
    return;
  }

  record.response.status_code = details.statusCode ?? record.response.status_code;
  record.response.status_line = details.statusLine || record.response.status_line;

  if (settings.capture_response_data) {
    record.response.response_headers = safeHeaderArray(details.responseHeaders);
  }
}

function finalizeRequest(details, requestError = '') {
  const idx = requestIndexById.get(details.requestId);
  if (idx === undefined) {
    return;
  }

  const record = records[idx];
  const meta = requestMetaById.get(details.requestId);
  if (!record || !meta) {
    requestIndexById.delete(details.requestId);
    requestMetaById.delete(details.requestId);
    return;
  }

  const endTime = details.timeStamp || Date.now();
  record.performance.end_time = endTime;

  if (settings.capture_performance_data && meta.startTime) {
    record.performance.duration_ms = Number((endTime - meta.startTime).toFixed(2));
  }

  record.performance.from_cache = Boolean(details.fromCache);

  if (requestError) {
    record.errors.push(requestError);
    stats.error_count += 1;
    stats.last_error = requestError;
  }

  queueRealtimeSave(record);

  requestIndexById.delete(details.requestId);
  requestMetaById.delete(details.requestId);
}

function mergeContentCapture(data, sender) {
  if (!settings.capture_enabled) {
    return;
  }

  const method = String(data.method || 'GET').toUpperCase();
  const resolvedUrl = resolveCapturedUrl(data.url, sender);
  const matchMeta = getUrlMatchMeta(resolvedUrl, method);
  if (!matchMeta.matched) {
    return;
  }

  const tabId = sender?.tab?.id ?? data.tabId ?? -1;
  const idx = findBestMergeCandidate(tabId, method, resolvedUrl);

  const responseBody = clampText(data.responseBody || '');
  const requestBody = clampText(data.requestBody || '');

  // 调试日志：记录合并尝试
  const mergeKey = buildKey(tabId, method, resolvedUrl);
  logInfo(`收到 Content Script 事件: ${data.channel || 'unknown'} ${method} ${resolvedUrl?.substring(0, 60)}... (tabId: ${tabId}, mergeKey: ${mergeKey.slice(0, 50)}...)`);

  if (idx !== null && idx !== undefined) {
    const record = records[idx];
    if (!record) {
      logWarn(`找到无效索引 idx=${idx}，跳过合并`);
      return;
    }

    logInfo(`成功匹配到 webRequest 记录 (idx=${idx})，开始合并`);

    if (!record.match) {
      record.match = {
        mode: matchMeta.mode,
        rule_pattern: matchMeta.rule_pattern
      };
    }

    if (!record.source.includes('contentScript')) {
      record.source.push('contentScript');
    }

    if (settings.capture_response_data) {
      record.response.response_body = responseBody;
      logInfo(`已合并 response_body (${responseBody.length} chars)`);
    }

    if (settings.capture_request_data && requestBody && !record.request.request_body) {
      record.request.request_body = {
        type: 'injected',
        value: requestBody
      };
    }

    if (typeof data.status === 'number') {
      record.response.status_code = record.response.status_code ?? data.status;
    }

    if (settings.capture_performance_data && typeof data.durationMs === 'number') {
      record.performance.duration_ms = Number(data.durationMs.toFixed(2));
      record.performance.source = 'contentScript';
    }

    stats.last_capture_time = nowIso();
    // 内容脚本补齐了 body 后，延后保存，优先写入包含 responseBody 的版本
    queueRealtimeSave(record, { forceReschedule: true });
    return;
  }

  logWarn(`未找到匹配的 webRequest 记录 (tabId: ${tabId}, method: ${method})，创建独立记录`);

  // 没匹配到 webRequest 元数据时，也保留 content script 侧抓取结果
  stats.matched_requests += 1;

  const record = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    created_at: nowIso(),
    source: ['contentScript'],
    match: {
      mode: matchMeta.mode,
      rule_pattern: matchMeta.rule_pattern
    },
    request: {
      request_id: '',
      tab_id: tabId,
      url: resolvedUrl,
      normalized_url: normalizeUrl(resolvedUrl),
      method,
      type: 'unknown',
      initiator: sender?.url || '',
      request_headers: null,
      request_body: settings.capture_request_data
        ? {
            type: 'injected',
            value: requestBody || null
          }
        : null
    },
    response: {
      status_code: typeof data.status === 'number' ? data.status : null,
      status_line: '',
      response_headers: null,
      response_body: settings.capture_response_data ? responseBody : null
    },
    performance: {
      start_time: null,
      end_time: null,
      duration_ms:
        settings.capture_performance_data && typeof data.durationMs === 'number'
          ? Number(data.durationMs.toFixed(2))
          : null,
      from_cache: false,
      source: 'contentScript'
    },
    errors: []
  };

  pushRecord(record);
  queueRealtimeSave(record);
}

async function init() {
  await loadData();
  // 启动时将旧版大体积 capture_data 迁移为轻量摘要，避免 storage 配额占满
  await persistData();
  if (settings.capture_enabled) {
    await reinjectContentScripts();
  }
  broadcastState();
}

chrome.runtime.onInstalled.addListener(async () => {
  await loadData();
  // 首次安装或升级时，确保默认配置存在
  await chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: settings
  });
  updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await init();
});

init().catch((error) => {
  stats.last_error = `初始化失败: ${error.message}`;
  logError(stats.last_error);
});

// tabs 监听：动态注入 content scripts（仅在捕获开启时）
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // 只在页面加载完成时处理
  if (changeInfo.status !== 'complete' || !tab.url) {
    return;
  }

  // 只在捕获开启时注入
  if (!settings.capture_enabled) {
    return;
  }

  // 检查是否是可注入的 URL
  if (!isInjectableTabUrl(tab.url)) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content/content.js']
    });
    logInfo(`动态注入 content script 到 tab ${tabId}: ${tab.url}`);
  } catch (error) {
    // 忽略注入失败（如受限页面）
    logWarn(`动态注入 content script 失败 (tab=${tabId}): ${error.message}`);
  }
});

// webRequest 监听
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      handleWebRequestBefore(details);
      persistData();
      broadcastState();
    } catch (error) {
      stats.error_count += 1;
      stats.last_error = `onBeforeRequest 处理失败: ${error.message}`;
      logError(stats.last_error);
    }
  },
  { urls: ['<all_urls>'] },
  ['requestBody']
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      handleWebRequestSendHeaders(details);
      persistData();
    } catch (error) {
      stats.error_count += 1;
      stats.last_error = `onBeforeSendHeaders 处理失败: ${error.message}`;
      logError(stats.last_error);
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    try {
      handleWebRequestHeaders(details);
      persistData();
    } catch (error) {
      stats.error_count += 1;
      stats.last_error = `onHeadersReceived 处理失败: ${error.message}`;
      logError(stats.last_error);
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    try {
      finalizeRequest(details);
      persistData();
      broadcastState();
    } catch (error) {
      stats.error_count += 1;
      stats.last_error = `onCompleted 处理失败: ${error.message}`;
      logError(stats.last_error);
    }
  },
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    try {
      finalizeRequest(details, `请求失败: ${details.error || 'unknown'}`);
      persistData();
      broadcastState();
    } catch (error) {
      stats.error_count += 1;
      stats.last_error = `onErrorOccurred 处理失败: ${error.message}`;
      logError(stats.last_error);
    }
  },
  { urls: ['<all_urls>'] }
);

// 快捷键命令
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'capture-toggle') {
    await setCaptureEnabled(!settings.capture_enabled);
  }
});

// popup/options/content script 消息通道
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'GET_STATE': {
        sendResponse({ ok: true, payload: getStatePayload() });
        break;
      }

      case 'TOGGLE_CAPTURE': {
        await setCaptureEnabled(Boolean(message.enabled));
        await persistData();
        sendResponse({ ok: true, payload: getStatePayload() });
        break;
      }

      case 'EXPORT_CAPTURE': {
        sendResponse({ ok: false, error: '导出功能已移除，匹配请求会实时保存到下载目录。' });
        break;
      }

      case 'CLEAR_CAPTURE': {
        await clearCaptureData();
        sendResponse({ ok: true, payload: getStatePayload() });
        break;
      }

      case 'UPDATE_SETTINGS': {
        logInfo('收到 UPDATE_SETTINGS 消息，准备保存设置。', message.settings || {});
        const next = {
          ...settings,
          ...(message.settings || {})
        };
        await saveSettings(next);
        await persistData();
        sendResponse({ ok: true, payload: getStatePayload() });
        break;
      }

      case 'CONTENT_NETWORK_EVENT': {
        try {
          mergeContentCapture(message.payload || {}, sender);
          await persistData();
          broadcastState();
          sendResponse({ ok: true });
        } catch (error) {
          stats.error_count += 1;
          stats.last_error = `处理内容脚本数据失败: ${error.message}`;
          await persistData();
          sendResponse({ ok: false, error: stats.last_error });
        }
        break;
      }

      case 'INJECT_PAGE_SCRIPT': {
        // content script 请求重新注入页面脚本（备用方案）
        const tabId = sender?.tab?.id;
        if (!tabId) {
          sendResponse({ ok: false, error: '无效的 tab ID' });
          break;
        }

        try {
          logInfo(`收到 content script 请求，使用 chrome.scripting API 注入页面脚本到 tab ${tabId}`);

          // 使用 chrome.scripting.executeScript 注入页面脚本
          // 这是 Manifest V3 中绕过 CSP 的最可靠方式
          await chrome.scripting.executeScript({
            target: { tabId: tabId },
            world: 'MAIN', // 注入到主世界（与页面代码同一上下文）
            files: ['content/page-script.js']
          });

          logInfo(`页面脚本已成功注入到 tab ${tabId} (scripting API)`);
          sendResponse({ ok: true });
        } catch (error) {
          stats.error_count += 1;
          stats.last_error = `注入页面脚本失败: ${error.message}`;
          logError(stats.last_error);
          sendResponse({ ok: false, error: stats.last_error });
        }
        break;
      }

      case 'PING_CONTENT_SCRIPT': {
        // 检查 content script 状态
        sendResponse({ ok: true });
        break;
      }

      case 'PAGE_SCRIPT_INJECT_FAILED': {
        // 记录页面脚本注入失败的情况
        logWarn(`页面脚本注入失败: URL=${message.url}, 尝试次数=${message.attempts}`);
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: '未知消息类型' });
    }
  })().catch((error) => {
    stats.error_count += 1;
    stats.last_error = `消息处理失败: ${error.message}`;
    logError(stats.last_error);
    sendResponse({ ok: false, error: stats.last_error });
  });

  // 异步响应
  return true;
});
