const $ = (id) => document.getElementById(id);
const state = { favorites: [], filtered: [], currentSelection: '', aiModels: [], defaultAiModel: '' };

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
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [text],
    func: (value) => {
      function isEditable(el) {
        if (!el) return false;
        const tag = String(el.tagName || '').toLowerCase();
        return el.isContentEditable || tag === 'textarea' || (tag === 'input' && !['button', 'submit', 'checkbox', 'radio'].includes(el.type));
      }
      const el = isEditable(document.activeElement) ? document.activeElement : document.querySelector('textarea, [contenteditable="true"], input[type="text"], input:not([type])');
      if (!el) {
        navigator.clipboard?.writeText(value);
        return false;
      }
      el.focus();
      if (el.isContentEditable) document.execCommand('insertText', false, value);
      else {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        el.value = el.value.slice(0, start) + value + el.value.slice(end);
        const pos = start + value.length;
        el.setSelectionRange?.(pos, pos);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }
  });
  return result;
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
  const cfg = await chrome.storage.local.get(['apiBaseUrl', 'token', 'email', 'lastResult']);
  state.currentSelection = await readPageSelection();
  if (cfg.token && cfg.email) {
    showAuthed(cfg.email);
    await loadAiModels();
    await loadFavorites();
    if (state.currentSelection) msg(`已检测到选中文字，可直接保存。`);
    else if (cfg.lastResult) msg(cfg.lastResult, cfg.lastResult.includes('失败'));
  } else {
    showLogin(cfg);
  }
}

async function loadFavorites() {
  try {
    const data = await requestJson('/prompts?favorite=true&pageSize=50');
    state.favorites = data.items || [];
    filterFavorites();
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

function filterFavorites() {
  const q = $('search').value.trim().toLowerCase();
  state.filtered = state.favorites.filter(p => !q || `${p.title} ${p.summary || ''} ${p.content || ''} ${(p.tags || []).join(' ')}`.toLowerCase().includes(q));
  renderFavorites();
}

function renderFavorites() {
  const box = $('favorites');
  if (!state.filtered.length) {
    box.innerHTML = '<p class="empty">暂无收藏提示词。先在网页端点星标收藏。</p>';
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
      const ok = await insertIntoPage(p.content || '');
      msg(ok ? '已插入当前输入框。' : '未找到输入框，已尝试复制到剪贴板。', !ok);
    };
    el.querySelector('.copy').onclick = async () => {
      await navigator.clipboard.writeText(p.content || '');
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
    await chrome.storage.local.set({ apiBaseUrl, token: data.accessToken, email, lastResult: '登录成功。' });
    showAuthed(email);
    await loadAiModels();
    await loadFavorites();
    msg('登录成功。收藏提示词会显示在这里。');
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
$('search').oninput = filterFavorites;
$('aiModel').onchange = async () => {
  await chrome.storage.local.set({ aiModel: $('aiModel').value });
  msg(`AI 整理模型已切换：${$('aiModel').value}`);
};

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"]/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[s]));
}

load().catch((error) => loginMsg(`插件初始化失败：${error.message}`, true));
