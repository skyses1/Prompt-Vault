(() => {
  if (window.__promptVaultContentLoaded) return;
  window.__promptVaultContentLoaded = true;

  let lastEditable = null;
  let panelState = { items: [], selected: 0, query: '', timer: null };
  let shortcutSettings = { shortcutEnabled: true, shortcutKey: 'Ctrl+Shift+K' };

  chrome.storage?.local?.get(['shortcutEnabled', 'shortcutKey'], (cfg) => {
    shortcutSettings = {
      shortcutEnabled: cfg.shortcutEnabled !== false,
      shortcutKey: cfg.shortcutKey || 'Ctrl+Shift+K'
    };
  });

  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.shortcutEnabled) shortcutSettings.shortcutEnabled = changes.shortcutEnabled.newValue !== false;
    if (changes.shortcutKey) shortcutSettings.shortcutKey = changes.shortcutKey.newValue || 'Ctrl+Shift+K';
  });

  function rememberEditable(event) {
    const target = event.target;
    if (isEditable(target)) lastEditable = target;
  }

  document.addEventListener('focusin', rememberEditable, true);
  document.addEventListener('click', rememberEditable, true);
  document.addEventListener('keyup', rememberEditable, true);

  function isEditable(el) {
    if (!el) return false;
    const tag = String(el.tagName || '').toLowerCase();
    return el.isContentEditable || tag === 'textarea' || (tag === 'input' && !['button', 'submit', 'checkbox', 'radio'].includes(el.type));
  }

  function findEditable() {
    if (isEditable(document.activeElement) && !document.activeElement.closest?.('#pv-command-root')) return document.activeElement;
    if (isEditable(lastEditable)) return lastEditable;
    const selectors = ['#prompt-textarea', '[data-testid="prompt-textarea"]', 'div.ProseMirror[contenteditable="true"]', 'main [contenteditable="true"]', 'textarea', '[contenteditable="true"]', 'input[type="text"]', 'input:not([type])'];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (isEditable(el)) return el;
    }
    return null;
  }

  function insertText(text) {
    const el = findEditable();
    if (!el) {
      navigator.clipboard?.writeText(text);
      alert('没有找到可输入区域，已复制到剪贴板。');
      return false;
    }
    el.focus();
    const beforeText = el.isContentEditable ? (el.innerText || el.textContent || '') : (el.value || '');
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', text);
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer
      });
      const pasteAccepted = el.dispatchEvent(pasteEvent);
      const afterPasteText = el.isContentEditable ? (el.innerText || el.textContent || '') : (el.value || '');
      if (afterPasteText.includes(text.slice(0, Math.min(30, text.length)))) return true;
      if (!pasteAccepted) {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
      }
    } catch (_) {}
    if (el.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } else {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      el.value = el.value.slice(0, start) + text + el.value.slice(end);
      const pos = start + text.length;
      el.setSelectionRange?.(pos, pos);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }

  async function copyAndInsert(text, promptId = '') {
    const filled = fillTemplateVariables(text);
    if (filled === null) return false;
    try {
      await navigator.clipboard?.writeText(filled);
    } catch (_) {}
    if (promptId) chrome.runtime.sendMessage({ type: 'PV_RECORD_USE', promptId }, () => void chrome.runtime.lastError);
    return insertText(filled);
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

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"]/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[s]));
  }

  function requestSearch(query, favoriteOnly = false) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'PV_SEARCH_PROMPTS', query, favoriteOnly }, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response?.success) return reject(new Error(response?.message || '搜索失败'));
        resolve(response.items || []);
      });
    });
  }

  function eventMatchesShortcut(event, shortcutKey) {
    const parts = String(shortcutKey || 'Ctrl+Shift+K').split('+').map((part) => part.trim()).filter(Boolean);
    const key = parts.pop();
    const mods = new Set(parts.map((part) => part.toLowerCase()));
    const needCtrl = mods.has('ctrl') || mods.has('control');
    const needShift = mods.has('shift');
    const needAlt = mods.has('alt') || mods.has('option');
    const needMeta = mods.has('meta') || mods.has('cmd') || mods.has('command');
    if (Boolean(event.ctrlKey) !== needCtrl) return false;
    if (Boolean(event.shiftKey) !== needShift) return false;
    if (Boolean(event.altKey) !== needAlt) return false;
    if (Boolean(event.metaKey) !== needMeta) return false;
    return event.key.toLowerCase() === String(key || '').toLowerCase();
  }

  async function openCommandPanel() {
    document.getElementById('pv-command-root')?.remove();
    panelState = { items: [], selected: 0, query: '', timer: null };
    const root = document.createElement('div');
    root.id = 'pv-command-root';
    root.innerHTML = `
      <style>
        #pv-command-root{position:fixed;z-index:2147483647;inset:0;background:rgba(15,24,18,.28);font-family:"Microsoft YaHei",sans-serif;color:#1d2c22;}
        #pv-command{position:absolute;left:50%;top:12vh;transform:translateX(-50%);width:min(720px,calc(100vw - 28px));background:#fff8e6;border:1px solid rgba(29,44,34,.16);border-radius:24px;box-shadow:0 30px 90px rgba(20,31,24,.28);overflow:hidden;}
        #pv-command-head{padding:14px 16px;background:#274433;color:#fff8e6;display:flex;justify-content:space-between;gap:12px;align-items:center}#pv-command-head strong{font-size:16px}#pv-command-head span{font-size:12px;opacity:.78}
        #pv-command-input{width:calc(100% - 28px);margin:14px;border:1px solid rgba(29,44,34,.16);border-radius:16px;padding:13px 14px;font-size:15px;outline:none;background:rgba(255,255,255,.82)}
        #pv-command-list{display:grid;gap:8px;max-height:440px;overflow:auto;padding:0 14px 14px}.pv-row{border:1px solid rgba(29,44,34,.12);border-radius:16px;background:rgba(255,255,255,.62);padding:12px;text-align:left}.pv-row.active{border-color:#3f7a4c;background:#f4ecd5}.pv-title{font-weight:800;margin-bottom:5px}.pv-summary{font-size:12px;color:#68766c;line-height:1.45}.pv-meta{margin-top:7px;font-size:11px;color:#3f7a4c}.pv-empty{padding:18px;color:#68766c;font-size:13px}
      </style>
      <section id="pv-command">
        <div id="pv-command-head"><strong>搜索提示词</strong><span>Enter 插入 · Esc 关闭</span></div>
        <input id="pv-command-input" placeholder="搜索全部提示词..." />
        <div id="pv-command-list"><div class="pv-empty">输入关键词搜索，或直接选择最近提示词。</div></div>
      </section>`;
    document.documentElement.appendChild(root);
    const input = root.querySelector('#pv-command-input');
    const list = root.querySelector('#pv-command-list');
    const close = () => root.remove();

    function render() {
      if (!panelState.items.length) {
        list.innerHTML = '<div class="pv-empty">没有匹配的提示词。</div>';
        return;
      }
      list.innerHTML = panelState.items.slice(0, 10).map((p, index) => `
        <button class="pv-row ${index === panelState.selected ? 'active' : ''}" data-index="${index}">
          <div class="pv-title">${escapeHtml(p.title)}</div>
          <div class="pv-summary">${escapeHtml(p.summary || (p.content || '').slice(0, 110))}</div>
          <div class="pv-meta">${escapeHtml(p.category?.name || '未分类')} · ${escapeHtml(p.sourceDomain || '网页端')} · ${(p.tags || []).slice(0, 3).map(escapeHtml).join(' / ')} · 点击后复制并插入</div>
        </button>`).join('');
      list.querySelectorAll('.pv-row').forEach((row) => {
        row.onclick = async () => {
          const item = panelState.items[Number(row.dataset.index)];
          if (item) { await copyAndInsert(item.content || '', item.id); close(); }
        };
      });
    }

    async function searchNow() {
      try {
        panelState.items = await requestSearch(input.value.trim(), false);
        panelState.selected = 0;
        render();
      } catch (error) {
        list.innerHTML = `<div class="pv-empty">${escapeHtml(error.message)}</div>`;
      }
    }

    input.oninput = () => {
      clearTimeout(panelState.timer);
      panelState.timer = setTimeout(searchNow, 220);
    };
    input.onkeydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'ArrowDown') { event.preventDefault(); panelState.selected = Math.min(panelState.items.length - 1, panelState.selected + 1); render(); }
      if (event.key === 'ArrowUp') { event.preventDefault(); panelState.selected = Math.max(0, panelState.selected - 1); render(); }
      if (event.key === 'Enter') {
        event.preventDefault();
        const item = panelState.items[panelState.selected];
        if (item) { copyAndInsert(item.content || '', item.id); close(); }
      }
    };
    root.addEventListener('click', (event) => { if (event.target === root) close(); });
    setTimeout(() => input.focus(), 60);
    searchNow();
  }

  document.addEventListener('keydown', (event) => {
    if (shortcutSettings.shortcutEnabled === false) return;
    if (!eventMatchesShortcut(event, shortcutSettings.shortcutKey || 'Ctrl+Shift+K')) return;
    event.preventDefault();
    event.stopPropagation();
    openCommandPanel();
  }, true);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'PV_INSERT_TEXT') return insertText(message.text || '');
    if (message?.type === 'PV_OPEN_COMMAND_PANEL') {
      openCommandPanel();
      return true;
    }
  });
})();
