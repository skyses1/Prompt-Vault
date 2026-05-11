const state = {
  token: localStorage.getItem('pv_token') || '',
  user: null,
  prompts: [],
  categories: [],
  aiModels: [],
  defaultAiModel: '',
  selected: null,
  selectedIds: new Set(),
  filter: 'all',
  categoryId: '',
  q: '',
  searchMode: 'keyword',
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
  $('manageCategoriesBtn').onclick = openCategoryDialog;
  $('importBtn').onclick = openImportDialog;
  $('exportMdBtn').onclick = () => exportPrompts('markdown');
  $('exportJsonBtn').onclick = () => exportPrompts('json');
  $('cancelDialog').onclick = () => $('promptDialog').close();
  $('cancelImportDialog').onclick = () => $('importDialog').close();
  $('closeCategoryDialog').onclick = () => $('categoryDialog').close();
  $('addCategoryBtn').onclick = addCategory;
  $('bulkCategorizeBtn').onclick = bulkCategorize;
  $('bulkReanalyzeBtn').onclick = bulkReanalyze;
  $('bulkErrorBtn').onclick = bulkMarkError;
  $('clearSelectionBtn').onclick = clearSelection;
  $('promptForm').onsubmit = savePrompt;
  $('importForm').onsubmit = importPrompts;
  $('searchBtn').onclick = () => { state.q = $('searchInput').value.trim(); state.searchMode = $('searchMode').value; clearSelection(false); loadPrompts(); };
  $('clearBtn').onclick = () => { $('searchInput').value = ''; state.q = ''; state.filter = 'all'; state.categoryId = ''; state.searchMode = 'keyword'; $('searchMode').value = 'keyword'; clearSelection(false); setNavActive(); loadPrompts(); };
  $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('searchBtn').click(); });
  document.querySelectorAll('.nav').forEach((btn) => btn.onclick = () => { state.filter = btn.dataset.filter; state.categoryId = ''; clearSelection(false); setNavActive(); loadPrompts(); });
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
  const importSelect = $('importAiModel');
  if (importSelect) {
    importSelect.innerHTML = state.aiModels.map((model) => `<option value="${escapeAttr(model)}">${escapeHtml(model)}</option>`).join('');
    importSelect.value = state.defaultAiModel;
  }
}

