const MAX_URL_RULES = 20;
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

const savePathEl = document.getElementById('savePath');
const captureRequestDataEl = document.getElementById('captureRequestData');
const captureResponseDataEl = document.getElementById('captureResponseData');
const capturePerformanceDataEl = document.getElementById('capturePerformanceData');
const ignoreStaticResourcesEl = document.getElementById('ignoreStaticResources');
const maxBodyLengthEl = document.getElementById('maxBodyLength');
const waterfallMaxRecordsEl = document.getElementById('waterfallMaxRecords');

const includeRuleListEl = document.getElementById('ruleList');
const includeRuleCountEl = document.getElementById('ruleCount');
const newIncludeRuleInputEl = document.getElementById('newRuleInput');
const addIncludeRuleBtn = document.getElementById('addRuleBtn');

const excludeRuleListEl = document.getElementById('excludeRuleList');
const excludeRuleCountEl = document.getElementById('excludeRuleCount');
const newExcludeRuleInputEl = document.getElementById('newExcludeRuleInput');
const addExcludeRuleBtn = document.getElementById('addExcludeRuleBtn');

const saveBtn = document.getElementById('saveBtn');
const reloadBtn = document.getElementById('reloadBtn');
const stopCaptureBtn = document.getElementById('stopCaptureBtn');
const openShortcutsBtn = document.getElementById('openShortcuts');
const exportSettingsBtn = document.getElementById('exportSettingsBtn');
const importSettingsBtn = document.getElementById('importSettingsBtn');
const importSettingsFileEl = document.getElementById('importSettingsFile');
const packCustomFolderBtn = document.getElementById('packCustomFolderBtn');
const statusEl = document.getElementById('status');

const RULE_GROUPS = {
  include: {
    title: '过滤',
    empty: '暂未配置过滤规则，默认捕获全部请求。',
    listEl: includeRuleListEl,
    countEl: includeRuleCountEl
  },
  exclude: {
    title: '排除',
    empty: '暂未配置排除规则。',
    listEl: excludeRuleListEl,
    countEl: excludeRuleCountEl
  }
};

let currentIncludeRules = [];
let currentExcludeRules = [];
// 修复数据竞争：使用 Set 跟踪每个字段的编辑状态
const editingFields = new Set();

function logInfo(...args) {
  console.info('[Options]', ...args);
}

function logError(...args) {
  console.error('[Options]', ...args);
}

