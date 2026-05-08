(() => {
  if (window.__promptVaultContentLoaded) return;
  window.__promptVaultContentLoaded = true;

  let lastEditable = null;

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
    if (isEditable(document.activeElement)) return document.activeElement;
    if (isEditable(lastEditable)) return lastEditable;
    return document.querySelector('textarea, [contenteditable="true"], input[type="text"], input:not([type])');
  }

  function insertText(text) {
    const el = findEditable();
    if (!el) {
      navigator.clipboard?.writeText(text);
      alert('没有找到可输入区域，已复制到剪贴板。');
      return false;
    }
    el.focus();
    if (el.isContentEditable) {
      document.execCommand('insertText', false, text);
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

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"]/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[s]));
  }

  function openPicker(prompts) {
    document.getElementById('pv-picker-root')?.remove();
    const root = document.createElement('div');
    root.id = 'pv-picker-root';
    root.innerHTML = `
      <style>
        #pv-picker-root{position:fixed;z-index:2147483647;inset:0;background:rgba(16,24,19,.22);font-family:"Microsoft YaHei",sans-serif;color:#1d2c22;}
        #pv-picker{position:absolute;right:24px;top:24px;width:min(420px,calc(100vw - 32px));max-height:min(680px,calc(100vh - 48px));background:#fff8e6;border:1px solid rgba(29,44,34,.16);border-radius:22px;box-shadow:0 24px 70px rgba(20,31,24,.24);overflow:hidden;display:flex;flex-direction:column;}
        #pv-head{padding:16px 18px;background:#274433;color:#fff8e6;display:flex;align-items:center;justify-content:space-between;gap:12px;}
        #pv-head strong{font-size:17px;} #pv-close{border:0;background:rgba(255,255,255,.16);color:white;border-radius:10px;padding:6px 10px;cursor:pointer;}
        #pv-search{margin:12px;border:1px solid rgba(29,44,34,.16);border-radius:14px;padding:11px 12px;outline:none;}
        #pv-list{overflow:auto;padding:0 12px 12px;display:grid;gap:10px;}
        .pv-item{border:1px solid rgba(29,44,34,.12);background:rgba(255,255,255,.62);border-radius:16px;padding:12px;text-align:left;}
        .pv-title{font-weight:800;margin-bottom:6px;}.pv-summary{font-size:12px;color:#68766c;line-height:1.5;margin-bottom:10px;}
        .pv-actions{display:flex;gap:8px}.pv-actions button{border:0;border-radius:10px;padding:8px 10px;cursor:pointer;font-weight:700}.pv-insert{background:#274433;color:#fff}.pv-copy{background:#eadbb8;color:#274433;}
      </style>
      <section id="pv-picker">
        <div id="pv-head"><strong>插入收藏提示词</strong><button id="pv-close">关闭</button></div>
        <input id="pv-search" placeholder="搜索收藏提示词..." />
        <div id="pv-list"></div>
      </section>`;
    document.documentElement.appendChild(root);

    const list = root.querySelector('#pv-list');
    const search = root.querySelector('#pv-search');
    const close = () => root.remove();
    root.querySelector('#pv-close').onclick = close;
    root.addEventListener('click', (event) => { if (event.target === root) close(); });

    function render() {
      const q = search.value.trim().toLowerCase();
      const filtered = prompts.filter(p => !q || `${p.title} ${p.summary || ''} ${p.content || ''} ${(p.tags || []).join(' ')}`.toLowerCase().includes(q));
      list.innerHTML = filtered.map((p, index) => `
        <article class="pv-item" data-index="${index}">
          <div class="pv-title">${escapeHtml(p.title)}</div>
          <div class="pv-summary">${escapeHtml(p.summary || (p.content || '').slice(0, 80))}</div>
          <div class="pv-actions"><button class="pv-insert">插入</button><button class="pv-copy">复制</button></div>
        </article>`).join('') || '<div class="pv-summary">没有匹配的收藏提示词</div>';
      list.querySelectorAll('.pv-item').forEach((item) => {
        const p = filtered[Number(item.dataset.index)];
        item.querySelector('.pv-insert').onclick = () => { insertText(p.content || ''); close(); };
        item.querySelector('.pv-copy').onclick = async () => { await navigator.clipboard.writeText(p.content || ''); item.querySelector('.pv-copy').textContent = '已复制'; };
      });
    }
    search.oninput = render;
    render();
    setTimeout(() => search.focus(), 80);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'PV_OPEN_PICKER') openPicker(message.prompts || []);
  });
})();
