const MAX_URL_RULES = 20;

// 支持的 HTTP 方法列表
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

const savePathEl = document.getElementById('savePath');
const captureEnabledEl = document.getElementById('captureEnabled');
const captureRequestDataEl = document.getElementById('captureRequestData');
const captureResponseDataEl = document.getElementById('captureResponseData');
const capturePerformanceDataEl = document.getElementById('capturePerformanceData');

const ruleListEl = document.getElementById('ruleList');
const ruleCountEl = document.getElementById('ruleCount');
const newRuleInputEl = document.getElementById('newRuleInput');
const addRuleBtn = document.getElementById('addRuleBtn');

const saveBtn = document.getElementById('saveBtn');
const reloadBtn = document.getElementById('reloadBtn');
const stopCaptureBtn = document.getElementById('stopCaptureBtn');
const openShortcutsBtn = document.getElementById('openShortcuts');
const exportSettingsBtn = document.getElementById('exportSettingsBtn');
const importSettingsBtn = document.getElementById('importSettingsBtn');
const importSettingsFileEl = document.getElementById('importSettingsFile');
const statusEl = document.getElementById('status');

let currentRules = [];
let isEditing = false;

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

function buildCurrentSettingsPayload() {
  return {
    // 设置页统一要求先停止捕获，避免运行中改配置导致上下文异常
    capture_enabled: false,
    url_filter_rules: normalizeRules(currentRules),
    save_path: savePathEl.value.trim(),
    capture_request_data: captureRequestDataEl.checked,
    capture_response_data: captureResponseDataEl.checked,
    capture_performance_data: capturePerformanceDataEl.checked
  };
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
    // 仅用于前端校验语法是否有效
    // 实际过滤仍由 background 统一执行
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
      // 处理 methods 字段
      let methods = null;
      if (Array.isArray(rule?.methods) && rule.methods.length > 0) {
        methods = rule.methods
          .map(m => String(m || '').toUpperCase().trim())
          .filter(m => HTTP_METHODS.includes(m));
        // 去重
        methods = [...new Set(methods)];
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

function getRulesValidationSummary() {
  const invalid = [];

  for (const rule of currentRules) {
    const check = validateRegex(rule.pattern);
    if (!check.ok) {
      invalid.push(`规则「${rule.pattern || '(空)'}」无效：${check.error}`);
    }
  }

  return {
    ok: invalid.length === 0,
    invalid
  };
}

function updateRuleCount() {
  ruleCountEl.textContent = String(currentRules.length);
}

function renderRules() {
  updateRuleCount();

  if (currentRules.length === 0) {
    ruleListEl.innerHTML = '<li class="empty-state">暂未配置规则，默认捕获全部请求。</li>';
    return;
  }

  const fragment = document.createDocumentFragment();

  currentRules.forEach((rule) => {
    const item = document.createElement('li');
    item.className = `rule-item ${rule.enabled ? '' : 'rule-disabled'}`.trim();
    item.dataset.ruleId = rule.id;

    const main = document.createElement('div');
    main.className = 'rule-main';

    const enableLabel = document.createElement('label');
    enableLabel.className = 'rule-enable';

    const enableCheckbox = document.createElement('input');
    enableCheckbox.type = 'checkbox';
    enableCheckbox.checked = rule.enabled;
    enableCheckbox.addEventListener('change', () => toggleRule(rule.id, enableCheckbox.checked));

    const enableText = document.createElement('span');
    enableText.textContent = '启用';

    enableLabel.append(enableCheckbox, enableText);

    const patternInput = document.createElement('input');
    patternInput.className = 'rule-pattern-input';
    patternInput.type = 'text';
    patternInput.value = rule.pattern;
    patternInput.placeholder = '请输入正则表达式';

    // Focus/Blur to handle isEditing state
    patternInput.addEventListener('focus', () => { isEditing = true; });
    patternInput.addEventListener('blur', () => { isEditing = false; });

    patternInput.addEventListener('input', () => updateRule(rule.id, patternInput.value));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'rule-delete';
    deleteBtn.type = 'button';
    deleteBtn.textContent = '删除';
    deleteBtn.addEventListener('click', () => removeRule(rule.id));

    main.append(enableLabel, patternInput, deleteBtn);

    // HTTP 方法选择区域
    const methodsSection = document.createElement('div');
    methodsSection.className = 'rule-methods';

    const methodsLabel = document.createElement('div');
    methodsLabel.className = 'rule-methods-label';
    methodsLabel.textContent = 'HTTP 方法（不选则匹配所有）';

    const methodsCheckboxes = document.createElement('div');
    methodsCheckboxes.className = 'rule-methods-checkboxes';

    HTTP_METHODS.forEach(method => {
      const label = document.createElement('label');
      label.className = 'method-checkbox';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = method;
      checkbox.checked = Array.isArray(rule.methods) && rule.methods.includes(method);
      checkbox.addEventListener('change', () => updateRuleMethods(rule.id, method, checkbox.checked));

      const text = document.createElement('span');
      text.textContent = method;

      label.append(checkbox, text);
      methodsCheckboxes.appendChild(label);
    });

    methodsSection.append(methodsLabel, methodsCheckboxes);

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
    msg.textContent = check.ok
      ? `匹配后将参与 OR 过滤${methodsDesc}`
      : check.error;

    meta.append(badge, msg);

    item.append(main, methodsSection, meta);
    fragment.appendChild(item);
  });

  ruleListEl.innerHTML = '';
  ruleListEl.appendChild(fragment);

  const validation = getRulesValidationSummary();
  if (!validation.ok) {
    setStatus(validation.invalid[0], 'warn');
  }
}

function addRule(pattern) {
  if (currentRules.length >= MAX_URL_RULES) {
    throw new Error(`最多支持 ${MAX_URL_RULES} 条规则`);
  }

  const trimmed = String(pattern || '').trim();
  const check = validateRegex(trimmed);
  if (!check.ok) {
    throw new Error(`规则无效：${check.error}`);
  }

  currentRules.push({
    id: createRuleId(),
    pattern: trimmed,
    enabled: true,
    methods: null  // 默认匹配所有方法
  });

  renderRules();
}

function removeRule(ruleId) {
  currentRules = currentRules.filter((rule) => rule.id !== ruleId);
  renderRules();
}

function toggleRule(ruleId, enabled) {
  currentRules = currentRules.map((rule) => {
    if (rule.id !== ruleId) {
      return rule;
    }
    return {
      ...rule,
      enabled: Boolean(enabled)
    };
  });
  renderRules();
}

function updateRule(ruleId, pattern) {
  currentRules = currentRules.map((rule) => {
    if (rule.id !== ruleId) {
      return rule;
    }
    return {
      ...rule,
      pattern: String(pattern || '')
    };
  });

  // Only update validation message, don't re-render entire list to avoid focus loss
  const item = ruleListEl.querySelector(`[data-rule-id="${ruleId}"]`);
  if (item) {
    const meta = item.querySelector('.rule-meta');
    const check = validateRegex(pattern);
    const badge = meta.querySelector('.badge');
    const msg = meta.querySelector('span:not(.badge)');

    const rule = currentRules.find(r => r.id === ruleId);
    const methodsDesc = Array.isArray(rule?.methods) && rule.methods.length > 0
      ? ` [${rule.methods.join(', ')}]`
      : ' [所有方法]';

    badge.className = `badge ${check.ok ? 'ok' : 'error'}`;
    badge.textContent = check.ok ? '语法有效' : '语法错误';
    msg.textContent = check.ok
      ? `匹配后将参与 OR 过滤${methodsDesc}`
      : check.error;
  }
}

function updateRuleMethods(ruleId, method, checked) {
  currentRules = currentRules.map((rule) => {
    if (rule.id !== ruleId) {
      return rule;
    }

    let methods = rule.methods || [];

    if (checked) {
      // 添加方法（如果尚未存在）
      if (!methods.includes(method)) {
        methods = [...methods, method];
      }
    } else {
      // 移除方法
      methods = methods.filter(m => m !== method);
    }

    // 如果数组为空，设为 null
    methods = methods.length > 0 ? methods : null;

    return {
      ...rule,
      methods
    };
  });

  // Update validation message with new methods info
  const item = ruleListEl.querySelector(`[data-rule-id="${ruleId}"]`);
  if (item) {
    const meta = item.querySelector('.rule-meta');
    const msg = meta.querySelector('span:not(.badge)');

    const rule = currentRules.find(r => r.id === ruleId);
    const methodsDesc = Array.isArray(rule?.methods) && rule.methods.length > 0
      ? ` [${rule.methods.join(', ')}]`
      : ' [所有方法]';

    const check = validateRegex(rule.pattern);
    msg.textContent = check.ok
      ? `匹配后将参与 OR 过滤${methodsDesc}`
      : check.error;
  }
}

function applyState(payload) {
  // If user is actively editing a rule input, don't overwrite currentRules
  // to avoid clobbering their changes and losing focus.
  if (isEditing) {
    return;
  }

  const settings = payload.settings;
  currentRules = normalizeRules(settings.url_filter_rules);

  savePathEl.value = settings.save_path || '';
  captureEnabledEl.checked = Boolean(settings.capture_enabled);
  captureRequestDataEl.checked = Boolean(settings.capture_request_data);
  captureResponseDataEl.checked = Boolean(settings.capture_response_data);
  capturePerformanceDataEl.checked = Boolean(settings.capture_performance_data);

  renderRules();
}

function sendRuntimeMessage(message) {
  // 使用 callback 风格包装 Promise，显式处理 chrome.runtime.lastError
  // 用于规避部分环境下 sendMessage Promise 静默失败导致“保存看似成功但未生效”的问题
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

async function loadSettings() {
  const res = await sendRuntimeMessage({ type: 'GET_STATE' });
  if (!res?.ok) {
    throw new Error(res?.error || '获取设置失败');
  }

  applyState(res.payload);
  logInfo('已加载后台设置', res.payload?.settings || {});

  // 标记初始化完成，后续的状态更新会被应用
  window.__settingsInitialized__ = true;
}

async function saveSettings() {
  await stopCaptureIfNeeded();

  const next = buildCurrentSettingsPayload();

  if (next.url_filter_rules.length > MAX_URL_RULES) {
    throw new Error(`最多支持 ${MAX_URL_RULES} 条规则`);
  }

  const validation = getRulesValidationSummary();
  if (!validation.ok) {
    throw new Error(validation.invalid[0]);
  }

  const pathCheck = validateSavePath(next.save_path);
  if (!pathCheck.ok) {
    throw new Error(pathCheck.error);
  }

  logInfo('准备发送 UPDATE_SETTINGS', next);
  const res = await sendRuntimeMessage({
    type: 'UPDATE_SETTINGS',
    settings: next
  });

  if (!res?.ok) {
    throw new Error(res?.error || '保存设置失败');
  }

  // 直接更新当前表单状态，避免通过 applyState 导致重绘
  // 这样可以保持用户编辑状态不被清空
  const savedSettings = res.payload?.settings;
  if (savedSettings) {
    currentRules = normalizeRules(savedSettings.url_filter_rules);
    // 更新其他设置项的值，但不调用 renderRules() 以避免重绘
    savePathEl.value = savedSettings.save_path || '';
    captureEnabledEl.checked = Boolean(savedSettings.capture_enabled);
    captureRequestDataEl.checked = Boolean(savedSettings.capture_request_data);
    captureResponseDataEl.checked = Boolean(savedSettings.capture_response_data);
    capturePerformanceDataEl.checked = Boolean(savedSettings.capture_performance_data);
    // 只更新规则验证状态，不重新渲染整个列表
    renderRules();
  }
  logInfo('UPDATE_SETTINGS 已生效', res.payload?.settings || {});
}

async function exportSettingsToFile() {
  await stopCaptureIfNeeded();

  const next = buildCurrentSettingsPayload();
  const payload = {
    format: 'network-capture-settings',
    version: 1,
    exported_at: new Date().toISOString(),
    settings: next
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
  } catch {
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
    // 导入设置时强制保持停止状态，避免一导入就触发运行态问题
    capture_enabled: false,
    url_filter_rules: normalizeRules(source.url_filter_rules),  // normalizeRules 会处理 methods 字段
    save_path: String(source.save_path || '').trim(),
    capture_request_data:
      source.capture_request_data === undefined ? true : Boolean(source.capture_request_data),
    capture_response_data:
      source.capture_response_data === undefined ? true : Boolean(source.capture_response_data),
    capture_performance_data: Boolean(source.capture_performance_data)
  };
}

function applySettingsToForm(settings) {
  currentRules = normalizeRules(settings.url_filter_rules);
  savePathEl.value = settings.save_path || '';
  captureEnabledEl.checked = Boolean(settings.capture_enabled);
  captureRequestDataEl.checked = Boolean(settings.capture_request_data);
  captureResponseDataEl.checked = Boolean(settings.capture_response_data);
  capturePerformanceDataEl.checked = Boolean(settings.capture_performance_data);
  renderRules();
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

savePathEl.addEventListener('focus', () => { isEditing = true; });
savePathEl.addEventListener('blur', () => { isEditing = false; });
newRuleInputEl.addEventListener('focus', () => { isEditing = true; });
newRuleInputEl.addEventListener('blur', () => { isEditing = false; });

addRuleBtn.addEventListener('click', () => {
  try {
    addRule(newRuleInputEl.value);
    newRuleInputEl.value = '';
    setStatus('规则已添加，请点击“保存设置”生效。', 'ok');
  } catch (error) {
    setStatus(error.message, 'error');
  }
});

newRuleInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addRuleBtn.click();
  }
});

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
    // 只在页面初始化加载后才开始监听状态更新
    // 避免用户正在编辑时被后台状态覆盖
    // 使用一个标志位来区分初始化阶段和运行时更新
    if (window.__settingsInitialized__) {
      applyState(message.payload);
    }
  }
});

async function initOptionsPage() {
  const stopped = await stopCaptureIfNeeded();
  await loadSettings();

  captureEnabledEl.checked = false;
  captureEnabledEl.disabled = true;
  captureEnabledEl.title = '设置页不允许开启捕获，请在 Popup 中开启';

  if (stopped) {
    setStatus('进入设置页后已自动停止捕获。修改完成后请在 Popup 开启捕获。', 'warn');
  }
}

initOptionsPage().catch((error) => {
  logError('初始化加载设置失败', error);
  setStatus(error.message, 'error');
});
