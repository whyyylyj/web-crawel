// 页面脚本 - 注入到页面的主世界（MAIN world）中
// 此脚本与页面代码在同一上下文，可以 Hook fetch/XMLHttpRequest

(() => {
  // 标记已初始化，避免重复注入
  if (window.__NETWORK_CAPTURE_PAGE_INIT__) {
    window.postMessage({
      source: 'network-capture-page',
      payload: { type: 'init', status: 'already_injected' }
    }, '*');
    return;
  }
  window.__NETWORK_CAPTURE_PAGE_INIT__ = true;

  const SOURCE = 'network-capture-page';
  const MAX_LEN = 200000;
  let captureStats = { fetch: 0, xhr: 0, errors: 0 };

  const clamp = (text) => {
    // 处理非字符串类型
    if (typeof text !== 'string') {
      if (text === null || text === undefined) {
        return '';
      }
      try {
        // 尝试将 JSON 对象转换为字符串
        return String(text);
      } catch {
        return '[unconvertible value]';
      }
    }
    if (text.length <= MAX_LEN) return text;
    return text.slice(0, MAX_LEN) + '\n...<TRUNCATED ' + (text.length - MAX_LEN) + ' chars>';
  };

  const postPayload = (payload) => {
    // 调试日志：记录发送的数据
    if (payload.channel === 'fetch' || payload.channel === 'xhr') {
      const hasBody = payload.responseBody && payload.responseBody.length > 0;
      console.debug('[NetworkCapture Page] 发送网络事件:', {
        channel: payload.channel,
        method: payload.method,
        url: payload.url?.substring(0, 60),
        status: payload.status,
        hasBody,
        bodyLength: payload.responseBody?.length || 0
      });
    }
    window.postMessage({ source: SOURCE, payload }, '*');
  };

  // 通知初始化成功
  postPayload({ type: 'init', status: 'success' });

  // Hook fetch
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function patchedFetch(input, init) {
      const start = performance.now();
      const method = (init && init.method) || (input && input.method) || 'GET';
      // 处理 URL：支持 Request 对象或字符串
      let url = '';
      try {
        url = (typeof input === 'string') ? input : (input instanceof Request ? (input.url || '') : '');
      } catch (e) {
        url = String(input || '');
      }
      let requestBody = init && init.body ? String(init.body) : '';

      try {
        const response = await originalFetch.apply(this, arguments);
        const cloned = response.clone();

        let responseBody = '';
        try {
          responseBody = await cloned.text();
          console.debug(`[NetworkCapture Page] Fetch response body captured: ${url?.substring(0, 50)}..., length: ${responseBody?.length || 0}`);
        } catch (e) {
          console.warn('[NetworkCapture Page] Failed to read fetch response body:', e.message);
          responseBody = '[unreadable fetch response body]';
        }

        // 即使 responseBody 为空，也发送数据（可能确实是空响应）
        const payload = {
          channel: 'fetch',
          method: String(method).toUpperCase(),
          url,
          status: response.status,
          requestBody: clamp(requestBody),
          responseBody: clamp(responseBody),
          durationMs: performance.now() - start,
          timestamp: Date.now()
        };

        captureStats.fetch++;
        postPayload(payload);

        return response;
      } catch (error) {
        console.error('[NetworkCapture Page] Fetch error:', error);
        captureStats.errors++;
        postPayload({
          channel: 'fetch',
          method: String(method).toUpperCase(),
          url,
          status: -1,
          requestBody: clamp(requestBody),
          responseBody: '[fetch error] ' + (error && error.message ? error.message : String(error)),
          durationMs: performance.now() - start,
          timestamp: Date.now()
        });
        throw error;
      }
    };
  }

  // Hook XMLHttpRequest
  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR && OriginalXHR.prototype) {
    const open = OriginalXHR.prototype.open;
    const send = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function patchedOpen(method, url) {
      this.__nc_method = String(method || 'GET').toUpperCase();
      this.__nc_url = String(url || '');
      return open.apply(this, arguments);
    };

    OriginalXHR.prototype.send = function patchedSend(body) {
      this.__nc_start = performance.now();
      this.__nc_request_body = body ? String(body) : '';

      const done = () => {
        let responseBody = '';
        try {
          responseBody = this.responseType && this.responseType !== 'text' && this.responseType !== ''
            ? '[non-text xhr response: ' + (this.responseType || 'unknown') + ']'
            : String(this.responseText || '');
        } catch (e) {
          responseBody = '[unreadable xhr response body]';
        }

        captureStats.xhr++;
        postPayload({
          channel: 'xhr',
          method: this.__nc_method || 'GET',
          url: this.__nc_url || '',
          status: Number(this.status || 0),
          requestBody: clamp(this.__nc_request_body || ''),
          responseBody: clamp(responseBody),
          durationMs: performance.now() - (this.__nc_start || performance.now()),
          timestamp: Date.now()
        });
      };

      this.addEventListener('load', done, { once: true });
      this.addEventListener('error', done, { once: true });
      this.addEventListener('abort', done, { once: true });
      this.addEventListener('timeout', done, { once: true });

      return send.apply(this, arguments);
    };
  }

  // 暴露统计信息供调试
  window.__NETWORK_CAPTURE_STATS__ = () => captureStats;
})();
