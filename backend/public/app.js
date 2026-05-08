const state = {
  token: localStorage.getItem('pv_token') || '',
  user: null,
  prompts: [],
  categories: [],
  aiModels: [],
  defaultAiModel: '',
  selected: null,
  filter: 'all',
  categoryId: '',
  q: '',
};

const $ = (id) => document.getElementById(id);
const api = async (path, options = {}) => {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const error = new Error(data.error?.message || '请求失败');
    error.code = data.error?.code;
    error.details = data.error?.details;
    error.status = res.status;
    throw error;
  }
  return data.data;
};

function showAuth(show) {
  $('auth').classList.toggle('hidden', !show);
  $('app').classList.toggle('hidden', show);
}

function message(id, text, isError = false) {
  const el = $(id);
  el.textContent = text || '';
  el.classList.toggle('error', isError);
}

async function boot() {
  bindEvents();
  if (!state.token) return showAuth(true);
  try {
    state.user = await api('/api/auth/me');
    showAuth(false);
    $('userInfo').textContent = state.user.email;
    await loadAll();
  } catch (_) {
    localStorage.removeItem('pv_token');
    state.token = '';
    showAuth(true);
  }
}

function bindEvents() {
  $('loginTab').onclick = () => switchTab('login');
  $('registerTab').onclick = () => switchTab('register');
  $('loginForm').onsubmit = login;
  $('registerForm').onsubmit = register;
  $('logoutBtn').onclick = logout;
  $('newPromptBtn').onclick = openNewDialog;
  $('cancelDialog').onclick = () => $('promptDialog').close();
  $('promptForm').onsubmit = savePrompt;
  $('searchBtn').onclick = () => { state.q = $('searchInput').value.trim(); loadPrompts(); };
  $('clearBtn').onclick = () => { $('searchInput').value = ''; state.q = ''; state.filter = 'all'; state.categoryId = ''; setNavActive(); loadPrompts(); };
  $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('searchBtn').click(); });
  document.querySelectorAll('.nav').forEach((btn) => btn.onclick = () => { state.filter = btn.dataset.filter; state.categoryId = ''; setNavActive(); loadPrompts(); });
}

function switchTab(tab) {
  $('loginTab').classList.toggle('active', tab === 'login');
  $('registerTab').classList.toggle('active', tab === 'register');
  $('loginForm').classList.toggle('hidden', tab !== 'login');
  $('registerForm').classList.toggle('hidden', tab !== 'register');
  message('authMessage', '');
}

async function login(e) {
  e.preventDefault();
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: $('loginEmail').value, password: $('loginPassword').value }) });
    state.token = data.accessToken;
    state.user = data.user;
    localStorage.setItem('pv_token', state.token);
    showAuth(false);
    $('userInfo').textContent = data.user.email;
    await loadAll();
  } catch (err) { message('authMessage', err.message, true); }
}

async function register(e) {
  e.preventDefault();
  try {
    const data = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: $('registerName').value, email: $('registerEmail').value, password: $('registerPassword').value }) });
    state.token = data.accessToken;
    state.user = data.user;
    localStorage.setItem('pv_token', state.token);
    showAuth(false);
    $('userInfo').textContent = data.user.email;
    await loadAll();
  } catch (err) { message('authMessage', err.message, true); }
}

function logout() {
  localStorage.removeItem('pv_token');
  state.token = '';
  state.user = null;
  showAuth(true);
}

async function loadAll() {
  await loadAiModels();
  await loadCategories();
  await loadPrompts();
}

async function loadAiModels() {
  const data = await api('/api/ai/models');
  state.aiModels = data.models || [];
  state.defaultAiModel = data.defaultModel || state.aiModels[0] || '';
  const select = $('aiModel');
  if (select) {
    select.innerHTML = state.aiModels.map((model) => `<option value="${escapeAttr(model)}">${escapeHtml(model)}</option>`).join('');
    select.value = state.defaultAiModel;
  }
}

async function loadCategories() {
  state.categories = await api('/api/categories');
  $('categoryList').innerHTML = state.categories.map(c => `<button class="cat" data-id="${c.id}">${c.name}<span>${c.promptCount || 0}</span></button>`).join('');
  document.querySelectorAll('.cat').forEach((btn) => btn.onclick = () => { state.categoryId = btn.dataset.id; state.filter = 'all'; setNavActive(); loadPrompts(); });
}