async function loadCategories() {
  state.categories = await api('/api/categories');
  $('categoryList').innerHTML = state.categories.map(c => `<button class="cat" data-id="${c.id}">${c.name}<span>${c.promptCount || 0}</span></button>`).join('');
  $('bulkCategory').innerHTML = '<option value="">选择分类</option>' + state.categories.map(c => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.name)}</option>`).join('');
  document.querySelectorAll('.cat').forEach((btn) => btn.onclick = () => { state.categoryId = btn.dataset.id; state.filter = 'all'; clearSelection(false); setNavActive(); loadPrompts(); });
  if ($('categoryDialog').open) renderCategoryManageList();
}

function setNavActive() {
  document.querySelectorAll('.nav').forEach((btn) => btn.classList.toggle('active', state.filter === btn.dataset.filter && !state.categoryId));
  document.querySelectorAll('.cat').forEach((btn) => btn.classList.toggle('active', state.categoryId === btn.dataset.id));
}

async function loadPrompts() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.searchMode === 'semantic') params.set('searchMode', 'semantic');
  if (state.categoryId) params.set('categoryId', state.categoryId);
  if (state.filter === 'favorite') params.set('favorite', 'true');
  if (state.filter === 'need_review') params.set('aiStatus', 'need_review');
  if (state.filter.startsWith('type_')) params.set('contentType', state.filter.replace('type_', ''));
  if (state.filter === 'recent') params.set('sort', 'recent_used');
  if (state.filter === 'frequent') params.set('sort', 'frequent');
  const data = await api(`/api/prompts?${params.toString()}`);
  state.prompts = data.items;
  state.selectedIds = new Set([...state.selectedIds].filter((id) => state.prompts.some((p) => p.id === id)));
  renderPrompts();
  renderBulkBar();
  await loadCategories();
}

function renderPrompts() {
  $('totalCount').textContent = state.prompts.length;
  $('favoriteCount').textContent = state.prompts.filter(p => p.isFavorite).length;
  $('reviewCount').textContent = state.prompts.filter(p => p.aiStatus === 'need_review' || p.aiStatus === 'failed').length;
  if (!state.prompts.length) {
    $('promptList').innerHTML = '<div class="empty-list">还没有内容。点右上角新增，或者用 Chrome 插件保存选中文本。</div>';
    return;
  }
  $('promptList').innerHTML = state.prompts.map(p => `
    <article class="prompt-card ${state.selected?.id === p.id ? 'active' : ''}" data-id="${p.id}">
      <div class="card-head">
        <label class="select-check"><input type="checkbox" data-id="${p.id}" ${state.selectedIds.has(p.id) ? 'checked' : ''} /></label>
        <strong>${escapeHtml(p.title)}</strong>
        <span>${p.isFavorite ? '★' : '☆'}</span>
      </div>
      <p>${escapeHtml(p.summary || p.content.slice(0, 72))}</p>
      <div class="compact-info">
        <span>${escapeHtml(p.contentTypeLabel || '提示词')}</span>
        <span>${escapeHtml(p.category?.name || '未分类')}</span>
        <span>${escapeHtml(p.sourceDomain || '网页端')}</span>
        ${p.isManualConfirmed ? '<em>人工确认</em>' : ''}
        ${p.usageCount ? `<em>用 ${p.usageCount}</em>` : ''}
        ${(p.tags || []).slice(0, 2).map(t => `<em>${escapeHtml(t)}</em>`).join('')}
      </div>
    </article>
  `).join('');
  document.querySelectorAll('.prompt-card').forEach((card) => card.onclick = () => selectPrompt(card.dataset.id));
  document.querySelectorAll('.select-check input').forEach((box) => {
    box.onclick = (event) => {
      event.stopPropagation();
      if (box.checked) state.selectedIds.add(box.dataset.id);
      else state.selectedIds.delete(box.dataset.id);
      renderBulkBar();
    };
  });
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
      <div><p class="eyebrow">${escapeHtml(p.contentTypeLabel || '提示词')} · ${escapeHtml(p.category?.name || '未分类')}</p><h3>${escapeHtml(p.title)}</h3></div>
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
      <dt>类型</dt><dd>${escapeHtml(p.contentTypeLabel || '提示词')}</dd>
      <dt>来源</dt><dd>${p.sourceUrl ? `<a href="${escapeAttr(p.sourceUrl)}" target="_blank">${escapeHtml(p.sourceDomain || p.sourceUrl)}</a>` : escapeHtml(p.sourceDomain || '网页端')}</dd>
      <dt>AI 状态</dt><dd>${escapeHtml(p.aiStatus)} / 置信度 ${p.aiConfidence ?? '-'}</dd>
      <dt>AI 模型</dt><dd>${escapeHtml(p.aiModel || '未记录')}</dd>
      <dt>使用</dt><dd>${p.usageCount || 0} 次${p.lastUsedAt ? ` / 最近 ${new Date(p.lastUsedAt).toLocaleString()}` : ''}</dd>
      <dt>更新时间</dt><dd>${new Date(p.updatedAt).toLocaleString()}</dd>
    </dl>
    <div class="actions">
      <button id="copyRawBtn" class="secondary">复制原文</button>
      <button id="copyMdBtn" class="secondary">复制 Markdown</button>
      <button id="markErrorBtn" class="secondary">归为错误</button>
      <button id="moveReviewBtn" class="secondary">待人工确认</button>
      <button id="editBtn" class="secondary">编辑</button>
      <button id="reanalyzeBtn" class="secondary">重新分析</button>
      <button id="deleteBtn" class="danger">删除</button>
    </div>
    <details class="versions">
      <summary>版本历史</summary>
      <div id="versionList" class="version-list">加载中...</div>
    </details>
  `;
  $('favBtn').onclick = toggleFavorite;
  $('copyMdBtn').onclick = () => copyText(p.markdownDoc || `# ${p.title}\n\n## 原始提示词\n${p.content}`, '已复制 Markdown。');
  $('copyRawBtn').onclick = () => copyText(formatRawPromptMarkdown(p), '已复制 Markdown 格式原文。');
  $('markErrorBtn').onclick = markError;
  $('moveReviewBtn').onclick = moveReview;
  $('editBtn').onclick = openEditDialog;
  $('reanalyzeBtn').onclick = reanalyze;
  $('deleteBtn').onclick = deletePrompt;
  loadVersions(p.id);
}

