/*
 * 内容脚本：
 * 1) 注入页面脚本，在主世界 Hook fetch / XHR
 * 2) 通过 window.postMessage 将抓取结果传给内容脚本
 * 3) 内容脚本再转发给 background service worker
 */

(() => {
  const CONTEXT_INIT_FLAG = '__NETWORK_CAPTURE_CONTENT_CONTEXT_INIT__';
  const INJECT_FLAG = '__NETWORK_CAPTURE_INJECTED__';
  const SUCCESS_FLAG = '__NETWORK_CAPTURE_SUCCESS__';
  const SCRIPTING_API_ATTEMPTED = '__SCRIPTING_API_ATTEMPTED__';

  // 检查是否已经注入过
  if (globalThis[CONTEXT_INIT_FLAG]) {
    return;
  }
  globalThis[CONTEXT_INIT_FLAG] = true;
  globalThis[INJECT_FLAG] = true;

  // 记录注入开始时间，用于调试
  const injectStartTime = performance.now();
  let injectAttempts = 0;
  const MAX_INJECT_ATTEMPTS = 3;
  let contextInvalidated = false;
  let invalidatedWarned = false;

  function logInfo(...args) {
    console.info('[NetworkCapture Content]', ...args);
  }

  function logWarn(...args) {
    console.warn('[NetworkCapture Content]', ...args);
  }

  function logError(...args) {
    console.error('[NetworkCapture Content]', ...args);
  }

  // 获取页面脚本 URL（扩展内部资源）
  function getPageScriptUrl() {
    try {
      return chrome.runtime.getURL('content/page-script.js');
    } catch {
      return '';
    }
  }

  // 监听页面脚本是否成功初始化
  window.addEventListener('message', (event) => {
    if (event.data?.source === 'network-capture-page' && event.data.payload?.type === 'init') {
      globalThis[SUCCESS_FLAG] = true;
      const elapsed = performance.now() - injectStartTime;
      logInfo(`页面脚本初始化成功 (耗时: ${elapsed.toFixed(2)}ms)`);
    }
  });

  // 方案1：使用 Blob URL 注入（绕过大部分 CSP 限制）
  function injectPageScript() {
    injectAttempts++;

    try {
      // 检查 DOM 是否就绪
      const container = document.documentElement || document.head || document.body;
      if (!container) {
        throw new Error('找不到合适的 DOM 容器注入脚本');
      }

      // 直接使用扩展内部脚本 URL（通过 script.src 加载，不是内联）
      // 这样可以绕过 CSP 的内联脚本限制
      const scriptUrl = getPageScriptUrl();
      if (!scriptUrl) {
        throw new Error('无法获取页面脚本 URL（扩展上下文可能已失效）');
      }
      const script = document.createElement('script');
      script.src = scriptUrl;

      // 同步执行以确保尽早 hook
      script.async = false;

      // 加载完成后的处理
      script.onload = () => {
        logInfo(`页面脚本注入成功 (扩展资源方式, 尝试次数: ${injectAttempts})`);

        // 验证注入是否成功
        setTimeout(() => {
          if (!globalThis[SUCCESS_FLAG]) {
            logWarn('页面脚本已加载但未收到初始化消息，可能是脚本执行失败');
            tryScriptingApiInject();
          }
        }, 500);
      };

      script.onerror = () => {
        logError('页面脚本加载失败 (网络错误或 CSP 阻止)');
        if (injectAttempts < MAX_INJECT_ATTEMPTS) {
          const delay = injectAttempts * 100;
          setTimeout(() => {
            logInfo(`准备重试注入... (${delay}ms 后)`);
            injectPageScript();
          }, delay);
        } else {
          tryScriptingApiInject();
        }
      };

      container.appendChild(script);
      return true;
    } catch (error) {
      logError(`页面脚本注入失败 (尝试 ${injectAttempts}/${MAX_INJECT_ATTEMPTS}):`, error.message);

      // 如果还有重试机会，延迟后重试
      if (injectAttempts < MAX_INJECT_ATTEMPTS) {
        const delay = injectAttempts * 100;
        setTimeout(() => {
          logInfo(`准备重试注入... (${delay}ms 后)`);
          injectPageScript();
        }, delay);
        return false;
      }

      // 达到最大重试次数，尝试使用 scripting API
      tryScriptingApiInject();
      return false;
    }
  }

  // 方案2：使用 chrome.scripting API 注入（最可靠，但需要 background 配合）
  function tryScriptingApiInject() {
    if (globalThis[SUCCESS_FLAG]) {
      logInfo('页面脚本已成功初始化，无需备用注入');
      return;
    }

    // 避免重复尝试
    if (globalThis[SCRIPTING_API_ATTEMPTED]) {
      return;
    }
    globalThis[SCRIPTING_API_ATTEMPTED] = true;

    logWarn('尝试使用 chrome.scripting API 注入页面脚本（最可靠的 CSP 绕过方案）...');

    // 请求 background 使用 scripting API 注入
    chrome.runtime.sendMessage({
      type: 'INJECT_PAGE_SCRIPT'
    }).then((response) => {
      if (response.ok) {
        logInfo('已请求 background 使用 scripting API 注入页面脚本');
        // 等待一段时间后验证是否成功
        setTimeout(() => {
          if (!globalThis[SUCCESS_FLAG]) {
            logWarn('使用 scripting API 后仍未收到初始化消息，可能存在其他问题');
            showFailureHelp();
          }
        }, 1000);
      } else {
        logError('请求 background 注入失败:', response.error);
        showFailureHelp();
      }
    }).catch((error) => {
      logError('发送注入请求到 background 失败:', error.message);
      showFailureHelp();
    });
  }

  function showFailureHelp() {
    logWarn('页面脚本注入失败，response body 捕获可能不工作。');
    logWarn('可能原因：1) CSP 限制 2) 扩展权限不足 3) 页面环境特殊');
    logWarn('建议：刷新页面或检查浏览器控制台错误信息');

    console.group('%c[Network Capture] 页面脚本注入失败', 'color: red; font-weight: bold');
    console.warn('Response body 捕获功能无法正常工作');
    console.warn('可能原因：');
    console.warn('  1. Content Security Policy (CSP) 限制');
    console.warn('  2. 扩展权限不足');
    console.warn('  3. 页面环境特殊');
    console.warn('建议：刷新页面或检查浏览器控制台错误信息');
    console.groupEnd();

    // 通知 background
    chrome.runtime.sendMessage({
      type: 'PAGE_SCRIPT_INJECT_FAILED',
      url: window.location.href,
      attempts: injectAttempts
    }).catch(() => {
      // 忽略错误
    });
  }

  // 立即尝试注入
  injectPageScript();

  // 监听页面脚本发来的消息
  function handlePageMessage(event) {
    // 验证消息来源和格式
    if (event.source !== window || !event.data || event.data.source !== 'network-capture-page') {
      return;
    }

    const payload = event.data.payload;

    // 忽略初始化消息
    if (payload?.type === 'init') {
      return;
    }

    if (contextInvalidated) {
      return;
    }

    // 发送消息到 background service worker
    // 确保包含 tabId 以便正确合并 webRequest 记录
    try {
      chrome.runtime.sendMessage({
        type: 'CONTENT_NETWORK_EVENT',
        payload: {
          ...payload,
          tabId: payload.tabId  // 如果 page script 已经包含 tabId 则使用
        }
      }, (response) => {
        // 检查 extension context 是否失效
        if (chrome.runtime.lastError) {
          const errorMsg = chrome.runtime.lastError.message;
          // 扩展上下文失效后停止继续转发，避免刷屏报错
          if (errorMsg.includes('Extension context invalidated')) {
            contextInvalidated = true;
            if (!invalidatedWarned) {
              invalidatedWarned = true;
              logWarn('检测到扩展上下文失效，等待后台重注入脚本或刷新页面后恢复。');
            }
            return;
          }
          logError('发送消息到 background 失败:', errorMsg);
        }
        // 如果需要处理 response，在这里处理
      });
    } catch (error) {
      // 捕获同步错误（如参数错误）
      logError('发送消息时发生错误:', error.message);
      if (String(error.message || '').includes('Extension context invalidated')) {
        contextInvalidated = true;
      }
    }
  }

  window.addEventListener('message', handlePageMessage);

  // 监听来自 background 的消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'PING_CONTENT_SCRIPT') {
      sendResponse({
        ok: true,
        injected: globalThis[INJECT_FLAG],
        pageScriptSuccess: globalThis[SUCCESS_FLAG],
        injectAttempts: injectAttempts
      });
      return false;
    }

    if (message?.type === 'CONTENT_SCRIPT_REINJECTED') {
      contextInvalidated = false;
      invalidatedWarned = false;
      sendResponse({ ok: true });
      return false;
    }
  });

  // 定期检查页面脚本状态（仅用于调试）
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    setInterval(() => {
      if (window.__NETWORK_CAPTURE_STATS__) {
        const stats = window.__NETWORK_CAPTURE_STATS__();
        logInfo('捕获统计:', stats);
      }
    }, 30000); // 每 30 秒输出一次
  }
})();
