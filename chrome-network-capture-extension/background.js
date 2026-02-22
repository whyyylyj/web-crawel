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
  // 排除规则：命中后直接忽略，不进入捕获
  url_exclude_rules: [],
  // 一键忽略常见静态资源请求
  ignore_static_resources: false,
  save_path: '',
  capture_request_data: true,
  capture_response_data: true,
  capture_performance_data: false,
  max_body_length: 20_000_000, // 默认 20MB (约 2000万字符)
  // 安全优化：默认不持久化 body 预览到 storage.local（避免敏感数据落盘）
  persist_body_preview: false,
  // 瀑布图最大保留条数（侧边栏内存池上限，可在设置页调整）
  waterfall_max_records: 50
};

const DEFAULT_STATS = {
  total_requests: 0,
  matched_requests: 0,
  captured_requests: 0,
  excluded_requests: 0,
  static_ignored_requests: 0,
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
// 等待 content script 回填 body 的最长时间，超时后仍会落盘避免永久丢失文件
const CONTENT_MERGE_MAX_WAIT_MS = 8000;
const BODY_PREVIEW_MAX_LENGTH = 12_000;
const STATIC_RESOURCE_EXT_RE =
  /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|mp4|mov|mp3|wav|pdf|zip)(?:[?#]|$)/i;
const STATIC_RESOURCE_TYPES = new Set([
  'image',
  'stylesheet',
  'script',
  'font',
  'media',
  'imageset',
  'object'
]);

let settings = { ...DEFAULT_SETTINGS };
let stats = { ...DEFAULT_STATS };
let records = [];
// 编译后的有效规则列表，仅包含启用且正则语法正确的规则
let compiledIncludeRules = [];
let compiledExcludeRules = [];

// requestId -> recordIndex
const requestIndexById = new Map();
// requestId -> { startTime, tabId, url, method }
const requestMetaById = new Map();
// key(tab|method|url) -> [recordIndex...]
const mergeCandidatesByKey = new Map();
const pendingRecordSaveTimers = new Map();
const savedRecordIds = new Set();

// 性能优化：防抖机制，避免频繁写入 storage
let persistScheduled = false;
let persistTimer = null;
const PERSIST_DEBOUNCE_MS = 2000;

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
    ignore_static_resources:
      raw.ignore_static_resources === undefined
        ? DEFAULT_SETTINGS.ignore_static_resources
        : Boolean(raw.ignore_static_resources),
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
        : Number(raw.max_body_length) || DEFAULT_SETTINGS.max_body_length,
    persist_body_preview:
      raw.persist_body_preview === undefined
        ? DEFAULT_SETTINGS.persist_body_preview
        : Boolean(raw.persist_body_preview),
    waterfall_max_records:
      raw.waterfall_max_records === undefined
        ? DEFAULT_SETTINGS.waterfall_max_records
        : Math.min(500, Math.max(10, Number(raw.waterfall_max_records) || DEFAULT_SETTINGS.waterfall_max_records))
  };

  safe.url_filter_rules = normalizeUrlRules(raw.url_filter_rules, raw.url_filter_regex);
  safe.url_exclude_rules = normalizeUrlRules(raw.url_exclude_rules);
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
  } catch (err) {
    // 非标准 URL（如 data:）直接去掉 hash 部分
    return String(rawUrl).split('#')[0];
  }
}

function buildKey(tabId, method, rawUrl) {
  return `${tabId}|${String(method || 'GET').toUpperCase()}|${normalizeUrl(rawUrl)}`;
}

function compileRuleSet(rules, invalidMessages, ruleTypeLabel) {
  const compiled = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule?.enabled) {
      continue;
    }

    const pattern = String(rule.pattern || '').trim();
    if (!pattern) {
      continue;
    }

    try {
      compiled.push({
        id: String(rule.id || createRuleId()),
        pattern,
        regex: new RegExp(pattern),
        // 保存 methods 数组，null 表示匹配所有方法
        methods: Array.isArray(rule.methods) && rule.methods.length > 0 ? rule.methods : null
      });
    } catch (error) {
      invalidMessages.push(`${ruleTypeLabel}规则「${pattern}」无效: ${error.message}`);
    }
  }
  return compiled;
}

function compileFilterRegex(includeRules, excludeRules = []) {
  const invalidMessages = [];
  compiledIncludeRules = compileRuleSet(includeRules, invalidMessages, '捕获');
  compiledExcludeRules = compileRuleSet(excludeRules, invalidMessages, '排除');

  if (invalidMessages.length > 0) {
    stats.last_error = invalidMessages.join(' | ');
    logWarn('存在无效过滤规则，已跳过：', invalidMessages);
  } else {
    stats.last_error = '';
  }

  logInfo(
    `过滤规则编译完成。包含规则=${compiledIncludeRules.length}，排除规则=${compiledExcludeRules.length}`
  );

  return invalidMessages.length === 0;
}

