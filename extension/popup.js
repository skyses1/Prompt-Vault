const $ = (id) => document.getElementById(id);
const state = { prompts: [], filtered: [], currentSelection: '', aiModels: [], defaultAiModel: '', searchTimer: null };
const SHORTCUT_PRESETS = ['Ctrl+Shift+K', 'Ctrl+K', 'Alt+K', 'Alt+P', 'Ctrl+Shift+P', 'Custom'];

const setMsg = (id, text, bad = false) => {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = bad ? 'bad msg-inline' : 'msg-inline';
};
const msg = (text, bad = false) => setMsg('msg', text, bad);
const loginMsg = (text, bad = false) => setMsg('loginMsg', text, bad);

function normalizeApiBaseUrl(value) {
  let url = String(value || '').trim();
  if (!url) return '';
  url = url.replace(/\/+$/, '');
  if (!/\/api$/i.test(url)) url += '/api';
  return url;
}

function webUrlFromApi(apiBaseUrl) {
  return normalizeApiBaseUrl(apiBaseUrl).replace(/\/api$/i, '');
}

function domainFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

function fillTemplateVariables(text) {
  const template = String(text || '');
  const names = [...new Set([...template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1].trim()).filter(Boolean))];
  if (!names.length) return template;
  const values = {};
  for (const name of names) {
    const value = prompt(`填写变量：${name}`, '');
    if (value === null) return null;
    values[name] = value;
  }
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, name) => values[String(name).trim()] ?? '');
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function readPageSelection() {
  const tab = await getActiveTab();
  if (!tab?.id) return '';
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => String(window.getSelection?.() || '').trim()
    });
    return results?.[0]?.result || '';
  } catch (_) {
    return '';
  }
}

async function insertIntoPage(text) {
  const tab = await getActiveTab();
  if (!tab?.id) return false;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: 'PV_INSERT_TEXT', text });
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      return await chrome.tabs.sendMessage(tab.id, { type: 'PV_INSERT_TEXT', text });
    } catch (error) {
      await navigator.clipboard.writeText(text);
      return false;
    }
  }
}

async function openPageSearchPanel() {
  const tab = await getActiveTab();
  if (!tab?.id) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'PV_OPEN_COMMAND_PANEL' });
    return true;
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'PV_OPEN_COMMAND_PANEL' });
      return true;
    } catch (_) {
      return false;
    }
  }
}