function setNavActive() {
  document.querySelectorAll('.nav').forEach((btn) => btn.classList.toggle('active', state.filter === btn.dataset.filter && !state.categoryId));
  document.querySelectorAll('.cat').forEach((btn) => btn.classList.toggle('active', state.categoryId === btn.dataset.id));
}

async function loadPrompts() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.categoryId) params.set('categoryId', state.categoryId);
  if (state.filter === 'favorite') params.set('favorite', 'true');
  if (state.filter === 'need_review') params.set('aiStatus', 'need_review');
  const data = await api(`/api/prompts?${params.toString()}`);
  state.prompts = data.items;
  renderPrompts();
  await loadCategories();
}

function renderPrompts() {
  $('totalCount').textContent = state.prompts.length;
  $('favoriteCount').textContent = state.prompts.filter(p => p.isFavorite).length;
  $('reviewCount').textContent = state.prompts.filter(p => p.aiStatus === 'need_review' || p.aiStatus === 'failed').length;
  if (!state.prompts.length) {
    $('promptList').innerHTML = '<div class="empty-list">还没有提示词。点右上角新增，或者用 Chrome 插件保存选中文本。</div>';
    return;
  }
  $('promptList').innerHTML = state.prompts.map(p => `
    <button class="prompt-card ${state.selected?.id === p.id ? 'active' : ''}" data-id="${p.id}">
      <div class="card-head"><strong>${escapeHtml(p.title)}</strong><span>${p.isFavorite ? '★' : '☆'}</span></div>
      <p>${escapeHtml(p.summary || p.content.slice(0, 72))}</p>
      <div class="compact-info">
        <span>${escapeHtml(p.category?.name || '未分类')}</span>
        <span>${escapeHtml(p.sourceDomain || '网页端')}</span>
        ${(p.tags || []).slice(0, 2).map(t => `<em>${escapeHtml(t)}</em>`).join('')}
      </div>
    </button>
  `).join('');
  document.querySelectorAll('.prompt-card').forEach((card) => card.onclick = () => selectPrompt(card.dataset.id));
}

async function selectPrompt(id) {
  state.selected = await api(`/api/prompts/${id}`);
  renderPrompts();
  renderDetail();
}

function renderDetail() {
  const p = state.selected;
  if (!p) return;
  $('detailCard').innerHTML = `
    <div class="detail-head">
      <div><p class="eyebrow">${escapeHtml(p.category?.name || '未分类')}</p><h3>${escapeHtml(p.title)}</h3></div>
      <button class="star" id="favBtn">${p.isFavorite ? '★' : '☆'}</button>
    </div>
    <p class="summary">${escapeHtml(p.summary || '暂无摘要')}</p>
    ${p.markdownDoc ? `<div class="markdown-doc">${renderMarkdown(p.markdownDoc)}</div>` : ''}
    <details class="raw-prompt" ${p.markdownDoc ? '' : 'open'}>
      <summary>原始提示词</summary>
      <pre>${escapeHtml(p.content)}</pre>
    </details>
    <div class="tags big">${(p.tags || []).map(t => `<em>${escapeHtml(t)}</em>`).join('')}</div>
    <dl>
      <dt>来源</dt><dd>${p.sourceUrl ? `<a href="${escapeAttr(p.sourceUrl)}" target="_blank">${escapeHtml(p.sourceDomain || p.sourceUrl)}</a>` : escapeHtml(p.sourceDomain || '网页端')}</dd>
      <dt>AI 状态</dt><dd>${escapeHtml(p.aiStatus)} / 置信度 ${p.aiConfidence ?? '-'}</dd>
      <dt>AI 模型</dt><dd>${escapeHtml(p.aiModel || '未记录')}</dd>
      <dt>更新时间</dt><dd>${new Date(p.updatedAt).toLocaleString()}</dd>
    </dl>
    <div class="actions">
      <button id="copyBtn" class="secondary">复制</button>
      <button id="editBtn" class="secondary">编辑</button>
      <button id="reanalyzeBtn" class="secondary">重新分析</button>
      <button id="deleteBtn" class="danger">删除</button>
    </div>
  `;
  $('favBtn').onclick = toggleFavorite;
  $('copyBtn').onclick = () => navigator.clipboard.writeText(p.content);
  $('editBtn').onclick = openEditDialog;
  $('reanalyzeBtn').onclick = reanalyze;
  $('deleteBtn').onclick = deletePrompt;
}

