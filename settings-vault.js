// Portable settings only. Never include OAuth tokens, device identities or learning records.
const FORMAT = 'japanese-pwa-settings';
const ITERATIONS = 600000;
export const MAX_SETTINGS_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const aad = encoder.encode(`${FORMAT}:1:PBKDF2-SHA256:${ITERATIONS}:AES-256-GCM`);
const choices = values => value => values.includes(value);
const shortText = max => value => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/u.test(value);
const rows = value => Array.isArray(value) && value.length <= 11 && value.every(choices(['all','a','ka','sa','ta','na','ha','ma','ya','ra','wa']));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const script = choices(['hiragana','katakana','both']);
const repeat = choices([1,2,3,5,10]);
const bool = value => typeof value === 'boolean';
function jsonSetting(check) {
  return raw => {
    if (typeof raw !== 'string' || raw.length > 8192) return false;
    try { const value = JSON.parse(raw); return object(value) && check(value); } catch { return false; }
  };
}
const rules = {
  gdriveClientId: shortText(512), gdriveFolderId: shortText(512), geminiApiKey: shortText(512),
  geminiModel: value => /^gemini-[a-z0-9.-]{1,100}$/i.test(value),
  gdriveAutoSync: choices(['0','1']), ttsEnabled: choices(['true','false']),
  ttsDelay: choices(['0','300','600','1000','2000']), japaneseJlptLevel: choices(['N1','N2','N3','N4','N5']),
  lastPracticeMode: choices(['quiz','kana','kanaReading','wordReading','essay','reading','aiask']),
  dbSortMode: choices(['createdAt','alpha','wrongCount']),
  dailyLearningPreferencesV1: jsonSetting(v => choices(['database','level'])(v.source) && rows(v.rows) && object(v.scriptRows) && rows(v.scriptRows.hiragana) && rows(v.scriptRows.katakana)),
  wordPracticePreferencesV1: jsonSetting(v => choices([5,10,15,20,25,30])(v.count) && choices(['newest','all'])(v.order)),
  kanaPracticePreferencesV1: jsonSetting(v => script(v.script) && rows(v.rows) && repeat(v.repeat) && choices(['trace','copy','recall'])(v.mode) && choices([0,5,10,20])(v.count) && bool(v.weakOnly) && choices(['auto','phone','tablet'])(v.layout) && choices(['auto','pen','touch'])(v.inputMode) && bool(v.diagnostics) && bool(v.autoSpeak)),
  kanaReadingPreferencesV1: jsonSetting(v => script(v.script) && rows(v.rows) && repeat(v.repeat)),
  wordReadingPreferencesV1: jsonSetting(v => script(v.script) && rows(v.rows) && choices([5,10,15,20,25,30])(v.count))
};
export const SETTINGS_GROUPS = {
  'Google Drive':['gdriveClientId','gdriveFolderId','gdriveAutoSync'],
  'AI':['geminiApiKey','geminiModel'],
  '發音':['ttsEnabled','ttsDelay'],
  '學習偏好':['japaneseJlptLevel','lastPracticeMode','dbSortMode','dailyLearningPreferencesV1','wordPracticePreferencesV1','kanaPracticePreferencesV1','kanaReadingPreferencesV1','wordReadingPreferencesV1']
};
export function selectSettings(current, incoming, groups) {
  const result = {...validateSettings(current)};
  validateSettings(incoming);
  groups.forEach(group => { if (!SETTINGS_GROUPS[group]) throw new Error('UNKNOWN_SETTINGS_GROUP'); SETTINGS_GROUPS[group].forEach(key => result[key] = incoming[key]); });
  return validateSettings(result);
}
export const SETTINGS_KEYS = Object.freeze(Object.keys(rules));
export function validateSettings(settings) {
  if (!object(settings) || Object.keys(settings).length !== SETTINGS_KEYS.length || Object.keys(settings).some(key => !Object.hasOwn(rules, key))) throw new Error('設定檔格式不符，未變更本機設定。');
  const clean = {};
  for (const key of SETTINGS_KEYS) {
    if (typeof settings[key] !== 'string' || !rules[key](settings[key])) throw new Error('設定內容不完整或不支援，未變更本機設定。');
    clean[key] = settings[key];
  }
  return clean;
}
function bytesToBase64(bytes) { return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')); }
function base64ToBytes(value, expected) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4) throw new Error('加密檔案格式不符。');
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if ((expected && bytes.length !== expected) || bytesToBase64(bytes) !== value) throw new Error('加密檔案格式不符。');
  return bytes;
}
async function derive(password, salt) {
  if (!globalThis.crypto?.subtle) throw new Error('此環境不支援加密，請使用 HTTPS 或本機開發網址。');
  if (typeof password !== 'string' || password.length < 12 || password.length > 256 || password.trim().length < 12) throw new Error('請使用 12～256 個字元的密碼。');
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name:'PBKDF2', hash:'SHA-256', salt, iterations:ITERATIONS }, material, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
}
export async function encryptSettings(settings, password) {
  const clean = validateSettings(settings);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(password, salt);
  const data = encoder.encode(JSON.stringify({ format:FORMAT, version:1, createdAt:new Date().toISOString(), settings:clean }));
  try {
    const ciphertext = await crypto.subtle.encrypt({ name:'AES-GCM', iv, additionalData:aad, tagLength:128 }, key, data);
    return JSON.stringify({ format:FORMAT, version:1, kdf:'PBKDF2-SHA256', iterations:ITERATIONS, cipher:'AES-256-GCM', salt:bytesToBase64(salt), iv:bytesToBase64(iv), ciphertext:bytesToBase64(new Uint8Array(ciphertext)) });
  } finally { data.fill(0); }
}
export async function decryptSettings(raw, password) {
  if (typeof raw !== 'string' || encoder.encode(raw).byteLength > MAX_SETTINGS_BYTES) throw new Error('設定檔過大或格式不符。');
  let envelope;
  try { envelope = JSON.parse(raw); } catch { throw new Error('請選擇本程式匯出的 .jpsettings 加密檔案。'); }
  if (!object(envelope) || envelope.format !== FORMAT || envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== ITERATIONS || envelope.cipher !== 'AES-256-GCM') throw new Error('不支援此設定檔版本或加密格式。');
  const salt = base64ToBytes(envelope.salt,16), iv = base64ToBytes(envelope.iv,12), cipher = base64ToBytes(envelope.ciphertext);
  if (cipher.length < 16) throw new Error('加密檔案不完整。');
  const key = await derive(password,salt);
  let plaintext;
  try { plaintext = new Uint8Array(await crypto.subtle.decrypt({ name:'AES-GCM', iv, additionalData:aad, tagLength:128 }, key, cipher)); }
  catch { throw new Error('密碼錯誤或檔案已損壞，未變更本機設定。'); }
  try {
    const payload = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext));
    if (payload.format !== FORMAT || payload.version !== 1 || typeof payload.createdAt !== 'string' || !Number.isFinite(Date.parse(payload.createdAt))) throw new Error('設定檔內容不符。');
    return { createdAt:payload.createdAt, settings:validateSettings(payload.settings) };
  } finally { plaintext.fill(0); }
}
export async function applySettings(storage, settings, onStage = () => {}) {
  const clean = validateSettings(settings);
  await storage.atomicUpdate(() => {
    for (const key of SETTINGS_KEYS) storage.setItem(key, clean[key]);
    onStage();
  });
}

