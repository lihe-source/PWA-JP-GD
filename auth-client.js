const SESSION_KEY = 'cloudDeviceSessionV1';
const URL_KEY = 'cloudAuthUrlV1';
const LOGOUT_KEY = 'cloudLogoutPendingV1';
const PENDING_KEY = 'jpOAuthPending';
export function authErrorMessage(error) {
  const code = error?.code || error?.message || '';
  const messages = {
    AUTH_NOT_CONFIGURED: 'Cloudflare 自動登入尚未設定，請依 README 完成 Google Secret 及 D1 初始化。',
    AUTH_KEY_INVALID: '雲端憑證加密設定有問題，請確認原本的 CREDENTIAL_ENCRYPTION_KEY。',
    REAUTH_REQUIRED: 'Google 連結已失效，請在設定頁重新連結；本機練習仍可使用。',
    AUTH_DENIED: 'Google 授權未完成，請重新連結並允許 Drive 備份權限。',
    DRIVE_PERMISSION_MISSING: '未取得 Google Drive 備份權限，請重新連結並允許該權限。',
    OFFLINE_ACCESS_MISSING: '未取得背景續期權限，請重新連結 Google 並完成同意。',
    AUTH_SERVICE_TIMEOUT: '雲端登入服務逾時，帳號與本機資料已保留，稍後可重試。',
    AUTH_SERVICE_UNAVAILABLE: '暫時無法連上雲端登入服務，本機資料已保留。',
    AUTH_SERVICE_ERROR: '雲端登入設定或資料表尚未完成，請檢查 Worker 與 D1。',
    AUTH_REFRESH_BUSY: '雲端正在續期，請稍候重試。',
    AUTH_TRANSACTION_EXPIRED: '本次 Google 連結已逾時，請重新點擊連結。',
    AUTH_RATE_LIMIT: '操作過於頻繁，請稍候再試。',
    POPUP_BLOCKED: '瀏覽器阻擋首次授權視窗，請允許此網站彈出視窗後重新連結。',
    AUTH_CONTEXT_CHANGED: '帳號或服務設定已變更，本次舊操作已取消。',
    INVALID_SERVICE_URL: '請填入完整的 HTTPS Worker 網址，不含查詢參數。',
    GOOGLE_RATE_LIMIT: 'Google 目前限制連線次數，請稍候再試；本機練習仍可使用。',
    GOOGLE_AUTH_FAILED: 'Google 授權交換未完成，請檢查 OAuth Client、Secret 與回呼網址。',
    DRIVE_SERVICE_UNAVAILABLE: 'Google Drive 暫時無法連線，本機資料已保留。',
    OFFLINE: '目前離線，Google 備份稍後恢復；本機練習不受影響。'
  };
  return messages[code] || 'Google 連結未完成（' + String(code).slice(0, 80) + '）';
}
function failure(code) { const error = new Error(code); error.code = code; return error; }
function randomProof() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function challenge(proof) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(proof)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function cleanUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
    return url.origin;
  } catch { return ''; }
}
export class CloudAuthClient {
  constructor({ storage, defaultUrl = '', fetchImpl = (...args) => fetch(...args), onChange = () => {} }) {
    this.storage = storage; this.defaultUrl = defaultUrl; this.fetchImpl = fetchImpl; this.onChange = onChange;
    this.session = null; this.state = 'none'; this.error = ''; this.epoch = 0; this.restoreTask = null; this.connectTask = null;
  }
  get baseUrl() { return cleanUrl(this.storage.getItem(URL_KEY) ?? this.defaultUrl); }
  get active() { return this.state === 'active' && !!this.session?.token && this.session.expiresAt > Date.now(); }
  get email() { return this.session?.email || ''; }
  get remembered() { return !!this.session?.token; }
  get enabled() { return !!this.baseUrl; }
  init() {
    try {
      const saved = JSON.parse(this.storage.getItem(SESSION_KEY) || 'null');
      if (saved?.url === this.baseUrl && /^[A-Za-z0-9_-]{43}$/.test(saved.token || '') && typeof saved.email === 'string') this.session = saved;
    } catch {}
    this.state = this.session ? 'remembered' : 'none';
    return this;
  }
  setUrl(value) {
    const url = cleanUrl(value); if (value && !url) throw failure('INVALID_SERVICE_URL');
    if (url !== this.baseUrl) {
      if (this.session?.token) this.storage.setItem(LOGOUT_KEY, JSON.stringify(this.session));
      this.epoch++; this.session = null; this.storage.removeItem(SESSION_KEY); this.state = 'none';
    }
    this.storage.setItem(URL_KEY, url); this.error = ''; this.notify();
  }
  notify() { try { this.onChange({ state: this.state, email: this.email, error: this.error }); } catch {} }
  async request(path, { auth = false, method = 'GET', json, signal, timeoutMs = 18000 } = {}) {
    if (!this.baseUrl) throw failure('AUTH_NOT_CONFIGURED');
    if (globalThis.navigator?.onLine === false) throw failure('OFFLINE');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (signal?.aborted) controller.abort();
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const headers = { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) };
    if (auth && this.session?.token) headers.Authorization = `Bearer ${this.session.token}`;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json),
        signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
      const data = await response.json();
      if (!response.ok) throw failure(data.code || 'AUTH_SERVICE_ERROR');
      return data;
    } catch (error) {
      if (error?.code) throw error;
      throw failure(controller.signal.aborted ? 'AUTH_SERVICE_TIMEOUT' : 'AUTH_SERVICE_UNAVAILABLE');
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
  async checkConfiguration() { return this.request('/api/auth/status'); }
  restore() {
    if (this.restoreTask) return this.restoreTask;
    if (!this.session) return Promise.resolve(false);
    const epoch = this.epoch;
    this.restoreTask = (async () => {
      this.state = 'restoring'; this.notify();
      try {
        const data = await this.request('/api/auth/session', { auth: true });
        if (this.epoch !== epoch) return false;
        if (typeof data.email !== 'string' || !(Number(data.expiresAt) > Date.now())) throw failure('AUTH_SERVICE_ERROR');
        this.session = { ...this.session, email: data.email, expiresAt: data.expiresAt };
        this.storage.setItem(SESSION_KEY, JSON.stringify(this.session));
        this.state = 'active'; this.error = ''; this.notify(); return true;
      } catch (error) {
        if (this.epoch !== epoch) return false;
        this.error = error.code; this.state = error.code === 'REAUTH_REQUIRED' ? 'reauth' : 'offline';
        this.notify(); return false;
      }
    })().finally(() => { this.restoreTask = null; });
    return this.restoreTask;
  }
  connect() {
    if (this.connectTask) return this.connectTask;
    if (!this.enabled) return Promise.reject(failure('AUTH_NOT_CONFIGURED'));
    if (globalThis.navigator?.onLine === false) return Promise.reject(failure('OFFLINE'));
    // Open synchronously in the original tap, before configuration/digest awaits.
    const popup = window.open('about:blank', 'jp-google-connect', 'popup,width=520,height=680');
    if (!popup) return Promise.reject(failure('POPUP_BLOCKED'));
    try { popup.document.body.textContent = '正在準備 Google 連結…'; } catch {}
    const epoch = ++this.epoch;
    this.connectTask = this._connect(popup, epoch).finally(() => { this.connectTask = null; });
    return this.connectTask;
  }
  async _connect(popup, epoch) {
    const deadline = Date.now() + 5 * 60000; const proof = randomProof(); let state = '';
    let wake = null;
    const listener = event => {
      if (event.origin === this.baseUrl && event.source === popup && event.data?.type === 'JP_OAUTH_COMPLETE' && event.data.state === state) wake?.();
    };
    window.addEventListener('message', listener);
    this.state = 'connecting'; this.error = ''; this.notify();
    try {
      const data = await this.request('/api/auth/start', { method: 'POST', json: { challenge: await challenge(proof) } });
      if (epoch !== this.epoch) throw failure('AUTH_CONTEXT_CHANGED');
      const authorization = new URL(data.authorizationUrl);
      if (authorization.origin !== 'https://accounts.google.com' || authorization.pathname !== '/o/oauth2/v2/auth' || !/^[A-Za-z0-9_-]{43}$/.test(data.state || '')) throw failure('AUTH_SERVICE_ERROR');
      state = data.state;
      // This proof is tab-scoped, excluded from all application backups.
      try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ proof, state, url: this.baseUrl, expiresAt: deadline })); } catch {}
      popup.location.replace(authorization.href);
      let response;
      let failures = 0;
      let closedAt = 0;
      while (Date.now() < deadline) {
        if (epoch !== this.epoch) throw failure('AUTH_CONTEXT_CHANGED');
        try {
          response = await this.request('/api/auth/result', { method: 'POST', json: { state, proof } });
          failures = 0;
        } catch (error) {
          if (!['AUTH_SERVICE_TIMEOUT', 'AUTH_SERVICE_UNAVAILABLE'].includes(error.code) || ++failures > 5) throw error;
          response = null;
        }
        if (response?.session) break;
        if (popup.closed) { closedAt ||= Date.now(); if (response && Date.now() - closedAt > 5000) throw failure('AUTH_DENIED'); }
        await new Promise(resolve => {
          const timer = setTimeout(finish, 1500);
          function finish() { clearTimeout(timer); wake = null; resolve(); }
          wake = finish;
        });
      }
      const saved = response?.session;
      if (!saved || !/^[A-Za-z0-9_-]{43}$/.test(saved.token || '') || typeof saved.email !== 'string' || !(Number(saved.expiresAt) > Date.now()) || epoch !== this.epoch) throw failure('AUTH_TRANSACTION_EXPIRED');
      this.session = { ...saved, url: this.baseUrl };
      this.storage.setItem(SESSION_KEY, JSON.stringify(this.session));
      await this.storage.flush();
      if (epoch !== this.epoch) throw failure('AUTH_CONTEXT_CHANGED');
      this.state = 'active'; this.error = ''; this.notify(); return true;
    } catch (error) {
      if (epoch === this.epoch) { this.state = this.session ? 'remembered' : 'none'; this.error = error.code || error.message; this.notify(); }
      throw error;
    } finally {
      window.removeEventListener('message', listener);
      try { sessionStorage.removeItem(PENDING_KEY); popup.close(); } catch {}
    }
  }
  async resumePending() {
    let pending; try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null'); } catch {}
    if (!pending || pending.url !== this.baseUrl || pending.expiresAt <= Date.now() || this.session) return false;
    const epoch = this.epoch;
    try {
      const result = await this.request('/api/auth/result', { method: 'POST', json: { state: pending.state, proof: pending.proof } });
      if (!result.session || !/^[A-Za-z0-9_-]{43}$/.test(result.session.token || '') || typeof result.session.email !== 'string' || !(Number(result.session.expiresAt) > Date.now()) || this.epoch !== epoch) return false;
      this.session = { ...result.session, url: this.baseUrl }; this.storage.setItem(SESSION_KEY, JSON.stringify(this.session));
      await this.storage.flush(); if (this.epoch !== epoch) return false;
      this.state = 'active'; this.error = ''; this.notify();
      sessionStorage.removeItem(PENDING_KEY); return true;
    } catch { return false; }
  }
  async logout() {
    const session = this.session; this.epoch++; this.session = null; this.state = 'none'; this.error = '';
    this.storage.removeItem(SESSION_KEY); this.notify();
    if (session?.token) this.storage.setItem(LOGOUT_KEY, JSON.stringify(session));
    await this.storage.flush();
    await this.flushLogout();
  }
  async flushLogout() {
    let saved; try { saved = JSON.parse(this.storage.getItem(LOGOUT_KEY) || 'null'); } catch {}
    if (!saved?.token || !cleanUrl(saved.url) || globalThis.navigator?.onLine === false) return false;
    try {
      const response = await this.fetchImpl(`${saved.url}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${saved.token}` },
        signal: AbortSignal.timeout(10000), credentials: 'omit', cache: 'no-store' });
      if (!response.ok) return false;
      this.storage.removeItem(LOGOUT_KEY); return true;
    } catch { return false; }
  }
  async revoke() {
    await this.request('/api/auth/revoke', { auth: true, method: 'POST' });
    await this.logout();
  }
  proxyFetch(url, options = {}) {
    if (!this.session?.token) return Promise.reject(failure('REAUTH_REQUIRED'));
    const headers = new Headers(options.headers || {}); headers.set('Authorization', `Bearer ${this.session.token}`);
    const epoch = this.epoch;
    return this.fetchImpl(`${this.baseUrl}/api/drive?target=${encodeURIComponent(url)}`, { ...options, headers, credentials: 'omit', cache: 'no-store', redirect: 'error' })
      .then(response => {
        if (response.status === 401 && this.epoch === epoch) { this.state = 'reauth'; this.error = 'REAUTH_REQUIRED'; this.notify(); }
        return response;
      });
  }
}