function isStaticResource(details = {}, rawUrl = '') {
  if (STATIC_RESOURCE_TYPES.has(String(details?.type || '').toLowerCase())) {
    return true;
  }
  return STATIC_RESOURCE_EXT_RE.test(String(rawUrl || ''));
}

function findMatchedRule(compiledRules, rawUrl, normalizedMethod) {
  return compiledRules.find((item) => {
    if (!item.regex.test(rawUrl)) {
      return false;
    }
    if (item.methods && !item.methods.includes(normalizedMethod)) {
      return false;
    }
    return true;
  });
}

function getUrlMatchMeta(rawUrl, method = 'GET', details = null) {
  const normalizedMethod = String(method || 'GET').toUpperCase();

  if (settings.ignore_static_resources && isStaticResource(details || {}, rawUrl)) {
    return {
      matched: false,
      mode: 'ignore-static',
      rule_pattern: '',
      methods: null
    };
  }

  try {
    const excludedRule = findMatchedRule(compiledExcludeRules, rawUrl, normalizedMethod);
    if (excludedRule) {
      return {
        matched: false,
        mode: 'exclude',
        rule_pattern: excludedRule.pattern,
        methods: excludedRule.methods
      };
    }

    // 当没有"启用且有效"的包含规则时，默认不过滤（全量捕获）
    if (compiledIncludeRules.length === 0) {
      return {
        matched: true,
        mode: 'all',
        rule_pattern: '',
        methods: null
      };
    }

    const matchedRule = findMatchedRule(compiledIncludeRules, rawUrl, normalizedMethod);

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
  } catch (err) {
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
  } catch (err) {
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
  } catch (err) {
    // ignore
  }

  const baseCandidates = [sender?.url, sender?.tab?.url];
  for (const base of baseCandidates) {
    if (!base) {
      continue;
    }

    try {
      return new URL(value, base).toString();
    } catch (err) {
      // try next base
    }
  }

  return value;
}