function openNewDialog() {
  $('dialogTitle').textContent = '新增提示词';
  $('editId').value = '';
  $('promptTitle').value = '';
  $('promptContent').value = '';
  $('sourceTitle').value = '';
  $('sourceUrl').value = '';
  $('autoAnalyze').checked = true;
  $('aiModel').value = state.defaultAiModel || state.aiModels[0] || '';
  message('dialogMessage', '');
  $('promptDialog').showModal();
}

function openEditDialog() {
  const p = state.selected;
  $('dialogTitle').textContent = '编辑提示词';
  $('editId').value = p.id;
  $('promptTitle').value = p.title || '';
  $('promptContent').value = p.content || '';
  $('sourceTitle').value = p.sourceTitle || '';
  $('sourceUrl').value = p.sourceUrl || '';
  $('autoAnalyze').checked = false;
  $('aiModel').value = p.aiModel || state.defaultAiModel || state.aiModels[0] || '';
  message('dialogMessage', '');
  $('promptDialog').showModal();
}

async function savePrompt(e) {
  e.preventDefault();
  await submitPromptForm(false);
}

function duplicateConfirmMessage(matches) {
  const lines = (matches || []).slice(0, 3).map((item, index) => {
    const percent = Math.round((item.similarity || 0) * 100);
    return `${index + 1}. ${item.title}（相似度 ${percent}%）`;
  });
  return `检测到可能已经保存过类似提示词：\n\n${lines.join('\n')}\n\n是否仍然保存一份新的？`;
}

async function submitPromptForm(forceSave) {
  const editId = $('editId').value;
  const body = {
    title: $('promptTitle').value.trim(),
    content: $('promptContent').value.trim(),
    sourceTitle: $('sourceTitle').value.trim(),
    sourceUrl: $('sourceUrl').value.trim(),
    autoAnalyze: $('autoAnalyze').checked,
    aiModel: $('aiModel').value,
    forceSave,
  };
  try {
    let data;
    if (editId) {
      data = await api(`/api/prompts/${editId}`, { method: 'PATCH', body: JSON.stringify({ ...body, isManualConfirmed: true }) });
    } else {
      data = await api('/api/prompts', { method: 'POST', body: JSON.stringify(body) });
    }
    $('promptDialog').close();
    await loadPrompts();
    await selectPrompt(data.id);
  } catch (err) {
    if (!editId && err.code === 'DUPLICATE_PROMPT' && confirm(duplicateConfirmMessage(err.details?.matches))) {
      return submitPromptForm(true);
    }
    message('dialogMessage', err.message, true);
  }
}

async function toggleFavorite() {
  const p = state.selected;
  await api(`/api/prompts/${p.id}/favorite`, { method: 'POST', body: JSON.stringify({ isFavorite: !p.isFavorite }) });
  await selectPrompt(p.id);
  await loadPrompts();
}

async function reanalyze() {
  const p = state.selected;
  $('reanalyzeBtn').textContent = '分析中...';
  await api(`/api/prompts/${p.id}/reanalyze`, { method: 'POST', body: JSON.stringify({ aiModel: state.defaultAiModel || state.aiModels[0] || p.aiModel }) });
  await selectPrompt(p.id);
  await loadPrompts();
}

async function deletePrompt() {
  const p = state.selected;
  if (!confirm('确定删除这个提示词吗？')) return;
  await api(`/api/prompts/${p.id}`, { method: 'DELETE' });
  state.selected = null;
  $('detailCard').innerHTML = '<p class="empty">已删除。选择其他提示词查看详情。</p>';
  await loadPrompts();
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"]/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[s]));
}
function escapeAttr(str) { return escapeHtml(str).replace(/'/g, '&#39;'); }
function renderMarkdown(md) {
  const lines = String(md || '').split(/\r?\n/);
  let html = '';
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (inList) { html += '</ul>'; inList = false; }
      continue;
    }
    if (line.startsWith('# ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h4>${escapeHtml(line.slice(2))}</h4>`;
    } else if (line.startsWith('## ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h5>${escapeHtml(line.slice(3))}</h5>`;
    } else if (line.startsWith('- ')) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${escapeHtml(line.slice(2))}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p>${escapeHtml(line)}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}

boot();
