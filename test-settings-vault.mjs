import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { encryptSettings, decryptSettings, validateSettings, applySettings, MAX_SETTINGS_BYTES } from './settings-vault.js';
import { normalizeDailyLearningPreferences } from './daily-learning.js';
const fixture = () => ({
  gdriveClientId:'example.apps.googleusercontent.com', gdriveFolderId:'test-folder-123',
  geminiApiKey:'TEST-ONLY-NOT-A-REAL-KEY', geminiModel:'gemini-test', gdriveAutoSync:'1',
  ttsEnabled:'false', ttsDelay:'300', japaneseJlptLevel:'N4', lastPracticeMode:'kana', dbSortMode:'createdAt',
  dailyLearningPreferencesV1:JSON.stringify(normalizeDailyLearningPreferences({source:'level',scriptRows:{hiragana:['a','ka'],katakana:['sa']}})),
  wordPracticePreferencesV1:JSON.stringify({count:10,order:'all'}),
  kanaPracticePreferencesV1:JSON.stringify({script:'katakana',rows:['ka'],repeat:3,mode:'copy',count:10,weakOnly:false,layout:'auto',inputMode:'auto',diagnostics:false,autoSpeak:true}),
  kanaReadingPreferencesV1:JSON.stringify({script:'katakana',rows:['a','ka'],repeat:3}),
  wordReadingPreferencesV1:JSON.stringify({script:'both',rows:['all'],count:10})
});
const password = 'Test-only-password-2026';
test('encrypted settings roundtrip includes requested secrets and both kana row preferences', async () => {
  const original=fixture(), encrypted=await encryptSettings(original,password);
  assert.ok(!encrypted.includes(original.geminiApiKey));
  assert.ok(!encrypted.includes(original.gdriveClientId));
  assert.ok(!encrypted.includes(original.gdriveFolderId));
  assert.deepEqual((await decryptSettings(encrypted,password)).settings,original);
  const second=JSON.parse(await encryptSettings(original,password)),first=JSON.parse(encrypted);
  assert.notEqual(first.salt,second.salt); assert.notEqual(first.iv,second.iv); assert.notEqual(first.ciphertext,second.ciphertext);
});
test('wrong password, modified cipher and modified IV are rejected', async () => {
  const raw=await encryptSettings(fixture(),password);
  await assert.rejects(decryptSettings(raw,'another-password-123'),/密碼錯誤或檔案已損壞/);
  for (const field of ['ciphertext','iv']) {
    const data=JSON.parse(raw), bytes=Buffer.from(data[field],'base64'); bytes[0]^=1; data[field]=bytes.toString('base64');
    await assert.rejects(decryptSettings(JSON.stringify(data),password),/密碼錯誤或檔案已損壞/);
  }
});
test('unbounded KDF work, unsupported version and oversized files fail before derivation', async () => {
  const data=JSON.parse(await encryptSettings(fixture(),password));
  await assert.rejects(decryptSettings(JSON.stringify({...data,iterations:999999999}),password),/不支援/);
  await assert.rejects(decryptSettings(JSON.stringify({...data,version:2}),password),/不支援/);
  await assert.rejects(decryptSettings(' '.repeat(MAX_SETTINGS_BYTES+1),password),/過大/);
  await assert.rejects(encryptSettings(fixture(),'short'),/12～256/);
});
test('strict allowlist rejects session credentials, incomplete and malformed preferences', () => {
  for (const extra of ['japaneseGdriveSessionToken','dailyReminderManagementTokenV1','vocabWords','__proto__']) {
    const data=JSON.parse(JSON.stringify(fixture())); Object.defineProperty(data,extra,{value:'forbidden',enumerable:true});
    assert.throws(()=>validateSettings(data),/格式不符/);
  }
  const missing=fixture(); delete missing.geminiApiKey; assert.throws(()=>validateSettings(missing));
  assert.throws(()=>validateSettings({...fixture(),kanaPracticePreferencesV1:'{"script":"bad"}'}));
  assert.throws(()=>validateSettings({...fixture(),japaneseJlptLevel:'N0'}));
});
test('decrypt does not write; restore is one awaited atomic update and preserves learning data', async () => {
  const store=new Map([['vocabWords','existing'],['dailyReminderSettingsV1','device-only']]); let commits=0;
  const storage={setItem:(k,v)=>stage.set(k,v),atomicUpdate:async cb=>{stage=new Map(store);cb();await Promise.resolve();commits++;store.clear();for(const [k,v] of stage)store.set(k,v);}};
  let stage;
  const decrypted=await decryptSettings(await encryptSettings(fixture(),password),password);
  assert.equal(commits,0); await applySettings(storage,decrypted.settings);
  assert.equal(commits,1);assert.equal(store.get('geminiApiKey'),fixture().geminiApiKey);
  assert.equal(store.get('vocabWords'),'existing');assert.equal(store.get('dailyReminderSettingsV1'),'device-only');
  await assert.rejects(applySettings({...storage,atomicUpdate:async()=>{throw Error('disk full');}},fixture()),/disk full/);
  assert.equal(commits,1);
  const before=new Map(store);
  await assert.rejects(applySettings(storage,{...fixture(),geminiApiKey:'replacement'},()=>{throw Error('staged failure');}),/staged failure/);
  assert.deepEqual(store,before);
});

test('explicit empty Drive settings survive export and restore instead of reverting to built-in IDs', () => {
  const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
  for (const [name,defaultKey] of [['getGDriveClientId','oauthClientId'],['getGDriveFolderId','driveFolderId']]) {
    const getter=source.match(new RegExp(name+'\\(\\)\\s*\\{[^}]+\\}'))[0];
    const defaults={oauthClientId:'default-client',driveFolderId:'default-folder'};
    const read=value=>vm.runInNewContext(`({${getter}}).${name}()`,{AppStorage:{getItem:()=>value},JAPANESE_DEFAULTS:defaults});
    assert.equal(read(null),defaults[defaultKey]);assert.equal(read(''),'');assert.equal(read('saved-id'),'saved-id');
  }
});