// UI stays outside the app's large render function; no passwords in persistent storage.
export function mountSettingsVault({ container, modal, snapshot, restore, available, notify, busyChanged, icon }) {
  const wrap = container.querySelector('.settings-wrap');
  if (!wrap) return;
  const section = document.createElement('section');
  section.className = 'settings-card settings-vault';
  section.setAttribute('aria-labelledby','settings-vault-title');
  section.innerHTML = `<div class="vault-heading">${icon('lock')}<h2 id="settings-vault-title">加密設定備份</h2><span>本機加密</span></div>
    <p>一次帶走 Google Drive OAuth ID、資料夾、AI Key、模型與學習／發音偏好。</p>
    <div class="vault-actions"><button type="button" class="btn-primary" data-vault="export">${icon('download')} 匯出加密設定</button><button type="button" class="btn-secondary" data-vault="import">${icon('upload')} 匯入加密設定</button></div>
    <p class="vault-note">匯出已儲存的設定；輸入後請先按儲存。單字與練習紀錄請使用上方資料備份。Google 登入授權及此裝置通知訂閱不會移轉。</p>`;
  wrap.append(section);
  section.querySelectorAll('[data-vault]').forEach(button => button.addEventListener('click', () => {
    if (!available()) { notify('請等目前的傳輸或產生工作完成，再進行設定備份。'); return; }
    const exporting = button.dataset.vault === 'export';
    let closed = false, preview = null, url = null;
    const close = () => {
      closed = true; preview = null;
      document.querySelectorAll('#vault-form input[type=password]').forEach(input => { input.value = ''; });
      if (url) URL.revokeObjectURL(url);
      busyChanged(false);
    };
    modal.show(`<div class="modal-handle"></div><h2 class="modal-title">${exporting ? '匯出加密設定' : '匯入加密設定'}</h2>
      <form id="vault-form" class="vault-form">
        <p>${exporting ? '設定只在此裝置加密。請設定備份密碼；忘記密碼將無法還原此檔案。' : '選擇加密設定檔並輸入原密碼，解密後先確認，再套用。'}</p>
        ${exporting ? '' : '<label>加密設定檔<input name="file" type="file" accept=".jpsettings,application/json" required></label>'}
        <label>備份密碼<input name="password" type="password" autocomplete="${exporting ? 'new-password' : 'current-password'}" minlength="12" maxlength="256" required placeholder="至少 12 個字元"></label>
        ${exporting ? '<label>再次輸入密碼<input name="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label>' : ''}
        <div class="vault-feedback" role="status" aria-live="polite"></div><div class="vault-preview" hidden></div>
        <div class="modal-actions"><button type="button" class="modal-btn-cancel" data-cancel>取消</button><button type="submit" class="btn-primary">${exporting ? '加密並下載' : '解密並預覽'}</button></div>
      </form>`, close);
    busyChanged(true);
    const form = document.getElementById('vault-form');
    const submit = form.querySelector('[type=submit]'), feedback = form.querySelector('.vault-feedback');
    form.querySelector('[data-cancel]').onclick = () => modal.hide();
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      const original = submit.textContent;
      try {
        if (!available()) throw new Error('有其他傳輸工作進行中，請稍後再試。');
        if (preview) {
          submit.textContent = '正在套用…';
          form.querySelector('[data-cancel]').disabled = true;
          const groups = [...form.querySelectorAll('[data-setting-group]:checked')].map(node => node.dataset.settingGroup);
          if (!groups.length) throw new Error('請至少選擇一組要還原的設定。');
          await restore(selectSettings(await snapshot(), preview.settings, groups));
          modal.hide(); notify('設定已還原；Google 登入與通知請在此裝置確認。'); return;
        }
        let password = form.elements.password.value;
        if (exporting && password !== form.elements.confirm.value) throw new Error('兩次輸入的密碼不一致。');
        feedback.textContent = exporting ? '正在加密，請稍候…' : '正在解密，請稍候…';
        if (exporting) {
          const encrypted = await encryptSettings(await snapshot(), password);
          password = '';
          if (closed) return;
          url = URL.createObjectURL(new Blob([encrypted], {type:'application/json'}));
          const link = document.createElement('a'); link.href = url;
          link.download = `日文練習-設定-${new Date().toISOString().slice(0,10)}.jpsettings`;
          link.className = 'vault-download'; link.textContent = '再次下載加密設定檔';
          form.querySelector('.vault-preview').replaceChildren(link); link.parentElement.hidden = false;
          link.click();
          form.querySelectorAll('label').forEach(label => { label.hidden = true; });
          form.querySelectorAll('input[type=password]').forEach(input => { input.value = ''; input.required = false; });
          feedback.textContent = '加密檔案已準備好，請確認已存入「檔案」或下載資料夾，並妥善保管密碼。';
          submit.hidden = true; form.querySelector('[data-cancel]').textContent = '完成';
        } else {
          const file = form.elements.file.files?.[0];
          if (!file || file.size > MAX_SETTINGS_BYTES) throw new Error('請選擇小於 128 KiB 的加密設定檔。');
          const payload = await decryptSettings(await file.text(), password); password = '';
          if (closed) return;
          preview = payload;
          form.querySelectorAll('input').forEach(input => { input.value = ''; input.required = false; input.disabled = true; });
          form.querySelectorAll('label').forEach(label => { label.hidden = true; });
          const box = form.querySelector('.vault-preview'); box.hidden = false;
          const s = preview.settings;
          // Never interpolate imported values into HTML, and never show the API key.
          box.textContent = `備份時間：${new Date(preview.createdAt).toLocaleString()}\n勾選要還原的項目；未勾選的設定維持目前值。`;
          const current = await snapshot();
          for (const [group, keys] of Object.entries(SETTINGS_GROUPS)) {
            const changed = keys.filter(key => current[key] !== s[key]);
            const label = document.createElement('label'); label.className = 'vault-group';
            const check = document.createElement('input'); check.type='checkbox'; check.dataset.settingGroup=group; check.checked=changed.length>0;
            const text = document.createElement('span'); text.textContent = `${group}：${changed.length ? `${changed.length} 個設定不同` : '與目前相同'}`;
            label.append(check,text); box.append(label);
            if (group === 'AI' && changed.includes('geminiApiKey')) {
              const hint=document.createElement('small'); hint.textContent='API Key 有變更（內容隱藏）'; box.append(hint);
            }
            if (group === 'Google Drive' && changed.includes('gdriveFolderId')) {
              const hint=document.createElement('small'); hint.textContent=`資料夾：${current.gdriveFolderId || 'Drive 根目錄'} → ${s.gdriveFolderId || 'Drive 根目錄'}`; box.append(hint);
            }
          }
          feedback.textContent = '解密成功，尚未修改設定。'; submit.textContent = '確認還原設定';
        }
      } catch (error) {
        if (!closed) feedback.textContent = error.message || '操作未完成，請再試一次。';
      } finally {
        if (!closed) { submit.disabled = false; form.querySelector('[data-cancel]').disabled = false; if (!preview) submit.textContent = original; }
      }
    });
  }));
}
