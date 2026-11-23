// View-owned work: late responses may never mutate a replacement page.
export class ViewWorkManager {
  constructor() { this.jobs = new Set(); this.owners = new WeakMap(); }
  start(container, anchor) {
    this.cancel(container);
    const controller = new AbortController();
    const job = { container, controller,
      owns: () => this.owners.get(container) === job && container.isConnected && (!anchor || container.contains(anchor)),
      current: () => job.owns() && !controller.signal.aborted,
      options: { signal: controller.signal },
      finish: () => this.jobs.delete(job),
      cancel: () => { controller.abort(); this.jobs.delete(job); if (this.owners.get(container) === job) this.owners.delete(container); }
    };
    this.jobs.add(job);
    this.owners.set(container, job);
    return job;
  }
  cancel(container) { for (const job of this.jobs) if (!container || job.container === container) job.cancel(); }
  get busy() { return this.jobs.size > 0; }
}

// Retain unsaved controls, disclosure state, focus and a visible anchor when a
// settings operation changes its markup. Never restore into a different view.
export function preserveSettingsView(container, render, { preserveInputs = true } = {}) {
  if (!container?.isConnected) return;
  const controls = [...container.querySelectorAll('input[id], select[id], textarea[id]')]
    .filter(node => preserveInputs && node.type !== 'file')
    .map(node => ({ id: node.id, value: node.value, checked: node.checked,
      start: node.selectionStart, end: node.selectionEnd }));
  const disclosureKey = (node, index) => {
    if (node.id) return 'id:' + node.id;
    if (node.dataset.category) return 'category:' + node.dataset.category;
    const title = node.querySelector(':scope > summary .settings-collapse-title')?.textContent.trim();
    return title ? 'section:' + title : 'position:' + index;
  };
  const disclosures = new Map([...container.querySelectorAll('details')]
    .map((node, index) => [disclosureKey(node, index), node.open]));
  const scroller = container.closest('#view-container');
  const scrollTop = scroller?.scrollTop || 0;
  const focusId = container.contains(document.activeElement) ? document.activeElement.id : '';
  const scrollerTop = scroller?.getBoundingClientRect().top || 0;
  const anchor = [...container.querySelectorAll('[id], details[data-category]')].find(node => {
    const rect = node.getBoundingClientRect();
    return rect.height && rect.top >= scrollerTop && rect.top < window.innerHeight;
  });
  const anchorId = anchor?.id, category = anchor?.dataset.category, anchorTop = anchor?.getBoundingClientRect().top;
  render();
  const renderedRoot = container.firstElementChild;
  const byId = new Map([...container.querySelectorAll('[id]')].map(node => [node.id, node]));
  controls.forEach(saved => {
    const node = byId.get(saved.id); if (!node) return;
    if (node.tagName !== 'SELECT' || [...node.options].some(option => option.value === saved.value)) node.value = saved.value;
    if (node.type === 'checkbox' || node.type === 'radio') node.checked = saved.checked;
  });
  const sections = [...container.querySelectorAll('details')];
  sections.forEach((node, index) => {
    const key = disclosureKey(node, index);
    if (disclosures.has(key)) node.open = disclosures.get(key);
  });
  const nextAnchor = anchorId ? byId.get(anchorId) : category && sections.find(node => node.dataset.category === category);
  const restore = () => {
    if (!container.isConnected || container.firstElementChild !== renderedRoot) return;
    if (scroller) scroller.scrollTop = scrollTop;
    if (scroller && nextAnchor && Number.isFinite(anchorTop)) scroller.scrollTop += nextAnchor.getBoundingClientRect().top - anchorTop;
    const focus = focusId && byId.get(focusId);
    if (focus && !focus.disabled) {
      focus.focus({ preventScroll: true });
      const saved = controls.find(item => item.id === focusId);
      try { if (saved && saved.start !== null) focus.setSelectionRange(saved.start, saved.end); } catch {}
    }
  };
  restore(); requestAnimationFrame(restore);
}

export function readArray(storage, key) {
  const raw = storage.getItem(key);
  if (raw === null || raw === undefined) return [];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('NOT_ARRAY');
    return data;
  } catch {
    storage.reportCorruption?.(key);
    const error = new Error(`資料「${key}」格式異常，已停止此操作並保留原始資料。請先匯出救援資料。`);
    error.code = 'STORAGE_DATA_CORRUPT'; error.key = key;
    throw error;
  }
}

export function createToastController({ show, hide, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null, serial = 0;
  return { async publish(message, duration, prepare = async value => value) {
    const id = ++serial;
    clearTimer(timer);
    const prepared = await prepare(message);
    if (id !== serial) return;
    show(prepared);
    timer = setTimer(() => { if (id === serial) hide(); }, duration);
  } };
}