function formatRawPromptMarkdown(p) {
  const tags = (p.tags || []).join('、') || '无';
  const source = p.sourceUrl || p.sourceDomain || '网页端';
  const original = extractOriginalFromMarkdown(p.markdownDoc) || p.content || '';
  return [
    `# ${p.title || '未命名提示词'}`,
    '',
    `> 类型：${p.contentTypeLabel || '提示词'} / 分类：${p.category?.name || '未分类'}`,
    '',
    p.summary ? `## 摘要\n\n${p.summary}\n` : '',
    '## 原始提示词',
    '',
    original.trim(),
    '',
    '## 复用信息',
    '',
    `- 标签：${tags}`,
    `- 来源：${source}`,
    `- AI 状态：${p.aiStatus || '未记录'}`,
    `- 更新时间：${p.updatedAt ? new Date(p.updatedAt).toLocaleString() : '未记录'}`,
  ].filter(Boolean).join('\n');
}

function extractOriginalFromMarkdown(markdown) {
  const md = String(markdown || '').trim();
  if (!md) return '';
  const headings = ['原始提示词', '原文', '原始内容'];
  for (const heading of headings) {
    const pattern = new RegExp(`(^|\\n)##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'i');
    const match = md.match(pattern);
    if (match?.[2]?.trim()) return match[2].trim();
  }
  return '';
}

async function copyText(text, tip) {
  const value = String(text || '');
  if (!value) return toast('没有可复制的内容。', true);
  try {
    await writeClipboard(value);
    if (state.selected?.id) api(`/api/prompts/${state.selected.id}/use`, { method: 'POST', body: '{}' }).catch(() => {});
    toast(tip);
  } catch (error) {
    toast(`复制失败：${error.message}`, true);
  }
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('浏览器拒绝写入剪贴板，请手动选中内容复制');
  return true;
}

function renderBulkBar() {
  const count = state.selectedIds.size;
  $('bulkBar').classList.toggle('hidden', count === 0);
  $('selectedCount').textContent = count;
}

function clearSelection(render = true) {
  state.selectedIds.clear();
  if (render) {
    renderPrompts();
    renderBulkBar();
  }
}

async function bulkCategorize() {
  const ids = [...state.selectedIds];
  if (!ids.length) return;
  const categoryId = $('bulkCategory').value;
  const categoryName = $('bulkCategoryName').value.trim();
  if (!categoryId && !categoryName) return toast('请选择分类或输入新分类名称', true);
  const data = await api('/api/prompts/batch/categorize', {
    method: 'POST',
    body: JSON.stringify({ ids, categoryId, categoryName })
  });
  toast(`已手动归类 ${data.updated} 条，AI 不会覆盖这些人工分类。`);
  $('bulkCategoryName').value = '';
  clearSelection(false);
  await loadPrompts();
}

async function bulkReanalyze() {
  const ids = [...state.selectedIds];
  if (!ids.length) return;
  if (!confirm('批量 AI 整理会更新标题、摘要、Markdown 和标签；已人工确认的分类不会被覆盖。继续吗？')) return;
  const data = await api('/api/prompts/batch/reanalyze', {
    method: 'POST',
    body: JSON.stringify({ ids, aiModel: state.defaultAiModel || state.aiModels[0] || '' })
  });
  toast(`已整理 ${data.updated} 条。`);
  clearSelection(false);
  await loadPrompts();
}

async function bulkMarkError() {
  const ids = [...state.selectedIds];
  if (!ids.length || !confirm(`把选中的 ${ids.length} 条归为错误提示词吗？`)) return;
  const data = await api('/api/prompts/batch/mark-error', { method: 'POST', body: JSON.stringify({ ids }) });
  toast(`已归为错误提示词 ${data.updated} 条。`);
  clearSelection(false);
  await loadPrompts();
}

function toast(text, bad = false) {
  const el = document.createElement('div');
  el.className = `toast ${bad ? 'bad-toast' : ''}`;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

function openNewDialog() {
  $('dialogTitle').textContent = '新增提示词';
  $('editId').value = '';
  $('promptTitle').value = '';
  $('promptContent').value = '';
  $('sourceTitle').value = '';
  $('sourceUrl').value = '';
  $('contentType').value = 'prompt';
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
  $('contentType').value = p.contentType || 'prompt';
  $('autoAnalyze').checked = false;
  $('aiModel').value = p.aiModel || state.defaultAiModel || state.aiModels[0] || '';
  message('dialogMessage', '');
  $('promptDialog').showModal();
}

function openImportDialog() {
  $('importContent').value = '';
  $('importAutoAnalyze').checked = true;
  $('importFormat').value = 'markdown';
  $('importAiModel').value = state.defaultAiModel || state.aiModels[0] || '';
  message('importMessage', '');
  $('importDialog').showModal();
}

async function exportPrompts(format) {
  const res = await fetch(`/api/export?format=${encodeURIComponent(format)}`, {
    headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
  });
  if (!res.ok) throw new Error('导出失败');
  const blob = await res.blob();
  const ext = format === 'json' ? 'json' : 'md';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `prompt-vault-export-${new Date().toISOString().slice(0, 10)}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importPrompts(e) {
  e.preventDefault();
  const submit = $('importForm').querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = '导入中...';
  try {
    const data = await api('/api/import', {
      method: 'POST',
      body: JSON.stringify({
        format: $('importFormat').value,
        content: $('importContent').value,
        autoAnalyze: $('importAutoAnalyze').checked,
        aiModel: $('importAiModel').value,
      })
    });
    message('importMessage', `导入 ${data.imported} 条，跳过重复 ${data.skipped} 条，失败 ${data.failed} 条。`, data.failed > 0);
    await loadPrompts();
    if (data.items?.[0]) await selectPrompt(data.items[0].id);
  } catch (err) {
    message('importMessage', err.message, true);
  } finally {
    submit.disabled = false;
    submit.textContent = '开始导入';
  }
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
    contentType: $('contentType').value,
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

async function markError() {
  const p = state.selected;
  if (!p || !confirm('把这个提示词归类为“错误提示词”吗？')) return;
  state.selected = await api(`/api/prompts/${p.id}/mark-error`, { method: 'POST', body: '{}' });
  renderDetail();
  await loadPrompts();
}

async function moveReview() {
  const p = state.selected;
  if (!p) return;
  state.selected = await api(`/api/prompts/${p.id}/move-review`, { method: 'POST', body: '{}' });
  renderDetail();
  await loadPrompts();
}

async function loadVersions(promptId) {
  const box = $('versionList');
  if (!box) return;
  try {
    const versions = await api(`/api/prompts/${promptId}/versions`);
    if (!versions.length) {
      box.innerHTML = '<p class="empty small">暂无历史版本。编辑或恢复后会自动记录。</p>';
      return;
    }
    box.innerHTML = versions.map((v) => `
      <article class="version-row">
        <div>
          <strong>${escapeHtml(v.title)}</strong>
          <p>${new Date(v.createdAt).toLocaleString()} · ${escapeHtml(v.category?.name || '未分类')} · ${escapeHtml(v.changeNote || '历史版本')}</p>
        </div>
        <button class="restore-version secondary" data-id="${v.id}" type="button">恢复</button>
      </article>
    `).join('');
    box.querySelectorAll('.restore-version').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('恢复该版本吗？当前内容会先自动备份为一个历史版本。')) return;
        state.selected = await api(`/api/prompts/${promptId}/versions/${btn.dataset.id}/restore`, { method: 'POST', body: '{}' });
        toast('版本已恢复。');
        renderDetail();
        await loadPrompts();
      };
    });
  } catch (err) {
    box.innerHTML = `<p class="empty small">${escapeHtml(err.message)}</p>`;
  }
}

