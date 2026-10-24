// Transport and session helpers are independent of page rendering.
const memory = new Map();
export function sessionValue(key) { try { return sessionStorage.getItem(key) ?? memory.get(key) ?? null; } catch { return memory.get(key) ?? null; } }
export function setSessionValue(key, value) {
  value === null ? memory.delete(key) : memory.set(key, String(value));
  try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, String(value)); } catch {}
}
export function cloudError(status, detail = {}) {
  const reason = detail.error?.errors?.[0]?.reason || '';
  const message = status === 401 ? 'TOKEN_EXPIRED' : status === 403 && /quota|limit/i.test(reason) ? 'Google Drive 配額不足，請檢查儲存空間或稍後重試。'
    : status === 403 ? 'Google Drive 權限不足，請確認帳戶、資料夾及授權範圍。'
    : status === 404 ? '找不到雲端檔案或資料夾，請確認資料夾設定與存取權限。'
    : status === 429 ? 'Google Drive 請求過多，請稍後再試。'
    : status >= 500 ? 'Google Drive 暫時無法服務，請稍後重試。' : `Google Drive 請求未完成（HTTP ${status}）。`;
  return Object.assign(new Error(message), { code:'DRIVE_HTTP', status });
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled','AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort',abort); resolve(); },ms);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{once:true});
  });
}
export async function driveReadFetch(url, options = {}, fetcher = fetch) {
  // Only idempotent reads retry automatically. Never duplicate an uncertain POST upload.
  const reads = ['GET','HEAD'].includes((options.method || 'GET').toUpperCase());
  for (let attempt = 0; ; attempt++) {
    const response = await fetcher(url, options);
    if (!reads || attempt >= 2 || ![429,500,502,503,504].includes(response.status)) return response;
    const retry = response.headers.get('retry-after');
    const wait = retry ? (Number(retry) * 1000 || Date.parse(retry) - Date.now()) : 500 * 2 ** attempt + Math.random() * 200;
    if (wait > 5000) return response;
    await response.body?.cancel();
    await delay(Math.max(0, wait),options.signal);
  }
}
export function verifyDriveReceipt(receipt, serialized) {
  if (!receipt?.id || !/^\d+$/.test(String(receipt.size)) || Number(receipt.size) !== new TextEncoder().encode(serialized).byteLength) {
    throw new Error('雲端可能已接收備份，但檔案資訊尚未核對成功。請先查看備份清單，避免重複上傳。');
  }
  return receipt;
}
