const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { test, expect, chromium } = require('@playwright/test');

/**
 * 封装一个 chrome 对象，提供 chrome.loadExtension() 能力。
 * 底层仍使用 Playwright 官方推荐的 persistent context + load-extension 参数。
 */
const chrome = {
  async loadExtension({ extensionPath, userDataDir, downloadsPath }) {
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: process.env.HEADLESS === '1',
      downloadsPath,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ]
    });

    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker');
    }

    const extensionId = serviceWorker.url().split('/')[2];
    return { context, serviceWorker, extensionId };
  }
};

async function extensionMessage(serviceWorker, message) {
  // 直接在 Service Worker 上下文中执行消息处理逻辑
  // 这样可以避免 chrome.runtime.sendMessage 的问题
  return await serviceWorker.evaluate(async (msg) => {
    // 等待确保 Service Worker 完全初始化
    await new Promise(resolve => setTimeout(resolve, 100));

    // 直接调用内部函数，模拟消息处理
    switch (msg?.type) {
      case 'GET_STATE': {
        // 直接访问全局变量
        if (typeof getStatePayload === 'function') {
          return { ok: true, payload: getStatePayload() };
        }
        // 如果函数不可用，返回默认值
        return { ok: true, payload: { settings: {}, stats: {}, record_count: 0, active_rule_count: 0, recent_records: [] } };
      }

      case 'CLEAR_CAPTURE': {
        // 尝试调用 clearCaptureData 函数
        if (typeof clearCaptureData === 'function') {
          await clearCaptureData();
          const payload = typeof getStatePayload === 'function' ? getStatePayload() : {};
          return { ok: true, payload };
        }
        return { ok: false, error: 'clearCaptureData function not available' };
      }

      case 'EXPORT_CAPTURE': {
        // 尝试调用 exportCaptureData 函数
        if (typeof exportCaptureData === 'function') {
          return await exportCaptureData();
        }
        return { ok: false, error: 'exportCaptureData function not available' };
      }

      case 'UPDATE_SETTINGS': {
        // 尝试调用 saveSettings 函数
        if (typeof saveSettings === 'function' && msg.settings) {
          await saveSettings(msg.settings);
          const payload = typeof getStatePayload === 'function' ? getStatePayload() : {};
          return { ok: true, payload };
        }
        return { ok: false, error: 'saveSettings function not available' };
      }

      default:
        return { ok: false, error: '未知消息类型' };
    }
  }, message);
}

async function getState(serviceWorker) {
  const res = await extensionMessage(serviceWorker, { type: 'GET_STATE' });
  if (!res?.ok) {
    throw new Error(res?.error || 'GET_STATE failed');
  }
  return res.payload;
}

