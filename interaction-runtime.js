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
  const disclosures = [...container.querySelectorAll('details')].map(node => ({ id: node.id, category: node.dataset.category, open: node.open }));
  const scroller = container.closest('#view-container');
  const scrollTop = scroller?.scrollTop || 0;
  const focusId = container.contains(document.activeElement) ? document.activeElement.id : '';
  const anchor = [...container.querySelectorAll('[id], details[data-category]')].find(node => {
    const rect = node.getBoundingClientRect();
    return rect.height && rect.top >= (scroller?.getBoundingClientRect().top || 0) && rect.top < window.innerHeight;
  });
  const anchorId = anchor?.id, category = anchor?.dataset.category, anchorTop = anchor?.getBoundingClientRect().top;
  render();
  const byId = id => [...container.querySelectorAll('[id]')].find(node => node.id === id);
  controls.forEach(saved => {
    const node = byId(saved.id); if (!node) return;
    if (node.tagName !== 'SELECT' || [...node.options].some(option => option.value === saved.value)) node.value = saved.value;
    if (node.type === 'checkbox' || node.type === 'radio') node.checked = saved.checked;
  });
  disclosures.forEach(saved => {
    const node = saved.id ? byId(saved.id) : [...container.querySelectorAll('details')].find(item => item.dataset.category === saved.category);
    if (node) node.open = saved.open;
  });
  const restore = () => {
    if (!container.isConnected) return;
    const nextAnchor = anchorId ? byId(anchorId) : [...container.querySelectorAll('details')].find(node => node.dataset.category === category);
    if (scroller) scroller.scrollTop = scrollTop;
    if (scroller && nextAnchor && Number.isFinite(anchorTop)) scroller.scrollTop += nextAnchor.getBoundingClientRect().top - anchorTop;
    const focus = focusId && byId(focusId);
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