function openCategoryDialog() {
  $('newCategoryName').value = '';
  message('categoryMessage', '');
  renderCategoryManageList();
  $('categoryDialog').showModal();
}

function renderCategoryManageList() {
  $('categoryManageList').innerHTML = state.categories.map((c) => `
    <article class="category-manage-row">
      <div>
        <strong>${escapeHtml(c.name)}</strong>
        <p>${c.promptCount || 0} 条 · ${c.isSystem ? '系统分类' : '自定义分类'}</p>
      </div>
      ${c.isSystem ? '<span class="locked">锁定</span>' : `<button class="rename-cat secondary" data-id="${c.id}" type="button">改名</button><button class="delete-cat danger" data-id="${c.id}" type="button">删除</button>`}
    </article>
  `).join('');
  document.querySelectorAll('.rename-cat').forEach((btn) => {
    btn.onclick = async () => {
      const current = state.categories.find((c) => c.id === btn.dataset.id);
      const name = prompt('新的分类名称', current?.name || '');
      if (!name) return;
      await api(`/api/categories/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      await loadCategories();
      message('categoryMessage', '分类已改名。');
    };
  });
  document.querySelectorAll('.delete-cat').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('删除分类后，该分类下提示词会变为未分类。继续吗？')) return;
      await api(`/api/categories/${btn.dataset.id}`, { method: 'DELETE' });
      await loadCategories();
      await loadPrompts();
      message('categoryMessage', '分类已删除。');
    };
  });
}

async function addCategory() {
  const name = $('newCategoryName').value.trim();
  if (!name) return message('categoryMessage', '请输入分类名称', true);
  await api('/api/categories', { method: 'POST', body: JSON.stringify({ name }) });
  $('newCategoryName').value = '';
  await loadCategories();
  message('categoryMessage', '分类已新增。');
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