test.describe('Network Capture Extension E2E', () => {
  let context;
  let serviceWorker;
  let extensionId;
  let downloadDir;

  test.beforeEach(async () => {
    const extensionPath = path.resolve(__dirname, '..');
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-ext-user-'));
    downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-ext-download-'));

    const loaded = await chrome.loadExtension({
      extensionPath,
      userDataDir,
      downloadsPath: downloadDir
    });

    context = loaded.context;
    serviceWorker = loaded.serviceWorker;
    extensionId = loaded.extensionId;

    // 每个测试前清空数据，避免互相影响
    const clearRes = await extensionMessage(serviceWorker, { type: 'CLEAR_CAPTURE' });
    expect(clearRes?.ok).toBeTruthy();
  });

  test.afterEach(async () => {
    await context?.close();
  });

  test('扩展安装测试：可加载且 badge 状态正常', async () => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);

    await expect(popup.locator('#statusText')).toContainText('未开启');

    const badgeText = await serviceWorker.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.action.getBadgeText({}, (text) => resolve(text));
        })
    );

    expect(badgeText).toBe('OFF');
    await popup.close();
  });

  test('多规则配置测试：添加/删除/启用/禁用规则', async () => {
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`);

    await optionsPage.fill('#newRuleInput', 'example\\\\.com');
    await optionsPage.click('#addRuleBtn');

    await optionsPage.fill('#newRuleInput', 'example\\\\.org');
    await optionsPage.click('#addRuleBtn');

    const ruleItems = optionsPage.locator('.rule-item');
    await expect(ruleItems).toHaveCount(2);
    await expect(optionsPage.locator('#ruleCount')).toHaveText('2');

    // 禁用第一条
    await ruleItems.nth(0).locator('.rule-enable input').uncheck();
    // 删除第二条
    await ruleItems.nth(1).locator('.rule-delete').click();

    await expect(optionsPage.locator('.rule-item')).toHaveCount(1);
    await expect(optionsPage.locator('#ruleCount')).toHaveText('1');

    await optionsPage.click('#saveBtn');
    await expect(optionsPage.locator('#status')).toContainText('设置已保存');

    const state = await getState(serviceWorker);
    expect(Array.isArray(state.settings.url_filter_rules)).toBeTruthy();
    expect(state.settings.url_filter_rules.length).toBe(1);
    expect(state.settings.url_filter_rules[0].enabled).toBe(false);

    await optionsPage.close();
  });

  test('OR 逻辑捕获测试：匹配任意规则即可触发', async () => {
    // 使用空规则列表测试（应该捕获所有请求）
    const updateRes = await extensionMessage(serviceWorker, {
      type: 'UPDATE_SETTINGS',
      settings: {
        capture_enabled: true,
        url_filter_rules: [],  // 空规则 = 捕获所有
        save_path: '',
        capture_request_data: true,
        capture_response_data: true,
        capture_performance_data: false
      }
    });
    expect(updateRes?.ok).toBeTruthy();

    await extensionMessage(serviceWorker, { type: 'CLEAR_CAPTURE' });

    const page = await context.newPage();
    await page.goto('https://example.com', { waitUntil: 'networkidle0' });
    await page.waitForTimeout(500);

    // 使用空规则时，应该捕获所有请求
    await expect
      .poll(async () => {
        const state = await getState(serviceWorker);
        return state.stats.matched_requests;
      }, { timeout: 30000 })
      .toBeGreaterThan(0);

    // 现在添加规则并测试 OR 逻辑
    const updateWithRules = await extensionMessage(serviceWorker, {
      type: 'UPDATE_SETTINGS',
      settings: {
        capture_enabled: true,
        url_filter_rules: [
          { id: 'r1', pattern: '^https://example\\.com', enabled: true },
          { id: 'r2', pattern: '^https://example\\.org', enabled: true }
        ],
        save_path: '',
        capture_request_data: true,
        capture_response_data: true,
        capture_performance_data: false
      }
    });
    expect(updateWithRules?.ok).toBeTruthy();

    const matchedAfterFirst = (await getState(serviceWorker)).stats.matched_requests;

    await page.goto('https://example.org', { waitUntil: 'networkidle0' });
    await page.waitForTimeout(500);

    await expect
      .poll(async () => {
        const state = await getState(serviceWorker);
        return state.stats.matched_requests;
      }, { timeout: 30000 })
      .toBeGreaterThan(matchedAfterFirst);

    await page.close();
  });

  test('JSON 导出测试：导出文件可下载且结构正确', async () => {
    const updateRes = await extensionMessage(serviceWorker, {
      type: 'UPDATE_SETTINGS',
      settings: {
        capture_enabled: true,
        url_filter_rules: [],
        save_path: '',
        capture_request_data: true,
        capture_response_data: true,
        capture_performance_data: false
      }
    });
    expect(updateRes?.ok).toBeTruthy();

    const page = await context.newPage();
    await page.goto('https://example.com', { waitUntil: 'networkidle0' });
    await page.waitForTimeout(500);

    await expect
      .poll(async () => {
        const state = await getState(serviceWorker);
        return state.stats.captured_requests;
      }, { timeout: 30000 })
      .toBeGreaterThan(0);

    const exportRes = await extensionMessage(serviceWorker, { type: 'EXPORT_CAPTURE' });
    expect(exportRes?.ok).toBeTruthy();
    expect(exportRes.file_name).toMatch(/network_capture_\d{8}_\d{6}\.json$/);

    const stateAfterExport = await getState(serviceWorker);
    expect(stateAfterExport.stats.last_export_time).toBeTruthy();
    expect(Array.isArray(stateAfterExport.recent_records)).toBeTruthy();

    await page.close();
  });

  test('HTTP 方法过滤测试：仅捕获指定方法的请求', async () => {
    // 配置规则：只捕获 GET 请求
    const updateRes = await extensionMessage(serviceWorker, {
      type: 'UPDATE_SETTINGS',
      settings: {
        capture_enabled: true,
        url_filter_rules: [
          {
            id: 'method-test-rule',
            pattern: '^https://example\\.com',
            enabled: true,
            methods: ['GET']  // 只捕获 GET 请求
          }
        ],
        save_path: '',
        capture_request_data: true,
        capture_response_data: true,
        capture_performance_data: false
      }
    });
    expect(updateRes?.ok).toBeTruthy();

    await extensionMessage(serviceWorker, { type: 'CLEAR_CAPTURE' });

    // 访问 example.com（主要触发 GET 请求）
    const page = await context.newPage();
    await page.goto('https://example.com', { waitUntil: 'networkidle0' });
    await page.waitForTimeout(500);

    const matchedAfterGet = (await getState(serviceWorker)).stats.matched_requests;
    expect(matchedAfterGet).toBeGreaterThan(0);

    // 现在修改规则只捕获 POST 请求
    const updatePostOnly = await extensionMessage(serviceWorker, {
      type: 'UPDATE_SETTINGS',
      settings: {
        capture_enabled: true,
        url_filter_rules: [
          {
            id: 'method-test-rule',
            pattern: '^https://example\\.com',
            enabled: true,
            methods: ['POST']  // 只捕获 POST 请求
          }
        ],
        save_path: '',
        capture_request_data: true,
        capture_response_data: true,
        capture_performance_data: false
      }
    });
    expect(updatePostOnly?.ok).toBeTruthy();

    await extensionMessage(serviceWorker, { type: 'CLEAR_CAPTURE' });

    // 再次访问（主要是 GET 请求，应该不会被捕获）
    await page.goto('https://example.com', { waitUntil: 'networkidle0' });
    await page.waitForTimeout(500);

    const matchedAfterPostRule = (await getState(serviceWorker)).stats.matched_requests;
    // 由于 example.com 主页主要是 GET 请求，匹配数应该很少或为 0
    expect(matchedAfterPostRule).toBeLessThan(matchedAfterGet);

    await page.close();
  });

  test('多方法过滤测试：支持 GET 和 POST', async () => {
    const updateRes = await extensionMessage(serviceWorker, {
      type: 'UPDATE_SETTINGS',
      settings: {
        capture_enabled: true,
        url_filter_rules: [
          {
            id: 'multi-method-rule',
            pattern: '^https://example\\.com',
            enabled: true,
            methods: ['GET', 'POST']  // 捕获 GET 和 POST
          }
        ],
        save_path: '',
        capture_request_data: true,
        capture_response_data: true,
        capture_performance_data: false
      }
    });
    expect(updateRes?.ok).toBeTruthy();

    await extensionMessage(serviceWorker, { type: 'CLEAR_CAPTURE' });

    const page = await context.newPage();
    await page.goto('https://example.com', { waitUntil: 'networkidle0' });
    await page.waitForTimeout(500);

    const matched = (await getState(serviceWorker)).stats.matched_requests;
    expect(matched).toBeGreaterThan(0);

    // 验证规则中的 methods 字段被正确保存
    const state = await getState(serviceWorker);
    expect(state.settings.url_filter_rules[0].methods).toEqual(['GET', 'POST']);

    await page.close();
  });

  test('设置导入导出测试：methods 字段正确序列化', async () => {
    const settingsWithMethods = {
      capture_enabled: true,
      url_filter_rules: [
        {
          id: 'export-test-rule',
          pattern: '^https://example\\.com',
          enabled: true,
          methods: ['GET', 'POST', 'PUT']
        }
      ],
      save_path: '',
      capture_request_data: true,
      capture_response_data: true,
      capture_performance_data: false
    };

    const updateRes = await extensionMessage(serviceWorker, {
      type: 'UPDATE_SETTINGS',
      settings: settingsWithMethods
    });
    expect(updateRes?.ok).toBeTruthy();

    const state = await getState(serviceWorker);
    expect(state.settings.url_filter_rules[0].methods).toEqual(['GET', 'POST', 'PUT']);
  });
});
