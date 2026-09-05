export function mountStorageStatus({ storage, cloudState, exportPayload, restorePayload, onSafe }) {
  const banner = document.getElementById('storage-warning');
  const render = () => {
    const state = storage.getStatus();
    if (banner) banner.hidden = state.saveState !== 'error';
    const summary = state.saveState === 'error' ? '儲存失敗：資料仍在暫存，請勿關閉程式'
      : state.saveState === 'saving' ? '正在儲存到本機…'
        : cloudState()?.pending ? '本機已儲存・雲端待同步' : '本機已儲存';
    document.querySelectorAll('[data-storage-summary]').forEach(node => {
      node.textContent = summary;
      node.dataset.state = state.saveState;
    });
  };
  const exportBackup = () => {
    const blob = new Blob([JSON.stringify(exportPayload(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `japanese-recovery-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  window.addEventListener('app-storage-status', () => {
    render();
    if (storage.getStatus().saveState === 'saved') onSafe?.();
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest?.('[data-storage-action]');
    if (!button || button.disabled) return;
    const status = document.getElementById('storage-operation-message');
    button.disabled = true;
    try {
      if (button.dataset.storageAction === 'retry') await storage.retryFailedWrites();
      else if (button.dataset.storageAction === 'export') exportBackup();
      else if (button.dataset.storageAction === 'import') document.getElementById('storage-recovery-file')?.click();
      if (status) status.textContent = button.dataset.storageAction === 'retry' ? '本機資料已成功儲存。' : '';
    } catch (error) {
      if (status) status.textContent = error.message;
    } finally { button.disabled = false; render(); }
  });
  document.addEventListener('change', async event => {
    if (event.target.id !== 'storage-recovery-file') return;
    const file = event.target.files?.[0];
    if (!file) return;
    const status = document.getElementById('storage-operation-message');
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('備份超過 50 MB，請使用原有備份還原流程。');
      if (status) status.textContent = '驗證並合併救援備份中…';
      const payload = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
      await restorePayload(payload);
      if (status) status.textContent = '已合併救援備份並儲存；未刪除本機紀錄。';
    } catch (error) {
      if (status) status.textContent = '還原未完成：' + error.message;
    } finally { event.target.value = ''; render(); }
  });
  render();
  return { render };
}