function createRuleId() {
  if (globalThis.crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
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

function toJsonDataUrl(payload) {
  const jsonText = JSON.stringify(payload, null, 2);
  return `data:application/json;charset=utf-8,${encodeURIComponent(jsonText)}`;
}

function setStatus(text, type = 'normal') {
  statusEl.textContent = text || '';
  statusEl.classList.remove('ok', 'error', 'warn');
  if (type === 'ok') {
    statusEl.classList.add('ok');
  }
  if (type === 'error') {
    statusEl.classList.add('error');
  }
  if (type === 'warn') {
    statusEl.classList.add('warn');
  }
}

function validateRegex(pattern) {
  if (!pattern) {
    return { ok: false, error: '规则不能为空' };
  }

  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function validateSavePath(path) {
  if (!path) {
    return { ok: true };
  }

  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/')) {
    return { ok: false, error: '请填写相对下载目录的路径，不支持绝对路径。' };
  }

  return { ok: true };
}

function normalizeRules(inputRules = []) {
  return (Array.isArray(inputRules) ? inputRules : [])
    .map((rule) => {
      let methods = null;
      if (Array.isArray(rule?.methods) && rule.methods.length > 0) {
        methods = [...new Set(
          rule.methods
            .map((m) => String(m || '').toUpperCase().trim())
            .filter((m) => HTTP_METHODS.includes(m))
        )];
        if (methods.length === 0) {
          methods = null;
        }
      }

      return {
        id: String(rule?.id || createRuleId()),
        pattern: String(rule?.pattern || '').trim(),
        enabled: rule?.enabled !== false,
        methods
      };
    })
    .filter((rule) => rule.pattern)
    .slice(0, MAX_URL_RULES);
}

function getRulesByType(ruleType) {
  return ruleType === 'exclude' ? currentExcludeRules : currentIncludeRules;
}

function setRulesByType(ruleType, rules) {
  if (ruleType === 'exclude') {
    currentExcludeRules = rules;
  } else {
    currentIncludeRules = rules;
  }
}

function updateRuleCount(ruleType) {
  const group = RULE_GROUPS[ruleType];
  group.countEl.textContent = String(getRulesByType(ruleType).length);
}

function getRuleValidationSummary(ruleType) {
  const invalid = [];
  const rules = getRulesByType(ruleType);
  for (const rule of rules) {
    const check = validateRegex(rule.pattern);
    if (!check.ok) {
      invalid.push(`${RULE_GROUPS[ruleType].title}规则「${rule.pattern || '(空)'}」无效：${check.error}`);
    }
  }
  return { ok: invalid.length === 0, invalid };
}

function renderRules(ruleType) {
  const group = RULE_GROUPS[ruleType];
  const listEl = group.listEl;
  const rules = getRulesByType(ruleType);
  updateRuleCount(ruleType);

  if (rules.length === 0) {
    listEl.innerHTML = `<li class="empty-state">${group.empty}</li>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const rule of rules) {
    const item = document.createElement('li');
    item.className = `rule-item ${rule.enabled ? '' : 'rule-disabled'}`.trim();
    item.dataset.ruleId = rule.id;
    item.dataset.ruleType = ruleType;

    const main = document.createElement('div');
    main.className = 'rule-main';

    const enableLabel = document.createElement('label');
    enableLabel.className = 'rule-enable';
    const enableCheckbox = document.createElement('input');
    enableCheckbox.type = 'checkbox';
    enableCheckbox.checked = rule.enabled;
    enableCheckbox.addEventListener('change', () => toggleRule(ruleType, rule.id, enableCheckbox.checked));
    const enableText = document.createElement('span');
    enableText.textContent = '启用';
    enableLabel.append(enableCheckbox, enableText);

    const patternInput = document.createElement('input');
    patternInput.className = 'rule-pattern-input';
    patternInput.type = 'text';
    patternInput.value = rule.pattern;
    patternInput.placeholder = '请输入正则表达式';
    patternInput.addEventListener('focus', () => { editingFields.add(`pattern-${ruleType}-${rule.id}`); });
    patternInput.addEventListener('blur', () => { editingFields.delete(`pattern-${ruleType}-${rule.id}`); });
    patternInput.addEventListener('input', () => updateRulePattern(ruleType, rule.id, patternInput.value));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'rule-delete';
    deleteBtn.type = 'button';
    deleteBtn.textContent = '删除';
    deleteBtn.addEventListener('click', () => removeRule(ruleType, rule.id));

    main.append(enableLabel, patternInput, deleteBtn);
    item.appendChild(main);

    const methodsSection = document.createElement('div');
    methodsSection.className = 'rule-methods';
    const methodsLabel = document.createElement('div');
    methodsLabel.className = 'rule-methods-label';
    methodsLabel.textContent = 'HTTP 方法（不选则匹配所有）';
    methodsSection.appendChild(methodsLabel);

    const methodsCheckboxes = document.createElement('div');
    methodsCheckboxes.className = 'rule-methods-checkboxes';
    for (const method of HTTP_METHODS) {
      const methodLabel = document.createElement('label');
      methodLabel.className = 'method-checkbox';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = method;
      checkbox.checked = Array.isArray(rule.methods) && rule.methods.includes(method);
      checkbox.addEventListener('change', () => updateRuleMethods(ruleType, rule.id, method, checkbox.checked));
      const text = document.createElement('span');
      text.textContent = method;
      methodLabel.append(checkbox, text);
      methodsCheckboxes.appendChild(methodLabel);
    }
    methodsSection.appendChild(methodsCheckboxes);
    item.appendChild(methodsSection);

    const meta = document.createElement('div');
    meta.className = 'rule-meta';
    const check = validateRegex(rule.pattern);
    const badge = document.createElement('span');
    badge.className = `badge ${check.ok ? 'ok' : 'error'}`;
    badge.textContent = check.ok ? '语法有效' : '语法错误';
    const msg = document.createElement('span');
    const methodsDesc = Array.isArray(rule.methods) && rule.methods.length > 0
      ? ` [${rule.methods.join(', ')}]`
      : ' [所有方法]';
    msg.textContent = check.ok ? `${group.title}规则${methodsDesc}` : check.error;
    meta.append(badge, msg);
    item.appendChild(meta);

    fragment.appendChild(item);
  }

  listEl.innerHTML = '';
  listEl.appendChild(fragment);

  const validation = getRuleValidationSummary(ruleType);
  if (!validation.ok) {
    setStatus(validation.invalid[0], 'warn');
  }
}

function addRule(ruleType, pattern) {
  const rules = getRulesByType(ruleType);
  if (rules.length >= MAX_URL_RULES) {
    throw new Error(`${RULE_GROUPS[ruleType].title}规则最多支持 ${MAX_URL_RULES} 条`);
  }
  const trimmed = String(pattern || '').trim();
  const check = validateRegex(trimmed);
  if (!check.ok) {
    throw new Error(`规则无效：${check.error}`);
  }

  const next = rules.concat({
    id: createRuleId(),
    pattern: trimmed,
    enabled: true,
    methods: null
  });
  setRulesByType(ruleType, next);
  renderRules(ruleType);
}

function removeRule(ruleType, ruleId) {
  const next = getRulesByType(ruleType).filter((rule) => rule.id !== ruleId);
  setRulesByType(ruleType, next);
  renderRules(ruleType);
}

function toggleRule(ruleType, ruleId, enabled) {
  const next = getRulesByType(ruleType).map((rule) => (
    rule.id === ruleId ? { ...rule, enabled: Boolean(enabled) } : rule
  ));
  setRulesByType(ruleType, next);
  renderRules(ruleType);
}

function updateRulePattern(ruleType, ruleId, pattern) {
  const next = getRulesByType(ruleType).map((rule) => (
    rule.id === ruleId ? { ...rule, pattern: String(pattern || '') } : rule
  ));
  setRulesByType(ruleType, next);

  const listEl = RULE_GROUPS[ruleType].listEl;
  const item = listEl.querySelector(`[data-rule-id="${ruleId}"]`);
  if (!item) {
    return;
  }
  const meta = item.querySelector('.rule-meta');
  const badge = meta?.querySelector('.badge');
  const msg = meta?.querySelector('span:not(.badge)');
  if (!badge || !msg) {
    return;
  }

  const check = validateRegex(pattern);
  const rule = next.find((itemRule) => itemRule.id === ruleId);
  const methodsDesc = Array.isArray(rule?.methods) && rule.methods.length > 0
    ? ` [${rule.methods.join(', ')}]`
    : ' [所有方法]';

  badge.className = `badge ${check.ok ? 'ok' : 'error'}`;
  badge.textContent = check.ok ? '语法有效' : '语法错误';
  msg.textContent = check.ok ? `${RULE_GROUPS[ruleType].title}规则${methodsDesc}` : check.error;
}

function updateRuleMethods(ruleType, ruleId, method, checked) {
  const next = getRulesByType(ruleType).map((rule) => {
    if (rule.id !== ruleId) {
      return rule;
    }
    let methods = rule.methods || [];
    if (checked) {
      if (!methods.includes(method)) {
        methods = methods.concat(method);
      }
    } else {
      methods = methods.filter((item) => item !== method);
    }
    return { ...rule, methods: methods.length > 0 ? methods : null };
  });
  setRulesByType(ruleType, next);
  renderRules(ruleType);
}

function buildCurrentSettingsPayload() {
  return {
    capture_enabled: false,
    url_filter_rules: normalizeRules(currentIncludeRules),
    url_exclude_rules: normalizeRules(currentExcludeRules),
    ignore_static_resources: Boolean(ignoreStaticResourcesEl.checked),
    save_path: savePathEl.value.trim(),
    capture_request_data: captureRequestDataEl.checked,
    capture_response_data: captureResponseDataEl.checked,
    capture_performance_data: capturePerformanceDataEl.checked,
    max_body_length: Number(maxBodyLengthEl.value) || 20_000_000,
    waterfall_max_records: Math.min(500, Math.max(10, Number(waterfallMaxRecordsEl.value) || 50))
  };
}

function applySettingsToForm(settings) {
  currentIncludeRules = normalizeRules(settings.url_filter_rules);
  currentExcludeRules = normalizeRules(settings.url_exclude_rules);
  savePathEl.value = settings.save_path || '';
  captureRequestDataEl.checked = Boolean(settings.capture_request_data);
  captureResponseDataEl.checked = Boolean(settings.capture_response_data);
  capturePerformanceDataEl.checked = Boolean(settings.capture_performance_data);
  ignoreStaticResourcesEl.checked = Boolean(settings.ignore_static_resources);
  maxBodyLengthEl.value = settings.max_body_length || 20_000_000;
  waterfallMaxRecordsEl.value = settings.waterfall_max_records || 50;

  renderRules('include');
  renderRules('exclude');
}

function applyState(payload) {
  // 修复数据竞争：检查是否有任何字段正在编辑
  if (editingFields.size > 0) {
    logInfo('有字段正在编辑，跳过状态同步');
    return;
  }
  applySettingsToForm(payload.settings || {});
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function stopCaptureIfNeeded() {
  const stateRes = await sendRuntimeMessage({ type: 'GET_STATE' });
  if (!stateRes?.ok) {
    throw new Error(stateRes?.error || '获取捕获状态失败');
  }
  if (!stateRes.payload?.settings?.capture_enabled) {
    return false;
  }

  const stopRes = await sendRuntimeMessage({
    type: 'TOGGLE_CAPTURE',
    enabled: false
  });
  if (!stopRes?.ok) {
    throw new Error(stopRes?.error || '停止捕获失败');
  }

  applyState(stopRes.payload);
  return true;
}

async function loadSettings() {
  const res = await sendRuntimeMessage({ type: 'GET_STATE' });
  if (!res?.ok) {
    throw new Error(res?.error || '获取设置失败');
  }

  applyState(res.payload);
  window.__settingsInitialized__ = true;
  logInfo('已加载后台设置', res.payload?.settings || {});
}

async function saveSettings() {
  await stopCaptureIfNeeded();
  const next = buildCurrentSettingsPayload();

  if (next.url_filter_rules.length > MAX_URL_RULES || next.url_exclude_rules.length > MAX_URL_RULES) {
    throw new Error(`每类规则最多支持 ${MAX_URL_RULES} 条`);
  }

  const includeValidation = getRuleValidationSummary('include');
  if (!includeValidation.ok) {
    throw new Error(includeValidation.invalid[0]);
  }
  const excludeValidation = getRuleValidationSummary('exclude');
  if (!excludeValidation.ok) {
    throw new Error(excludeValidation.invalid[0]);
  }

  const pathCheck = validateSavePath(next.save_path);
  if (!pathCheck.ok) {
    throw new Error(pathCheck.error);
  }

  const res = await sendRuntimeMessage({
    type: 'UPDATE_SETTINGS',
    settings: next
  });
  if (!res?.ok) {
    throw new Error(res?.error || '保存设置失败');
  }

  const savedSettings = res.payload?.settings;
  if (savedSettings) {
    applySettingsToForm(savedSettings);
  }
  logInfo('UPDATE_SETTINGS 已生效', res.payload?.settings || {});
}

async function exportSettingsToFile() {
  await stopCaptureIfNeeded();
  const payload = {
    format: 'network-capture-settings',
    version: 3, // 配置格式版本（保留版本号以保持向后兼容）
    exported_at: new Date().toISOString(),
    settings: buildCurrentSettingsPayload()
  };

  const fileName = `network_capture_settings_${formatTimestampForFile(new Date())}.json`;
  const downloadId = await chrome.downloads.download({
    url: toJsonDataUrl(payload),
    filename: fileName,
    conflictAction: 'uniquify',
    saveAs: true
  });

  if (!Number.isInteger(downloadId) || downloadId <= 0) {
    throw new Error('导出设置失败：无法创建下载任务');
  }
}

function parseImportedSettings(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error('导入失败：JSON 格式错误');
  }

  const source =
    parsed && typeof parsed === 'object' && parsed.settings && typeof parsed.settings === 'object'
      ? parsed.settings
      : parsed;

  if (!source || typeof source !== 'object') {
    throw new Error('导入失败：未找到 settings 对象');
  }

  return {
    capture_enabled: false,
    url_filter_rules: normalizeRules(source.url_filter_rules),
    url_exclude_rules: normalizeRules(source.url_exclude_rules),
    ignore_static_resources: Boolean(source.ignore_static_resources),
    save_path: String(source.save_path || '').trim(),
    capture_request_data:
      source.capture_request_data === undefined ? true : Boolean(source.capture_request_data),
    capture_response_data:
      source.capture_response_data === undefined ? true : Boolean(source.capture_response_data),
    capture_performance_data: Boolean(source.capture_performance_data),
    max_body_length: Number(source.max_body_length) || 20_000_000
  };
}

async function importSettingsFromFile(file) {
  if (!file) {
    return;
  }
  await stopCaptureIfNeeded();
  const text = await file.text();
  const importedSettings = parseImportedSettings(text);
  applySettingsToForm(importedSettings);
  await saveSettings();
}

function bindRuleAdder(addBtn, inputEl, ruleType) {
  addBtn?.addEventListener('click', () => {
    try {
      addRule(ruleType, inputEl.value);
      inputEl.value = '';
      setStatus(`${RULE_GROUPS[ruleType].title}规则已添加，请点击“保存设置”生效。`, 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  });

  inputEl?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addBtn.click();
    }
  });
}

bindRuleAdder(addIncludeRuleBtn, newIncludeRuleInputEl, 'include');
bindRuleAdder(addExcludeRuleBtn, newExcludeRuleInputEl, 'exclude');

// 修复数据竞争：为每个输入框设置独立的编辑状态
savePathEl.addEventListener('focus', () => { editingFields.add('savePath'); });
savePathEl.addEventListener('blur', () => { editingFields.delete('savePath'); });
newIncludeRuleInputEl.addEventListener('focus', () => { editingFields.add('newIncludeRule'); });
newIncludeRuleInputEl.addEventListener('blur', () => { editingFields.delete('newIncludeRule'); });
newExcludeRuleInputEl.addEventListener('focus', () => { editingFields.add('newExcludeRule'); });
newExcludeRuleInputEl.addEventListener('blur', () => { editingFields.delete('newExcludeRule'); });
maxBodyLengthEl.addEventListener('focus', () => { editingFields.add('maxBodyLength'); });
maxBodyLengthEl.addEventListener('blur', () => { editingFields.delete('maxBodyLength'); });

saveBtn.addEventListener('click', async () => {
  try {
    await saveSettings();
    setStatus('设置已保存并已同步到后台。', 'ok');
  } catch (error) {
    logError('保存设置失败', error);
    setStatus(error.message, 'error');
  }
});

reloadBtn.addEventListener('click', async () => {
  try {
    await loadSettings();
    setStatus('已从后台重新加载设置。', 'ok');
  } catch (error) {
    logError('重新加载失败', error);
    setStatus(error.message, 'error');
  }
});

openShortcutsBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

stopCaptureBtn?.addEventListener('click', async () => {
  try {
    const stopped = await stopCaptureIfNeeded();
    setStatus(stopped ? '已停止捕获，可安全修改设置。' : '当前已是停止状态，可直接修改设置。', 'ok');
  } catch (error) {
    logError('停止捕获失败', error);
    setStatus(error.message, 'error');
  }
});

exportSettingsBtn?.addEventListener('click', async () => {
  try {
    await exportSettingsToFile();
    setStatus('设置已导出为 JSON 文件。', 'ok');
  } catch (error) {
    logError('导出设置失败', error);
    setStatus(error.message, 'error');
  }
});

importSettingsBtn?.addEventListener('click', () => {
  importSettingsFileEl?.click();
});

importSettingsFileEl?.addEventListener('change', async () => {
  try {
    const file = importSettingsFileEl.files?.[0];
    await importSettingsFromFile(file);
    setStatus('设置已导入并同步到后台。', 'ok');
  } catch (error) {
    logError('导入设置失败', error);
    setStatus(error.message, 'error');
  } finally {
    importSettingsFileEl.value = '';
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'STATE_UPDATED') {
    if (window.__settingsInitialized__) {
      applyState(message.payload);
    }
  }
});

// ========== ZIP 打包自定义文件夹功能 ==========

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
 * Process files and create ZIP
 */
async function processFilesForZip(files, progressFn) {
  const JSZip = (window.JZip || window.JSZip);
  if (!JSZip) {
    throw new Error('JSZip 库未加载');
  }

  const zip = new JSZip();
  const today = new Date().toISOString().split('T')[0];
  let successCount = 0;
  let failCount = 0;

  // 批量处理文件
  const batchSize = 50;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, Math.min(i + batchSize, files.length));
    
    for (const item of batch) {
      try {
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

    if (progressFn) {
      progressFn(i + batch.length, files.length, successCount, failCount);
    }
  }

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

  return { successCount, failCount, zipBlob };
}

/**
 * Pack custom folder data into ZIP
 */
async function packCustomFolderData() {
  const btn = packCustomFolderBtn;
  if (!btn) return;

  const startTime = Date.now();
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ 正在选择文件夹...';

  try {
    const dirHandle = await window.showDirectoryPicker();
    btn.textContent = '⏳ 正在读取文件夹...';

    const files = [];
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'file' && isCaptureFile(entry.name)) {
        files.push({ name: entry.name, handle: entry });
      }
    }

    if (files.length === 0) {
      throw new Error('该文件夹中没有捕获数据文件');
    }

    btn.textContent = `⏳ 找到 ${files.length} 个文件，正在打包...`;

    const result = await processFilesForZip(files, (current, total, success, fail) => {
      btn.textContent = `⏳ 打包中 ${current}/${total}...`;
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const sizeKB = (result.zipBlob.size / 1024).toFixed(0);

    setStatus(`✅ 打包完成！成功：${result.successCount} | 失败：${result.failCount} | ZIP 大小：${sizeKB} KB | 耗时：${elapsed}s`, 'ok');
  } catch (err) {
    if (err.name === 'AbortError') {
      setStatus('用户已取消文件夹选择', 'normal');
    } else {
      setStatus(`打包失败：${err.message}`, 'error');
      console.error('Pack custom folder error:', err);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// 绑定自定义打包按钮事件
if (packCustomFolderBtn) {
  packCustomFolderBtn.addEventListener('click', packCustomFolderData);
}

async function initOptionsPage() {
  const stopped = await stopCaptureIfNeeded();
  await loadSettings();

  if (stopped) {
    setStatus('进入设置页后已自动停止捕获。修改完成后请在 Popup 开启捕获。', 'warn');
  }
}

initOptionsPage().catch((error) => {
  logError('初始化加载设置失败', error);
  setStatus(error.message, 'error');
});
