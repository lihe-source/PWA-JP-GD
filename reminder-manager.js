const SETTINGS_KEY = 'dailyReminderSettingsV1';
const TOKEN_KEY = 'dailyReminderManagementTokenV1';

function normalizeApiBase(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw || /YOUR-WORKER|YOUR-SUBDOMAIN|REPLACE[_-]?WITH/i.test(raw)) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

function validTime(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))) return false;
  return true;
}

function currentTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Taipei'; }
  catch { return 'Asia/Taipei'; }
}

function isAppleMobile() {
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches === true || navigator.standalone === true;
}

function base64UrlToBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const decoded = atob(padded);
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

function equalApplicationServerKey(existing, expected) {
  if (!existing) return false;
  const current = new Uint8Array(existing);
  if (current.length !== expected.length) return false;
  return current.every((value, index) => value === expected[index]);
}

function makeError(code, detail = '') {
  const error = new Error(detail || code);
  error.code = code;
  return error;
}

export function reminderErrorMessage(error) {
  const code = error?.code || error?.message || '';
  const messages = {
    UNSUPPORTED: '此瀏覽器不支援 Web Push 通知',
    NOT_INSTALLED: '請先將網站加入 iPhone 主畫面，再從主畫面開啟 PWA',
    BACKEND_NOT_CONFIGURED: '尚未設定推播服務網址，請先完成部署說明中的 Cloudflare 設定',
    PERMISSION_DENIED: '通知權限未開啟，請到 iPhone「設定 → 通知 → 英文複習」允許通知',
    INVALID_TIME: '請選擇有效的提醒時間',
    INVALID_SERVER_CONFIG: '推播後端設定不完整，請檢查 VAPID 公開金鑰',
    AUTH_EXPIRED: '提醒憑證已失效，請重新按下「儲存並啟用」',
    TIMEOUT: '推播服務連線逾時，請確認網路後再試',
    NETWORK_ERROR: '無法連線推播服務，請檢查 Worker 網址與網路',
    SUBSCRIBE_FAILED: '無法建立通知訂閱，請重新開啟 PWA 後再試'
  };
  return messages[code] || error?.message || '提醒設定失敗，請稍後再試';
}

export class ReminderManager {
  constructor({ storage, config }) {
    this.storage = storage;
    this.config = config || {};
    this.serverConfig = null;
  }

  getApiBaseUrl() {
    return normalizeApiBase(this.config.apiBaseUrl);
  }

  isBackendConfigured() {
    return !!this.getApiBaseUrl();
  }

  getCapabilities() {
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const appleMobile = isAppleMobile();
    const standalone = isStandalone();
    return {
      supported,
      appleMobile,
      standalone,
      needsInstall: appleMobile && !standalone,
      permission: 'Notification' in window ? Notification.permission : 'unsupported',
      backendConfigured: this.isBackendConfigured()
    };
  }

  getSettings() {
    let saved = {};
    try { saved = JSON.parse(this.storage.getItem(SETTINGS_KEY) || '{}') || {}; }
    catch { saved = {}; }
    const time = validTime(saved.time) ? saved.time : (validTime(this.config.defaultTime) ? this.config.defaultTime : '20:00');
    return {
      enabled: saved.enabled === true,
      time,
      timeZone: saved.timeZone || currentTimeZone(),
      title: saved.title || this.config.defaultTitle || '英文單字複習時間到了',
      body: saved.body || this.config.defaultBody || '每天複習一點點，保持英文學習節奏！',
      nextFireAt: Number(saved.nextFireAt) || 0,
      updatedAt: saved.updatedAt || ''
    };
  }

  _saveSettings(next) {
    const current = this.getSettings();
    const merged = { ...current, ...next, updatedAt: new Date().toISOString() };
    this.storage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    return merged;
  }

  getNextReminderLabel() {
    const settings = this.getSettings();
    if (!settings.enabled) return '尚未啟用';
    let next = settings.nextFireAt ? new Date(settings.nextFireAt) : null;
    if (!next || Number.isNaN(next.getTime()) || next.getTime() <= Date.now()) {
      const [hour, minute] = settings.time.split(':').map(Number);
      next = new Date();
      next.setHours(hour, minute, 0, 0);
      if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    }
    return next.toLocaleString('zh-TW', {
      month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    });
  }

