function normalizeVersion(value) {
  return String(value || '').trim().replace(/^V/i, '').replace(/_/g, '.');
}

function compareVersions(a, b) {
  const aa = normalizeVersion(a).split('.').map(n => Number.parseInt(n, 10) || 0);
  const bb = normalizeVersion(b).split('.').map(n => Number.parseInt(n, 10) || 0);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const delta = (aa[i] || 0) - (bb[i] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export class VersionManager {
  constructor({ currentVersion, displayVersion, cachePrefix = 'Japanese-PWA-', versionUrl = './version.json', storage, canActivate = () => true }) {
    this.currentVersion = currentVersion;
    this.displayVersion = displayVersion;
    this.cachePrefix = cachePrefix;
    this.versionUrl = versionUrl;
    this.storage = storage;
    this.canActivate = canActivate;
    this.registration = null;
    this.reloadTriggered = false;
    this.reloadPending = false;
    this._controllerChangeHandler = null;
    this._watchedRegistration = null;
    this._watchedWorkers = new WeakSet();
  }

  _isSafeToActivate() {
    try { return this.canActivate() !== false; }
    catch { return false; }
  }

  async _flushStorage() {
    try { await this.storage?.flush?.(); return true; }
    catch { return false; }
  }

  _watchInstalling(worker) {
    if (!worker || this._watchedWorkers.has(worker)) return;
    this._watchedWorkers.add(worker);
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') void this.activateWaitingIfSafe(this.registration?.waiting || worker);
    });
  }

  async activateWaitingIfSafe(worker = this.registration?.waiting) {
    if (!worker || !this._isSafeToActivate()) return false;
    if (!(await this._flushStorage())) return false;
    if (!this._isSafeToActivate()) return false;
    worker.postMessage({ type: 'SKIP_WAITING' });
    return true;
  }

  async reloadIfSafe() {
    if (!this.reloadPending || this.reloadTriggered || !this._isSafeToActivate()) return false;
    if (!(await this._flushStorage())) return false;
    if (!this._isSafeToActivate()) return false;
    this.reloadPending = false;
    this.reloadTriggered = true;
    location.reload();
    return true;
  }

  async register() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      this.registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      if (!this._controllerChangeHandler) {
        this._controllerChangeHandler = () => {
          if (this.reloadTriggered) return;
          this.reloadPending = true;
          void this.reloadIfSafe();
        };
        navigator.serviceWorker.addEventListener('controllerchange', this._controllerChangeHandler);
      }
      if (this._watchedRegistration !== this.registration) {
        this._watchedRegistration = this.registration;
        this.registration.addEventListener('updatefound', () => this._watchInstalling(this.registration?.installing));
      }
      this._watchInstalling(this.registration.installing);
      await this.activateWaitingIfSafe();
      return this.registration;
    } catch (error) {
      console.warn('[VersionManager] Service worker registration failed.', error);
      return null;
    }
  }

  getState() {
    return {
      currentVersion: this.currentVersion,
      displayVersion: this.displayVersion,
      latestVersion: this.storage?.getItem('latestKnownVersion') || this.displayVersion,
      lastCheckedAt: this.storage?.getItem('versionLastCheckedAt') || ''
    };
  }

  async check({ autoApply = false } = {}) {
    const response = await fetch(`${this.versionUrl}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`VERSION_HTTP_${response.status}`);
    const data = await response.json();
    const remoteVersion = data.version || data.displayVersion || '';
    const remoteDisplay = data.displayVersion || remoteVersion;
    if (!remoteVersion) throw new Error('VERSION_INVALID');
    const checkedAt = new Date().toISOString();
    this.storage?.setItem('latestKnownVersion', remoteDisplay);
    this.storage?.setItem('versionLastCheckedAt', checkedAt);
    const hasUpdate = compareVersions(remoteVersion, this.currentVersion) > 0;
    const result = { hasUpdate, remoteVersion, remoteDisplay, checkedAt, data };
    if (hasUpdate && autoApply) await this.applyUpdate();
    return result;
  }

  async applyUpdate() {
    if (!('serviceWorker' in navigator)) {
      if (!this._isSafeToActivate()) return false;
      if (!(await this._flushStorage())) return false;
      if (!this._isSafeToActivate()) return false;
      await this.clearAppCaches();
      if (!this._isSafeToActivate()) return false;
      location.reload();
      return true;
    }
    const reg = this.registration || await navigator.serviceWorker.getRegistration('./') || await this.register();
    if (!reg) {
      if (!this._isSafeToActivate()) return false;
      if (!(await this._flushStorage())) return false;
      if (!this._isSafeToActivate()) return false;
      await this.clearAppCaches();
      if (!this._isSafeToActivate()) return false;
      location.reload();
      return true;
    }

    try {
      await reg.update();
    } catch {
      // Keep the current offline-capable cache intact when the update network
      // request fails. A later startup check can retry safely.
      return false;
    }
    if (await this.activateWaitingIfSafe(reg.waiting)) return true;
    if (reg.installing) {
      this._watchInstalling(reg.installing);
      return false;
    }

    // A healthy active worker with no waiting/installing replacement means no
    // atomic update is ready. Do not delete the shell it currently serves.
    if (reg.active) return false;

    if (!this._isSafeToActivate()) return false;
    if (!(await this._flushStorage())) return false;
    if (!this._isSafeToActivate()) return false;
    await this.clearAppCaches();
    if (!this._isSafeToActivate()) return false;
    location.reload();
    return true;
  }

  async clearAppCaches() {
    if (!('caches' in window)) return;
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(this.cachePrefix)).map(key => caches.delete(key)));
  }
}

export { compareVersions };
