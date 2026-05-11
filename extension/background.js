function rebuildContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'save-selection-to-prompt-vault',
      title: '保存到提示词金库',
      contexts: ['selection']
    }, () => void chrome.runtime.lastError);
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  rebuildContextMenus();
  try {
    if (chrome.sidePanel?.setPanelBehavior) await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (_) {}
  const cfg = await chrome.storage.local.get(['shortcutEnabled', 'shortcutKey']);
  if (cfg.shortcutEnabled === undefined) await chrome.storage.local.set({ shortcutEnabled: true });
  if (!cfg.shortcutKey) await chrome.storage.local.set({ shortcutKey: 'Ctrl+Shift+K' });
});
chrome.runtime.onStartup.addListener(rebuildContextMenus);
rebuildContextMenus();

function normalizeApiBaseUrl(value) {
  let url = String(value || '').trim();
  if (!url) return '';
  url = url.replace(/\/+$/, '');
  if (!/\/api$/i.test(url)) url += '/api';
  return url;
}

async function getConfig() {
  const cfg = await chrome.storage.local.get(['apiBaseUrl', 'token', 'aiModel', 'shortcutEnabled', 'shortcutKey']);
  return {
    apiBaseUrl: normalizeApiBaseUrl(cfg.apiBaseUrl),
    token: cfg.token,
    aiModel: cfg.aiModel,
    shortcutEnabled: cfg.shortcutEnabled !== false,
    shortcutKey: cfg.shortcutKey || 'Ctrl+Shift+K'
  };
}

function domainFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

async function showBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3500);
}

async function requestJson(path, options = {}) {
  const { apiBaseUrl, token } = await getConfig();
  if (!apiBaseUrl || !token) throw new Error('请先在插件弹窗里登录');
  const res = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const error = new Error(data.error?.message || `请求失败：HTTP ${res.status}`);
    error.code = data.error?.code;
    error.details = data.error?.details;
    throw error;
  }
  return data.data;
}

async function saveSelection(payload) {
  const { aiModel } = await getConfig();
  if (aiModel && !payload.aiModel) payload.aiModel = aiModel;
  return requestJson('/extension/save-selection', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

async function searchPrompts(query = '', favoriteOnly = false) {
  const params = new URLSearchParams({ pageSize: '30' });
  if (query) params.set('q', query);
  if (favoriteOnly) params.set('favorite', 'true');
  const data = await requestJson(`/prompts?${params.toString()}`);
  return data.items || [];
}

async function recordPromptUse(promptId) {
  if (!promptId) return null;
  return requestJson(`/prompts/${promptId}/use`, { method: 'POST', body: '{}' });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'save-selection-to-prompt-vault') {
    try {
      const content = (info.selectionText || '').trim();
      if (!content) throw new Error('没有选中文字');
      const saved = await saveSelection({
        content,
        sourceTitle: tab?.title || '',
        sourceUrl: tab?.url || '',
        sourceDomain: domainFromUrl(tab?.url || ''),
        autoAnalyze: true
      });
      await chrome.storage.local.set({ lastResult: `保存成功：${saved.title}` });
      await showBadge('OK', '#2f7042');
    } catch (error) {
      if (error.code === 'DUPLICATE_PROMPT') {
        const match = error.details?.matches?.[0];
        await chrome.storage.local.set({ lastResult: `已保存过类似提示词：${match?.title || '可在网页端查看'}` });
        await showBadge('OLD', '#d99b36');
      } else {
        await chrome.storage.local.set({ lastResult: `保存失败：${error.message}` });
        await showBadge('ERR', '#b33a28');
      }
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'PV_SEARCH_PROMPTS') {
      const items = await searchPrompts(message.query || '', Boolean(message.favoriteOnly));
      sendResponse({ success: true, items });
      return;
    }
    if (message?.type === 'PV_GET_SETTINGS') {
      const cfg = await getConfig();
      sendResponse({ success: true, shortcutEnabled: cfg.shortcutEnabled, shortcutKey: cfg.shortcutKey });
      return;
    }
    if (message?.type === 'PV_RECORD_USE') {
      await recordPromptUse(message.promptId);
      sendResponse({ success: true });
      return;
    }
  })().catch((error) => sendResponse({ success: false, message: error.message }));
  return true;
});