async function requestJson(path, options = {}) {
  const cfg = await chrome.storage.local.get(['apiBaseUrl', 'token']);
  const apiBaseUrl = normalizeApiBaseUrl(cfg.apiBaseUrl || $('apiBaseUrl')?.value);
  if (!apiBaseUrl) throw new Error('请填写 API 地址');
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch(`${apiBaseUrl}${path}`, { ...options, headers, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接超时，请检查 API 地址和服务器');
    throw new Error(`无法连接服务器：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) {}
  if (!res.ok || data.success === false) {
    const error = new Error(data.error?.message || `请求失败：HTTP ${res.status}`);
    error.code = data.error?.code;
    error.details = data.error?.details;
    throw error;
  }
  return data.data;
}

function showAuthed(email) {
  $('accountLine').textContent = `已登录：${email}`;
  $('loginBox').classList.add('hidden');
  $('consoleBox').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
}

function showLogin(cfg = {}) {
  $('accountLine').textContent = '未登录';
  $('loginBox').classList.remove('hidden');
  $('consoleBox').classList.add('hidden');
  $('logoutBtn').classList.add('hidden');
  $('apiBaseUrl').value = cfg.apiBaseUrl || 'http://10.10.10.68:8080/api';
  $('email').value = cfg.email || '';
}

async function load() {
  const cfg = await chrome.storage.local.get(['apiBaseUrl', 'token', 'email', 'lastResult', 'favoriteOnly', 'shortcutEnabled', 'shortcutKey']);
  state.currentSelection = await readPageSelection();
  $('favoriteOnly').checked = Boolean(cfg.favoriteOnly);
  $('shortcutEnabled').checked = cfg.shortcutEnabled !== false;
  initShortcutControls(cfg.shortcutKey || 'Ctrl+Shift+K');
  if (cfg.token && cfg.email) {
    showAuthed(cfg.email);
    await loadAiModels();
    await loadPromptResults();
    if (state.currentSelection) msg('已检测到选中文字，可直接保存。');
    else if (cfg.lastResult) msg(cfg.lastResult, cfg.lastResult.includes('失败'));
  } else {
    showLogin(cfg);
  }
}

function initShortcutControls(shortcutKey) {
  $('shortcutPreset').innerHTML = SHORTCUT_PRESETS.map((item) => `<option value="${item}">${item === 'Custom' ? '自定义' : item}</option>`).join('');
  const isPreset = SHORTCUT_PRESETS.includes(shortcutKey);
  $('shortcutPreset').value = isPreset ? shortcutKey : 'Custom';
  $('customShortcut').value = isPreset ? '' : shortcutKey;
  $('customShortcutWrap').classList.toggle('hidden', $('shortcutPreset').value !== 'Custom');
}

function normalizeShortcut(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const parts = raw.split('+').map((part) => part.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) return '';
  const mods = new Set(parts.map((part) => part.toLowerCase()));
  const ordered = [];
  if (mods.has('ctrl') || mods.has('control')) ordered.push('Ctrl');
  if (mods.has('shift')) ordered.push('Shift');
  if (mods.has('alt') || mods.has('option')) ordered.push('Alt');
  if (mods.has('meta') || mods.has('cmd') || mods.has('command')) ordered.push('Meta');
  const normalizedKey = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
  if (!ordered.length) return '';
  return [...ordered, normalizedKey].join('+');
}

async function saveShortcutSetting() {
  let shortcutKey = $('shortcutPreset').value;
  if (shortcutKey === 'Custom') shortcutKey = normalizeShortcut($('customShortcut').value);
  if (!shortcutKey) {
    msg('自定义快捷键格式不正确，例如 Ctrl+Alt+P', true);
    return;
  }
  await chrome.storage.local.set({ shortcutEnabled: $('shortcutEnabled').checked, shortcutKey });
  msg(`快捷键已设置：${shortcutKey}`);
}

async function loadPromptResults() {
  try {
    const q = $('search')?.value?.trim() || '';
    const favoriteOnly = Boolean($('favoriteOnly')?.checked);
    const params = new URLSearchParams({ pageSize: '50' });
    if (q) params.set('q', q);
    if (favoriteOnly) params.set('favorite', 'true');
    const data = await requestJson(`/prompts?${params.toString()}`);
    state.prompts = data.items || [];
    filterPrompts();
  } catch (error) {
    msg(error.message, true);
  }
}

async function loadAiModels() {
  try {
    const cfg = await chrome.storage.local.get(['aiModel']);
    const data = await requestJson('/ai/models');
    state.aiModels = data.models || ['qwen3.6-max-preview', 'Qwen3.6-Plus'];
    state.defaultAiModel = data.defaultModel || state.aiModels[0] || '';
    $('aiModel').innerHTML = state.aiModels.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('');
    $('aiModel').value = cfg.aiModel && state.aiModels.includes(cfg.aiModel) ? cfg.aiModel : state.defaultAiModel;
  } catch (_) {
    state.aiModels = ['qwen3.6-max-preview', 'Qwen3.6-Plus'];
    state.defaultAiModel = state.aiModels[0];
    $('aiModel').innerHTML = state.aiModels.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('');
    $('aiModel').value = state.defaultAiModel;
  }
}

function filterPrompts() {
  const q = $('search').value.trim().toLowerCase();
  state.filtered = state.prompts.filter(p => !q || `${p.title} ${p.summary || ''} ${p.content || ''} ${(p.tags || []).join(' ')}`.toLowerCase().includes(q));
  renderPrompts();
}

function renderPrompts() {
  const box = $('favorites');
  if (!state.filtered.length) {
    box.innerHTML = '<p class="empty">没有匹配的提示词。</p>';
    return;
  }
  box.innerHTML = state.filtered.slice(0, 8).map((p, i) => `
    <article class="fav" data-index="${i}">
      <strong>${escapeHtml(p.title)}</strong>
      <p>${escapeHtml(p.summary || (p.content || '').slice(0, 56))}</p>
      <div><button class="insert" type="button">插入</button><button class="copy light" type="button">复制</button></div>
    </article>`).join('');
  box.querySelectorAll('.fav').forEach((el) => {
    const p = state.filtered[Number(el.dataset.index)];
    el.querySelector('.insert').onclick = async () => {
      const text = fillTemplateVariables(p.content || '');
      if (text === null) return;
      await navigator.clipboard.writeText(text);
      const ok = await insertIntoPage(text);
      requestJson(`/prompts/${p.id}/use`, { method: 'POST', body: '{}' }).catch(() => {});
      msg(ok ? '已复制并插入当前输入框。' : '未找到输入框，已复制到剪贴板。', !ok);
    };
    el.querySelector('.copy').onclick = async () => {
      const text = fillTemplateVariables(p.content || '');
      if (text === null) return;
      await navigator.clipboard.writeText(text);
      requestJson(`/prompts/${p.id}/use`, { method: 'POST', body: '{}' }).catch(() => {});
      msg('已复制到剪贴板。');
    };
  });
}

async function login() {
  const apiBaseUrl = normalizeApiBaseUrl($('apiBaseUrl').value);
  const email = $('email').value.trim().toLowerCase();
  const password = $('password').value;
  if (!apiBaseUrl) return loginMsg('请填写 API 地址。', true);
  if (!email || !password) return loginMsg('请填写邮箱和密码。', true);
  $('loginBtn').disabled = true;
  $('loginBtn').textContent = '正在登录...';
  loginMsg(`正在连接：${apiBaseUrl}`);
  try {
    const data = await requestJson('/auth/login', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ email, password })
    });
    await chrome.storage.local.set({ apiBaseUrl, token: data.accessToken, email, lastResult: '登录成功。', shortcutEnabled: true, shortcutKey: $('shortcutPreset')?.value === 'Custom' ? normalizeShortcut($('customShortcut').value) || 'Ctrl+Shift+K' : ($('shortcutPreset')?.value || 'Ctrl+Shift+K') });
    showAuthed(email);
    await loadAiModels();
    await loadPromptResults();
    msg('登录成功。现在可以搜索全部提示词。');
  } catch (e) {
    loginMsg(e.message, true);
  } finally {
    $('loginBtn').disabled = false;
    $('loginBtn').textContent = '登录插件';
  }
}

async function saveContent(content, sourceTitle = '') {
  if (!content.trim()) throw new Error('保存内容为空');
  const tab = await getActiveTab();
  const data = await requestJson('/extension/save-selection', {
    method: 'POST',
    body: JSON.stringify({
      content: content.trim(),
      sourceTitle: sourceTitle || tab?.title || 'Chrome 插件提交',
      sourceUrl: tab?.url || '',
      sourceDomain: domainFromUrl(tab?.url || ''),
      aiModel: $('aiModel')?.value || state.defaultAiModel,
      autoAnalyze: true
    })
  });
  await chrome.storage.local.set({ lastResult: `保存成功：${data.title}` });
  return data;
}

$('loginBtn').onclick = login;
$('logoutBtn').onclick = async () => {
  const cfg = await chrome.storage.local.get(['apiBaseUrl', 'email']);
  await chrome.storage.local.remove(['token', 'lastResult']);
  showLogin(cfg);
};
$('saveSelectionBtn').onclick = async () => {
  try {
    state.currentSelection = await readPageSelection();
    if (!state.currentSelection) throw new Error('没有检测到选中文字。请先选中文本，或使用右键保存。');
    const data = await saveContent(state.currentSelection);
    msg(`保存成功：${data.title}`);
  } catch (e) {
    if (e.code === 'DUPLICATE_PROMPT') {
      const match = e.details?.matches?.[0];
      msg(`已保存过类似提示词：${match?.title || '请在网页端查看'}`, true);
    } else {
      msg(e.message, true);
    }
  }
};
$('manualSaveBtn').onclick = async () => {
  try {
    const data = await saveContent($('manualContent').value, '手动粘贴保存');
    $('manualContent').value = '';
    msg(`保存成功：${data.title}`);
  } catch (e) {
    if (e.code === 'DUPLICATE_PROMPT') {
      const match = e.details?.matches?.[0];
      msg(`已保存过类似提示词：${match?.title || '请在网页端查看'}`, true);
    } else {
      msg(e.message, true);
    }
  }
};
$('openWebBtn').onclick = async () => {
  const cfg = await chrome.storage.local.get(['apiBaseUrl']);
  chrome.tabs.create({ url: webUrlFromApi(cfg.apiBaseUrl || 'http://10.10.10.68:8080/api') });
};
$('openPanelBtn').onclick = async () => {
  const ok = await openPageSearchPanel();
  msg(ok ? '已在当前页面打开搜索框。' : '当前页面不允许注入搜索框，请换到 ChatGPT 等普通网页后再试。', !ok);
};
$('openSidePanelBtn').onclick = async () => {
  try {
    const tab = await getActiveTab();
    if (tab?.windowId && chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      msg('已打开浏览器侧边栏。');
    } else {
      msg('当前 Chrome 版本不支持插件侧边栏。', true);
    }
  } catch (error) {
    msg(`侧边栏打开失败：${error.message}`, true);
  }
};
$('search').oninput = () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(loadPromptResults, 250);
};
$('favoriteOnly').onchange = async () => {
  await chrome.storage.local.set({ favoriteOnly: $('favoriteOnly').checked });
  $('search').placeholder = $('favoriteOnly').checked ? '搜索收藏提示词...' : '搜索全部提示词...';
  loadPromptResults();
};
$('shortcutEnabled').onchange = async () => {
  await saveShortcutSetting();
};
$('shortcutPreset').onchange = async () => {
  $('customShortcutWrap').classList.toggle('hidden', $('shortcutPreset').value !== 'Custom');
  await saveShortcutSetting();
};
$('customShortcut').onchange = saveShortcutSetting;
$('aiModel').onchange = async () => {
  await chrome.storage.local.set({ aiModel: $('aiModel').value });
  msg(`AI 整理模型已切换：${$('aiModel').value}`);
};

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"]/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[s]));
}

load().catch((error) => loginMsg(`插件初始化失败：${error.message}`, true));