// 格式化为日期文件夹名 (YYYY-MM-DD)
function formatForDateFolder(date = new Date()) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// 格式化为文件名时间部分 (HHmmss)
function formatTimeForFile(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}${mi}${ss}`;
}

function buildRealtimeRecordFileName(record) {
  const createdAt = new Date(record?.created_at || Date.now());

  // 拆分时间戳：日期用于文件夹，时间用于文件名
  const dateFolder = formatForDateFolder(createdAt);  // 2025-02-17
  const timePrefix = formatTimeForFile(createdAt);    // 143022

  const savePath = sanitizeSavePath(settings.save_path);
  const method = sanitizeFilenameSegment(record?.request?.method || 'GET', 10).toLowerCase();
  const urlHint = getUrlFileHint(record?.request?.url || '');
  const ruleRaw = record?.match?.mode === 'rule' ? record?.match?.rule_pattern : 'all';
  const ruleHint = sanitizeFilenameSegment(ruleRaw || 'all', 28);
  const status = sanitizeFilenameSegment(String(record?.response?.status_code ?? 'na'), 8);
  const shortId = sanitizeFilenameSegment(String(record?.id || '').slice(-8), 12);

  const fileName = `${timePrefix}_${method}_${urlHint}_${ruleHint}_${status}_${shortId}.json`;

  // 路径结构：savePath/2025-02-17/143022_xxx.json
  if (savePath) {
    return `${savePath}/${dateFolder}/${fileName}`;
  }
  // 如果没有设置 save_path，直接在下载目录下创建日期文件夹
  return `${dateFolder}/${fileName}`;
}

function toPersistedRecord(record) {
  // 优化：只保存元数据，不保存完整的 body（已保存到文件）
  // 文件路径可以通过 buildRealtimeRecordFileName(record) 重建
  // 安全优化：根据设置决定是否持久化 body 预览（避免敏感数据长期落盘）
  const shouldPersistPreview = Boolean(settings.persist_body_preview);

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
      has_body: Boolean(record.request?.has_body),
      body_size: Number(record.request?.body_size || 0),
      body_preview: shouldPersistPreview ? String(record.request?.body_preview || '') : '',
      request_headers: record.request?.request_headers || null,
      request_body: null  // 不保存到内存，body 已在文件中
    },
    response: {
      status_code: record.response?.status_code ?? null,
      status_line: record.response?.status_line || '',
      has_body: Boolean(record.response?.has_body),
      body_size: Number(record.response?.body_size || 0),
      body_preview: shouldPersistPreview ? String(record.response?.body_preview || '') : '',
      response_headers: record.response?.response_headers || null,
      response_body: null  // 不保存到内存，body 已在文件中
    },
    performance: {
      start_time: record.performance?.start_time ?? null,
      end_time: record.performance?.end_time ?? null,
      duration_ms: record.performance?.duration_ms ?? null,
      from_cache: Boolean(record.performance?.from_cache),
      source: record.performance?.source || 'webRequest'
    },
    file_path: buildRealtimeRecordFileName(record),  // 新增：记录文件路径
    errors: Array.isArray(record.errors) ? record.errors.slice(0, 3) : []
  };
}

function toPreviewText(value) {
  return clampText(String(value || ''), BODY_PREVIEW_MAX_LENGTH);
}

function shouldSaveRealtimeRecord(record, bodyData = {}) {
  if (!settings.capture_response_data) {
    return true;
  }

  // 优先使用 queueRealtimeSave 传入的临时 body（内存优化场景下不持久化到 records）
  if (typeof bodyData.responseBody === 'string') {
    return true;
  }

  const responseBody = record?.response?.response_body;
  if (responseBody !== null && responseBody !== undefined) {
    return true;
  }

  // 已标记存在 body（但未写入内存）时，也允许落盘
  if (record?.response?.has_body) {
    return true;
  }

  // 如果记录创建时间异常，避免无限重试导致永不保存
  const createdAt = Date.parse(record?.created_at || '');
  if (!Number.isFinite(createdAt)) {
    return true;
  }

  // 给 content script 合并留窗口，超时后即使没有 body 也写文件
  return Date.now() - createdAt >= CONTENT_MERGE_MAX_WAIT_MS;
}

async function saveRecordAsRealtimeFile(record, bodyData = {}) {
  const { responseBody, requestBody } = bodyData;

  // 创建包含完整 body 数据的记录副本用于文件保存
  // 内存中的原始记录不包含 body，节省内存
  const recordWithBody = {
    ...record,
    request: {
      ...record.request,
      // 如果提供了 requestBody，添加到副本中
      request_body: requestBody && record.request.has_body
        ? { type: 'injected', value: requestBody }
        : record.request.request_body,
      // 移除 body_preview（文件中已有完整 request_body，避免冗余）
      body_preview: undefined
    },
    response: {
      ...record.response,
      // 如果提供了 responseBody，添加到副本中
      response_body: responseBody && record.response.has_body
        ? responseBody
        : record.response.response_body,
      // 移除 body_preview（文件中已有完整 response_body，避免冗余）
      body_preview: undefined
    }
  };

  const payload = {
    saved_at: nowIso(),
    mode: 'realtime-single-record',
    settings_snapshot: settings,
    record: recordWithBody
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
  const responseBody = options.responseBody || null;
  const requestBody = options.requestBody || null;

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

    if (!shouldSaveRealtimeRecord(record, { responseBody, requestBody })) {
      // 还未达到可保存条件时重排队，避免在 body 迟到时直接丢失文件
      queueRealtimeSave(record, { forceReschedule: true, responseBody, requestBody });
      return;
    }

    saveRecordAsRealtimeFile(record, { responseBody, requestBody })
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
      has_body: false,
      body_size: 0,
      body_preview: '',
      request_headers: null,
      request_body: null
    },
    response: {
      status_code: null,
      status_line: '',
      has_body: false,
      body_size: 0,
      body_preview: '',
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

    // 修复内存泄漏：清理被删除记录的定时器和ID集合
    for (let i = 0; i < removeCount; i++) {
      const removedRecord = records[i];
      if (removedRecord?.id) {
        // 清理定时器
        const timerId = pendingRecordSaveTimers.get(removedRecord.id);
        if (timerId) {
          clearTimeout(timerId);
          pendingRecordSaveTimers.delete(removedRecord.id);
        }
        // 清理已保存标记
        savedRecordIds.delete(removedRecord.id);
      }
    }

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
    active_rule_count: compiledIncludeRules.length,
    active_exclude_rule_count: compiledExcludeRules.length,
    recent_records: records.slice(-Math.max(50, settings.waterfall_max_records || 50)).reverse()
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

// 性能优化：防抖版本的 persistData 调度
function schedulePersist() {
  if (persistScheduled) {
    return;
  }

  persistScheduled = true;
  persistTimer = setTimeout(() => {
    persistData().finally(() => {
      persistScheduled = false;
      persistTimer = null;
    });
  }, PERSIST_DEBOUNCE_MS);
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

  compileFilterRegex(settings.url_filter_rules, settings.url_exclude_rules);
  updateBadge();
  logInfo('加载配置完成：', {
    capture_enabled: settings.capture_enabled,
    rule_count: settings.url_filter_rules.length,
    save_path: settings.save_path
  });
}

async function saveSettings(nextSettings) {
  settings = sanitizeSettings(nextSettings || {});

  compileFilterRegex(settings.url_filter_rules, settings.url_exclude_rules);

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

/**
 * 获取指定日期的捕获记录（用于 ZIP 打包）
 * @param {string} dateStr - 日期字符串 (YYYY-MM-DD)
 * @returns {Array} 匹配的记录列表
 */
function getRecordsByDate(dateStr) {
  if (!dateStr) {
    return [];
  }

  // 从内存中的 records 筛选指定日期的记录
  return records.filter(record => {
    if (!record.created_at) return false;
    const recordDate = record.created_at.split('T')[0]; // 提取日期部分
    return recordDate === dateStr;
  });
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

  const matchMeta = getUrlMatchMeta(details.url, details.method, details);
  if (!matchMeta.matched) {
    if (matchMeta.mode === 'exclude') {
      stats.excluded_requests += 1;
    } else if (matchMeta.mode === 'ignore-static') {
      stats.static_ignored_requests += 1;
    }
    return;
  }

  stats.matched_requests += 1;

  const record = createBaseRecord(details, matchMeta);

  if (settings.capture_request_data) {
    record.request.request_body = parseRequestBody(details.requestBody);
    if (record.request.request_body) {
      const rawValue = record.request.request_body.value;
      const textValue = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue);
      record.request.has_body = true;
      record.request.body_size = textValue ? textValue.length : 0;
      record.request.body_preview = toPreviewText(textValue || '');
    }
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
  const matchMeta = getUrlMatchMeta(resolvedUrl, method, {
    type: String(data.resourceType || data.type || '').toLowerCase()
  });
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

    // 内存优化：不将 body 保存到内存记录，只保存元数据
    // body 数据将在文件保存时临时组装
    if (settings.capture_response_data) {
      record.response.has_body = true;
      record.response.body_size = responseBody.length;
      record.response.body_preview = toPreviewText(responseBody);
      logInfo(`标记 response_body (${responseBody.length} chars，未保存到内存)`);
    }

    if (settings.capture_request_data && requestBody && !record.request.has_body) {
      record.request.has_body = true;
      record.request.body_size = requestBody.length;
      record.request.body_preview = toPreviewText(requestBody);
      logInfo(`标记 request_body (${requestBody.length} chars，未保存到内存)`);
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
    queueRealtimeSave(record, {
      forceReschedule: true,
      responseBody,
      requestBody  // 传递 body 数据用于文件保存
    });
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
      // 内存优化：只保存元数据标记，不保存实际 body
      has_body: Boolean(settings.capture_request_data && requestBody),
      body_size: requestBody ? requestBody.length : 0,
      body_preview: requestBody ? toPreviewText(requestBody) : '',
      request_body: null
    },
    response: {
      status_code: typeof data.status === 'number' ? data.status : null,
      status_line: '',
      response_headers: null,
      // 内存优化：只保存元数据标记，不保存实际 body
      has_body: Boolean(settings.capture_response_data && responseBody),
      body_size: responseBody ? responseBody.length : 0,
      body_preview: responseBody ? toPreviewText(responseBody) : '',
      response_body: null
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
  queueRealtimeSave(record, { responseBody, requestBody });
}

async function init() {
  await loadData();
  // 启动时将旧版大体积 capture_data 迁移为轻量摘要，避免 storage 配额占满
  await persistData();
  if (settings.capture_enabled) {
    await reinjectContentScripts();
  }
  broadcastState();

  // 初始化 Side Panel
  await initSidePanel();
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
      schedulePersist(); // 性能优化：使用防抖写入
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
      schedulePersist(); // 性能优化：使用防抖写入
    } catch (error) {
      stats.error_count += 1;
      stats.last_error = `onBeforeSendHeaders 处理失败: ${error.message}`;
      logError(stats.last_error);
    }
  },
  { urls: ['<all_urls>'] },
  // extraHeaders 允许捕获 Cookie、Authorization 等浏览器默认屏蔽的敏感头
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    try {
      handleWebRequestHeaders(details);
      schedulePersist(); // 性能优化：使用防抖写入
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
      schedulePersist(); // 性能优化：使用防抖写入
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
      schedulePersist(); // 性能优化：使用防抖写入
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

/*
 * Side Panel 支持 (Chrome 114+)
 * 点击扩展图标时打开侧边栏面板，避免下载时遮挡问题
 */

// 检测 Side Panel API 可用性
function isSidePanelAvailable() {
  return typeof chrome?.sidePanel?.setPanelBehavior === 'function';
}

// 初始化 Side Panel 行为
async function initSidePanel() {
  if (!isSidePanelAvailable()) {
    logWarn('Side Panel API 不可用（需要 Chrome 114+），将使用默认 popup 模式');
    return;
  }

  try {
    // 设置点击扩展图标时打开 Side Panel
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    logInfo('Side Panel 已启用：点击扩展图标将打开侧边栏面板');
  } catch (error) {
    logWarn(`设置 Side Panel 行为失败: ${error.message}`);
  }
}

// 注意：不再使用 chrome.action.onClicked，因为 manifest.json 中配置了 default_popup
// 点击扩展图标会打开 Popup，用户可以在 Popup 中点击"打开侧边栏"按钮
// 这样更兼容，用户可以自由选择使用 Popup 或 Side Panel

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

      case 'GET_RECORDS_BY_DATE': {
        try {
          const dateStr = message.date || new Date().toISOString().split('T')[0];
          const records = getRecordsByDate(dateStr);

          sendResponse({
            ok: true,
            payload: {
              date: dateStr,
              count: records.length,
              records: records
            }
          });
        } catch (error) {
          stats.error_count += 1;
          stats.last_error = `获取记录失败: ${error.message}`;
          await persistData();
          sendResponse({ ok: false, error: stats.last_error });
        }
        break;
      }

      case 'GET_LATEST_RECORD_FILE': {
        try {
          if (records.length === 0) {
            sendResponse({ ok: false, error: '暂无捕获记录' });
            break;
          }

          // 获取最新的记录（数组最后一个）
          const latestRecord = records[records.length - 1];
          const fileName = buildRealtimeRecordFileName(latestRecord);
          const relativePath = settings.save_path
            ? `${settings.save_path}/${fileName}`
            : fileName;

          sendResponse({
            ok: true,
            payload: {
              file_name: fileName,
              relative_path: relativePath,
              record_id: latestRecord.id,
              created_at: latestRecord.created_at,
              url: latestRecord.request.url,
              method: latestRecord.request.method,
              has_body: latestRecord.response.has_body || latestRecord.request.has_body
            }
          });
        } catch (error) {
          stats.error_count += 1;
          stats.last_error = `获取最新记录失败: ${error.message}`;
          await persistData();
          sendResponse({ ok: false, error: stats.last_error });
        }
        break;
      }

      case 'GET_RULE_STATS': {
        try {
          // 统计每个规则的捕获数量
          const ruleStats = new Map();

          // 初始化统计：为每个启用的规则创建条目
          const rules = Array.isArray(settings.url_filter_rules) ? settings.url_filter_rules : [];
          for (const rule of rules) {
            if (rule?.enabled !== false && String(rule?.pattern || '').trim()) {
              ruleStats.set(rule.pattern.trim(), 0);
            }
          }

          // 遍历所有记录进行统计
          let allModeCount = 0;
          for (const record of records) {
            const matchMode = record?.match?.mode;
            const rulePattern = record?.match?.rule_pattern || '';

            if (matchMode === 'all' || !rulePattern) {
              allModeCount += 1;
            } else if (matchMode === 'rule' && rulePattern) {
              const current = ruleStats.get(rulePattern) || 0;
              ruleStats.set(rulePattern, current + 1);
            }
          }

          // 构建返回结果
          const statsList = [];

          // 添加各规则的统计
          for (const [pattern, count] of ruleStats.entries()) {
            statsList.push({
              pattern: pattern,
              count: count,
              type: 'rule'
            });
          }

          // 如果有"全量捕获"的记录，添加一个特殊条目
          if (allModeCount > 0 || rules.length === 0) {
            statsList.unshift({
              pattern: rules.length === 0 ? '（未设置规则，全量捕获）' : '（未匹配规则）',
              count: allModeCount,
              type: 'all'
            });
          }

          const totalCaptured = statsList.reduce((sum, item) => sum + item.count, 0);

          sendResponse({
            ok: true,
            payload: {
              total_records: records.length,
              total_captured: totalCaptured,
              rule_stats: statsList
            }
          });
        } catch (error) {
          stats.error_count += 1;
          stats.last_error = `获取规则统计失败: ${error.message}`;
          await persistData();
          sendResponse({ ok: false, error: stats.last_error });
        }
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