  async _request(path, options = {}) {
    const base = this.getApiBaseUrl();
    if (!base) throw makeError('BACKEND_NOT_CONFIGURED');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(this.config.requestTimeoutMs) || 15000);
    try {
      const response = await fetch(`${base}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        signal: controller.signal,
        cache: 'no-store'
      });
      let payload = {};
      try { payload = await response.json(); } catch {}
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw makeError('AUTH_EXPIRED', payload.error || 'Unauthorized');
        throw makeError(payload.code || 'NETWORK_ERROR', payload.error || `HTTP ${response.status}`);
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw makeError('TIMEOUT');
      if (error?.code) throw error;
      throw makeError('NETWORK_ERROR', error?.message || 'Fetch failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  async _getServerConfig() {
    if (this.serverConfig?.vapidPublicKey) return this.serverConfig;
    const config = await this._request('/api/config', { method: 'GET', headers: {} });
    if (!config?.vapidPublicKey) throw makeError('INVALID_SERVER_CONFIG');
    this.serverConfig = config;
    return config;
  }

  async _ensureSubscription() {
    const server = await this._getServerConfig();
    const expectedKey = base64UrlToBytes(server.vapidPublicKey);
    if (expectedKey.length !== 65) throw makeError('INVALID_SERVER_CONFIG');
    let readyTimer;
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => {
        readyTimer = setTimeout(() => reject(makeError('SUBSCRIBE_FAILED', 'Service worker is not ready')), 12000);
      })
    ]).finally(() => clearTimeout(readyTimer));
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !equalApplicationServerKey(subscription.options?.applicationServerKey, expectedKey)) {
      await subscription.unsubscribe().catch(() => false);
      subscription = null;
    }
    if (!subscription) {
      try {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: expectedKey
        });
      } catch (error) {
        throw makeError('SUBSCRIBE_FAILED', error?.message || 'Push subscription failed');
      }
    }
    return subscription;
  }

  _authorizationHeaders(token) {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async _register({ time, subscription, allowTokenReset = true }) {
    const token = this.storage.getItem(TOKEN_KEY) || '';
    const settings = this.getSettings();
    const body = {
      subscription: subscription.toJSON(),
      reminderTime: time,
      timeZone: currentTimeZone(),
      title: settings.title,
      body: settings.body
    };
    try {
      return await this._request('/api/reminders', {
        method: 'POST',
        headers: this._authorizationHeaders(token),
        body: JSON.stringify(body)
      });
    } catch (error) {
      if (allowTokenReset && token && error?.code === 'AUTH_EXPIRED') {
        this.storage.removeItem(TOKEN_KEY);
        return this._register({ time, subscription, allowTokenReset: false });
      }
      throw error;
    }
  }

  async enable(time) {
    if (!validTime(time)) throw makeError('INVALID_TIME');
    const capabilities = this.getCapabilities();
    if (!capabilities.supported) throw makeError('UNSUPPORTED');
    if (capabilities.needsInstall) throw makeError('NOT_INSTALLED');
    if (!capabilities.backendConfigured) throw makeError('BACKEND_NOT_CONFIGURED');

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw makeError('PERMISSION_DENIED');

    const subscription = await this._ensureSubscription();
    const result = await this._register({ time, subscription });
    if (result.managementToken) this.storage.setItem(TOKEN_KEY, result.managementToken);
    return this._saveSettings({
      enabled: true,
      time,
      timeZone: result.timeZone || currentTimeZone(),
      nextFireAt: Number(result.nextFireAt) || 0
    });
  }

  async disable() {
    const token = this.storage.getItem(TOKEN_KEY) || '';
    if (token && this.isBackendConfigured()) {
      try {
        await this._request('/api/reminders/disable', {
          method: 'POST',
          headers: this._authorizationHeaders(token),
          body: '{}'
        });
      } catch (error) {
        if (error?.code !== 'AUTH_EXPIRED') throw error;
        this.storage.removeItem(TOKEN_KEY);
      }
    }
    return this._saveSettings({ enabled: false, nextFireAt: 0 });
  }

  async sendTest() {
    const capabilities = this.getCapabilities();
    if (!capabilities.supported) throw makeError('UNSUPPORTED');
    if (capabilities.needsInstall) throw makeError('NOT_INSTALLED');
    if (capabilities.permission !== 'granted') throw makeError('PERMISSION_DENIED');
    const token = this.storage.getItem(TOKEN_KEY) || '';
    if (!token) throw makeError('AUTH_EXPIRED');
    return this._request('/api/reminders/test', {
      method: 'POST',
      headers: this._authorizationHeaders(token),
      body: '{}'
    });
  }

  async reconcile() {
    const settings = this.getSettings();
    const capabilities = this.getCapabilities();
    if (!settings.enabled || !capabilities.supported || capabilities.needsInstall || !capabilities.backendConfigured) return false;
    if (capabilities.permission !== 'granted') {
      this._saveSettings({ enabled: false, nextFireAt: 0 });
      return false;
    }
    try {
      const subscription = await this._ensureSubscription();
      const result = await this._register({ time: settings.time, subscription });
      if (result.managementToken) this.storage.setItem(TOKEN_KEY, result.managementToken);
      this._saveSettings({
        enabled: true,
        timeZone: result.timeZone || currentTimeZone(),
        nextFireAt: Number(result.nextFireAt) || settings.nextFireAt
      });
      return true;
    } catch (error) {
      console.info('[DailyReminder] Background reconciliation skipped:', error?.message || error);
      return false;
    }
  }
}
