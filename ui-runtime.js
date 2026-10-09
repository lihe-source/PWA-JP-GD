// Shared, framework-free UI behavior. No storage credentials or API calls here.
export function escapeHTML(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function readingProgress(label, state) {
  const extra = Math.max(0, state.items.length - state.initialTotal);
  const position = Math.min(state.index + 1, state.items.length);
  return `${label} ${position} / ${state.items.length} · 原定 ${state.initialTotal} 題${extra ? `＋補練 ${extra} 題` : ''}`;
}

export function firstAttemptSummary(results, initialTotal) {
  const initial = results.slice(0, initialTotal);
  const correct = initial.filter(result => result.correct).length;
  return { total: initial.length, correct, accuracy: initial.length ? Math.round(correct / initial.length * 100) : 0 };
}

export function readingFeedback(result, character, expected, extra = 0) {
  if (!result) return '';
  return result.correct
    ? `<div class="is-correct"><strong>✓ 上一題答對</strong><span>${escapeHTML(character)} = ${escapeHTML(expected)}</span></div>`
    : `<div class="is-wrong"><strong>✗ 上一題訂正：${escapeHTML(character)}</strong><span>你的答案：${escapeHTML(result.answer)}　正確拼音：<b>${escapeHTML(expected)}</b>；已追加補練${extra ? `（${extra} 題）` : ''}</span></div>`;
}

// Keep the same DOM input across questions. Scroll only if the keyboard really covers it.
export function bindReadingViewport(input) {
  if (!input || typeof window === 'undefined') return () => {};
  const viewport = window.visualViewport;
  let frame = 0;
  let disposed = false;
  const update = () => {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!input.isConnected || document.activeElement !== input) return;
      const top = viewport?.offsetTop || 0;
      const bottom = top + (viewport?.height || window.innerHeight);
      const rect = input.getBoundingClientRect();
      if (rect.top < top + 8 || rect.bottom > bottom - 8) {
        input.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      }
      const session = input.closest('.kana-reading-session');
      session?.classList.toggle('has-keyboard', !!viewport && viewport.height < window.innerHeight * .8);
    });
  };
  viewport?.addEventListener('resize', update, { passive: true });
  viewport?.addEventListener('scroll', update, { passive: true });
  input.addEventListener('focus', update);
  window.addEventListener('orientationchange', update, { passive: true });
  update();
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    input.removeEventListener('focus', update);
    window.removeEventListener('orientationchange', update);
  };
}

export function createModalFocusManager() {
  let previousFocus = null;
  let keyHandler = null;
  let activeOverlay = null;
  return {
    open(overlay, content, close) {
      if (!activeOverlay) previousFocus = document.activeElement;
      if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
      activeOverlay = overlay;
      const app = document.getElementById('app');
      if (app) { app.inert = true; app.setAttribute('aria-hidden', 'true'); }
      const focusables = () => [...content.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex]')]
        .filter(node => !node.disabled && node.tabIndex !== -1 && node.getClientRects().length);
      const title = content.querySelector('.modal-title, h1, h2');
      if (title) { title.id ||= 'active-modal-title'; overlay.setAttribute('aria-labelledby', title.id); }
      else { overlay.removeAttribute('aria-labelledby'); overlay.setAttribute('aria-label', '對話視窗'); }
      overlay.tabIndex = -1;
      keyHandler = event => {
        if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); close(); return; }
        if (event.key !== 'Tab') return;
        const nodes = focusables();
        if (!nodes.length) { event.preventDefault(); overlay.focus(); return; }
        const first = nodes[0], last = nodes.at(-1);
        if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      };
      document.addEventListener('keydown', keyHandler, true);
      requestAnimationFrame(() => {
        if (activeOverlay === overlay && !overlay.classList.contains('hidden')) (focusables()[0] || overlay).focus();
      });
    },
    close() {
      document.removeEventListener('keydown', keyHandler, true);
      keyHandler = null; activeOverlay = null;
      const app = document.getElementById('app');
      if (app) { app.inert = false; app.removeAttribute('aria-hidden'); }
      const target = previousFocus?.isConnected ? previousFocus : document.querySelector('.nav-btn[aria-current="page"]');
      previousFocus = null;
      try { target?.focus({ preventScroll: true }); } catch { target?.focus(); }
    }
  };
}

export function mountSettingsGroups(container, storage) {
  const wrap = container.querySelector('.settings-wrap');
  if (!wrap) return;
  const definitions = [
    ['cloud', '帳戶與雲端', 'Google Drive、備份與復原', true],
    ['learning', '學習設定', '等級、行別與練習偏好', false],
    ['ai', 'AI 與通知', '模型、API Key、每日提醒', false],
    ['advanced', '進階與資料管理', '版本更新、音效測試與匯入匯出', false]
  ];
  const original = [...wrap.children];
  const groups = new Map();
  for (const [id, title, subtitle, defaultOpen] of definitions) {
    const details = document.createElement('details');
    details.className = 'settings-category'; details.dataset.category = id;
    const saved = storage.getItem(`settingsCategory:${id}`);
    details.open = saved === null ? defaultOpen : saved === '1';
    details.innerHTML = `<summary><strong>${title}</strong><small>${subtitle}</small></summary><div class="settings-category-body"></div>`;
    details.addEventListener('toggle', () => storage.setItem(`settingsCategory:${id}`, details.open ? '1' : '0'));
    groups.set(id, details);
  }
  let category = 'cloud';
  let saveCard = null;
  for (const node of original) {
    if (node.matches('.storage-status-card')) { saveCard = node; continue; }
    if (node.matches('.settings-collapsible-card')) category = 'advanced';
    if (node.matches('.settings-section-label')) {
      const title = node.textContent;
      category = /等級|學習設定|學習來源|推薦|五十音|發音/.test(title) ? 'learning'
        : /Gemini|每日學習提醒/i.test(title) ? 'ai'
          : /Google Drive|OAuth|雲端/i.test(title) ? 'cloud' : 'advanced';
    }
    if (node.matches('div') && node.getAttribute('style') === 'height:12px') continue;
    groups.get(category).querySelector('.settings-category-body').append(node);
  }
  for (const details of groups.values()) wrap.append(details);
  if (saveCard) wrap.append(saveCard); // data saving is always the last section
  // Errors and manual diagnostic checks must not be hidden inside a collapsed category.
  container.addEventListener('click', event => {
    const target = event.target.closest?.('[data-open-category]');
    const details = target && groups.get(target.dataset.openCategory);
    if (details) details.open = true;
  });
}

export function enhanceKeyboardOptions(container) {
  container.querySelectorAll('div.radio-option').forEach(option => {
    option.setAttribute('role', 'button'); option.tabIndex = 0;
    option.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && !event.isComposing) {
        event.preventDefault(); option.click();
      }
    });
  });
}
