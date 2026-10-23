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
      if (!input.isConnected) return;
      const session = input.closest('.kana-reading-session');
      const keyboard = !!viewport && viewport.height < window.innerHeight * .8 && document.activeElement === input;
      session?.classList.toggle('has-keyboard', keyboard);
      session?.style.setProperty('--reading-visible-height', `${Math.round(viewport?.height || window.innerHeight)}px`);
      if (document.activeElement !== input) return;
      const top = viewport?.offsetTop || 0;
      const bottom = top + (viewport?.height || window.innerHeight);
      const card = input.closest('.kana-reading-question-card');
      const cardRect = card?.getBoundingClientRect();
      const rect = input.getBoundingClientRect();
      if (keyboard && cardRect && cardRect.height <= bottom - top - 16) {
        if (cardRect.top < top + 8 || cardRect.bottom > bottom - 8) card.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
      } else if (rect.top < top + 8 || rect.bottom > bottom - 8) {
        input.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }
    });
  };
  viewport?.addEventListener('resize', update, { passive: true });
  viewport?.addEventListener('scroll', update, { passive: true });
  input.addEventListener('focus', update);
  input.addEventListener('blur', update);
  window.addEventListener('orientationchange', update, { passive: true });
  update();
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    input.removeEventListener('focus', update);
    input.removeEventListener('blur', update);
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

// One code-native icon family: currentColor, rounded 1.8px strokes, no image downloads.
export function uiIcon(name) {
  const paths = {
    home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-8H9v8H4a1 1 0 0 1-1-1Z"/>',
    pen:'<path d="m4 16-1 5 5-1L20 8a2.8 2.8 0 0 0-4-4Z"/><path d="m14 6 4 4M13 21h8"/>',
    book:'<path d="M12 5v16M12 5C9 3 5 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 1Z"/>',
    sound:'<path d="M11 4 6 8H3v8h3l5 4ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',
    text:'<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M6 16 9 8l3 8M7 13h4M15 8v8M15 12c4-2 5 5 0 4"/>',
    cloud:'<path d="M7 18a5 5 0 1 1 0-10 6 6 0 0 1 11-1 5.5 5.5 0 0 1 0 11M12 12v9m-3-3 3 3 3-3"/>',
    spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4"/>',
    settings:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="var(--card-bg)"/><circle cx="16" cy="12" r="2" fill="var(--card-bg)"/><circle cx="10" cy="18" r="2" fill="var(--card-bg)"/>',
    lock:'<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 15v2"/>',
    download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
    upload:'<path d="M12 15V3m-4 4 4-4 4 4M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
    play:'<path d="m8 4 12 8-12 8Z"/>',
    stats:'<path d="M4 21V11M12 21V3M20 21V7"/>',
    database:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>'
  };
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.book}</svg>`;
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
    details.innerHTML = `<summary>${uiIcon({cloud:'cloud',learning:'book',ai:'spark',advanced:'settings'}[id])}<span><strong>${title}</strong><small>${subtitle}</small></span><span class="category-chevron" aria-hidden="true">⌄</span></summary><div class="settings-category-body"></div>`;
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
    option.setAttribute('aria-pressed', option.classList.contains('selected') ? 'true' : 'false');
    option.addEventListener('click', () => queueMicrotask(() => {
      container.querySelectorAll('div.radio-option').forEach(node => node.setAttribute('aria-pressed', node.classList.contains('selected') ? 'true' : 'false'));
    }));
    option.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && !event.isComposing) {
        event.preventDefault(); option.click();
      }
    });
  });
}
