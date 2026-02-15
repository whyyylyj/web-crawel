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
