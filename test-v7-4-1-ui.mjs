import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const style = await readFile(new URL('./style.css', import.meta.url), 'utf8');

test('home practice cards separate title and subtitle content', () => {
  assert.equal((app.match(/class="menu-card-copy"/g) || []).length, 4);
  assert.match(style, /\.menu-card-copy\s*\{[^}]*flex-direction:column[^}]*gap:/s);
  assert.doesNotMatch(style, /\.menu-card-sub\s*\{[^}]*margin-top:\s*-\s*6px/s);
});

test('settings section icons have bounded mobile dimensions', () => {
  assert.match(style, /\.settings-section-label\s*>\s*svg\s*\{[^}]*width:\s*16px[^}]*height:\s*16px[^}]*flex:\s*0\s+0\s+16px/s);
});

test('small screens retain readable practice card spacing', () => {
  assert.match(style, /@media\s*\(max-width:\s*380px\)[\s\S]*?\.menu-card\s*\{[^}]*min-height:\s*108px/s);
  assert.match(style, /\.menu-card-sub\s*\{[^}]*line-height:\s*1\.45/s);
});
