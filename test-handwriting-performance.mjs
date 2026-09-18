import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

class MockContext {
  constructor() { this.fullPaints = 0; this.segmentPaints = 0; this.contacts = 0; }
  save() {}
  restore() {}
  setTransform() {}
  fillRect() { this.fullPaints += 1; }
  scale() {}
  setLineDash() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  stroke() { this.segmentPaints += 1; }
  strokeRect() {}
  arc() {}
  fill() { this.contacts += 1; }
  fillText() {}
}

class MockCanvas {
  constructor() {
    this.width = 300;
    this.height = 150;
    this.context = new MockContext();
    this.listeners = new Map();
    this.listenerOptions = new Map();
  }
  getContext() { return this.context; }
  setAttribute() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 400 }; }
  addEventListener(type, listener, options) {
    this.listeners.set(type, listener);
    this.listenerOptions.set(type, options);
  }
  removeEventListener(type) { this.listeners.delete(type); }
  setPointerCapture() {}
  releasePointerCapture() {}
  emit(type, event) { this.listeners.get(type)?.(event); }
}

test('50 questions score inline without navigation, DOM replacement, scroll or canvas resize', async () => {
  const { canvas, event } = await makeEngine();
  const { HandwritingEngine } = await import('./handwriting-engine.js');
  const elements = new Map();
  const element = key => {
    if (!elements.has(key)) elements.set(key, { textContent: '', innerHTML: '', style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {} }, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; } });
    return elements.get(key);
  };
  document.getElementById = id => id === 'kana-writing-canvas' ? canvas : element(id);
  const container = { innerHTML: '', querySelector: element };
  const said = [], recorded = [];
  const context = { Views: {}, document, HandwritingEngine, escapeHTML: String,
    TTS: { stop() {}, speakKana: ch => said.push(ch) },
    KanaProgress: { recordAttempt: ch => recorded.push(ch.character) },
    GDrive: { scheduleStudyStreakSync() {} },
    recordStudyActivity() {}, STUDY_ACTIVITY_TYPES: { KANA_HANDWRITING: 'kana' },
    showToast() {}, Router: {}, todayStr: () => '2026-09-13' };
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  vm.runInNewContext(source.slice(source.indexOf('Views.kanaPractice ='), source.indexOf('Views.kanaReadingPractice =')), context);
  const view = context.Views.kanaPractice;
  view._bindViewportLayout = () => {};
  view._resolveLayout = () => 'tablet';
  let completed = false;
  view._finishWriterSession = () => { completed = true; view.engine.destroy(); };
  view.state.items = Array.from({length:50}, (_, i) => ({ id:String(i), character:String(i), romaji:'a', scriptLabel:'平假名', rowLabel:'あ行', strokes:['M0 0L10 10'], starts:[] }));
  view.state.index = 0; view.state.results = []; view.state.mode = 'recall'; view.state.autoSpeak = true;
  view.renderWriter(container);
  const originalEngine = view.engine;
  const writerHTML = container.innerHTML;
  const scorePanel = element('kana-score-panel');
  const body = element('.kana-session-body');
  const originalResize = originalEngine.resize.bind(originalEngine);
  let resizes = 0;
  originalEngine.resize = (...args) => { resizes++; return originalResize(...args); };
  const click = id => element(id).listeners.click({ currentTarget: element(id) });
  click('kana-score-btn');
  assert.equal(view.state.scored, false, 'empty canvas cannot be scored');
  assert.equal(recorded.length, 0);
  for (let i = 0; i < 50; i++) {
    assert.equal(view.engine, originalEngine);
    assert.equal(view.engine.strokes.length, 0);
    assert.equal(said.at(-1), String(i));
    click('kana-listen-btn'); assert.equal(said.at(-1), String(i));
    click('kana-reveal-btn'); assert.equal(element('kana-reference-character').textContent, String(i));
    canvas.emit('pointerdown', event({pointerId:i+1}));
    click('kana-score-btn');
    assert.equal(view.state.scored, false, 'a live stroke cannot be interrupted by scoring');
    canvas.emit('pointerup', event({pointerId:i+1,clientX:100}));
    const ink = JSON.stringify(view.engine.strokes);
    const bitmap = [canvas.width, canvas.height];
    body.scrollTop = 37;
    click('kana-score-btn');
    assert.equal(container.innerHTML, writerHTML, 'the writing page is not replaced');
    assert.equal(scorePanel.innerHTML, '', 'the score scaffold is not rebuilt');
    assert.equal(view.engine, originalEngine);
    assert.equal(JSON.stringify(view.engine.strokes), ink);
    assert.deepEqual([canvas.width, canvas.height], bitmap);
    assert.equal(resizes, 0, 'scoring never requests a new canvas size');
    assert.equal(body.scrollTop, 37, 'scoring preserves the exact scroll offset');
    assert.equal(element('kana-score-value').textContent, `${view.state.results[i].score} 分`);
    assert.equal(element('kana-score-shape').textContent, `${view.state.results[i].shape} / 40`);
    assert.equal(element('kana-undo-btn').disabled, true);
    assert.equal(element('kana-clear-btn').disabled, true);
    click('kana-clear-btn'); click('kana-undo-btn');
    assert.equal(JSON.stringify(view.engine.strokes), ink, 'scored ink cannot be cleared accidentally');
    view.scoreCurrent(container, view.state.items[i], element('kana-score-btn'));
    assert.equal(recorded.at(-1), String(i));
    assert.equal(view.state.results.length, i+1);
    assert.equal(recorded.length, i+1, 'duplicate scoring is ignored');
    assert.equal(completed, false, 'last score remains visible until the user exits');
    if(i===49) {
      assert.match(element('kana-score-feedback').textContent, /五十音手寫完成（50 題）/);
      assert.match(element('kana-score-feedback').textContent, /平均/);
      assert.equal(element('kana-score-btn').textContent, '完成並返回練習設定');
    } else assert.equal(element('kana-score-btn').textContent, '下一個假名');
    click('kana-score-btn');
    if(i<49) {
      assert.equal(element('kana-reference-character').textContent,'？');
      assert.equal(element('kana-reveal-btn').hidden,false);
      assert.equal(element('kana-score-value').textContent, '—');
      assert.equal(element('kana-undo-btn').disabled, false);
      assert.equal(element('kana-clear-btn').disabled, false);
    }
  }
  assert.equal(completed, true);
  assert.equal(canvas.listeners.size, 0);
});

test('ink is drawn immediately even when animation frames never run', async () => {
  const frames = new Map();
  let nextFrame = 1;
  globalThis.window = { devicePixelRatio: 3 };
  globalThis.HTMLCanvasElement = MockCanvas;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.Path2D = class {};
  globalThis.requestAnimationFrame = callback => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => frames.delete(id);

  const { HandwritingEngine } = await import('./handwriting-engine.js');
  const canvas = new MockCanvas();
  let strokeCount = 0;
  const engine = new HandwritingEngine(canvas, { onChange: count => { strokeCount = count; } });
  engine.setKana({ strokes: [], starts: [] });

  assert.equal(canvas.width, 800, 'Retina canvas is capped at 2x instead of 3x');
  const paintsBeforeWriting = canvas.context.fullPaints;
  const strokesBeforeWriting = canvas.context.segmentPaints;
  assert.equal(canvas.listenerOptions.get('pointermove')?.passive, true);
  const baseEvent = {
    pointerId: 7, pointerType: 'touch', pressure: 0.5, timeStamp: 1,
    clientX: 10, clientY: 10, preventDefault() {}
  };
  canvas.emit('pointerdown', baseEvent);
  assert.equal(canvas.context.contacts, 1, 'contact appears before any move or frame');

  const samples = Array.from({ length: 40 }, (_, index) => ({
    ...baseEvent, clientX: 12 + index * 2, clientY: 12 + index * 1.5, timeStamp: index + 2
  }));
  canvas.emit('pointermove', { ...baseEvent, getCoalescedEvents: () => samples });
  canvas.emit('pointermove', { ...baseEvent, getCoalescedEvents: () => samples.slice(-3) });

  assert.equal(frames.size, 0, 'ink never waits for an animation frame');
  assert.equal(canvas.context.fullPaints, paintsBeforeWriting, 'pointer movement does not clear the canvas');
  assert.equal(canvas.context.segmentPaints - strokesBeforeWriting, 1,
    'coalesced samples are painted immediately as one batched Canvas path');
  assert.equal(canvas.context.fullPaints, paintsBeforeWriting);

  canvas.emit('pointerup', { ...baseEvent, clientX: 90, clientY: 72, timeStamp: 50 });
  assert.equal(strokeCount, 1);
  engine.destroy();
});

async function makeEngine() {
  const frames = new Map(); let nextFrame = 1;
  globalThis.window = Object.assign(new EventTarget(), { devicePixelRatio: 2 });
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  globalThis.HTMLCanvasElement = MockCanvas;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.Path2D = class {};
  globalThis.requestAnimationFrame = cb => { const id = nextFrame++; frames.set(id, cb); return id; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const { HandwritingEngine } = await import('./handwriting-engine.js');
  const canvas = new MockCanvas();
  const engine = new HandwritingEngine(canvas);
  engine.setKana({ strokes: ['M0 0L10 10'], starts: [] });
  const event = (overrides = {}) => ({ pointerId: 1, pointerType: 'touch', pressure: 0.5, clientX: 20, clientY: 20, timeStamp: 1, preventDefault() {}, ...overrides });
  return { engine, canvas, frames, event };
}

test('input modes isolate Pencil from palm and retain touch/mouse support', async () => {
  const { engine, canvas, event } = await makeEngine();
  engine.inputMode = 'pen';
  canvas.emit('pointerdown', event());
  assert.equal(engine.pointerId, null);
  canvas.emit('pointerdown', event({ pointerType: 'pen' }));
  assert.equal(engine.pointerId, 1);
  canvas.emit('pointerup', event({ pointerType: 'pen', clientX: 100 }));
  engine.inputMode = 'touch'; engine.penRecentlyActiveUntil = 0;
  canvas.emit('pointerdown', event({ pointerId: 2, pointerType: 'pen' }));
  assert.equal(engine.pointerId, null);
  canvas.emit('pointerdown', event({ pointerId: 3 }));
  canvas.emit('pointerup', event({ pointerId: 3, clientX: 90 }));
  assert.equal(engine.strokes.length, 2);
  engine.destroy();
});

test('50 questions reuse backing canvas and clear all previous strokes and reveals', async () => {
  const { engine, canvas, event } = await makeEngine();
  const listeners = [...canvas.listeners.values()];
  for (let i = 0; i < 50; i++) {
    engine.setKana({ character: String(i), strokes: [], starts: [] });
    assert.equal(engine.strokes.length, 0);
    assert.equal(engine.reveal, false);
    canvas.emit('pointerdown', event({ pointerId: i + 1 }));
    canvas.emit('pointerup', event({ pointerId: i + 1, clientX: 90 }));
    engine.revealGuide();
    assert.equal(engine.strokes.length, 1);
    assert.deepEqual([...canvas.listeners.values()], listeners);
  }
  engine.destroy();
});

test('cached reference samples produce identical scores for identical input', async () => {
  const { engine, canvas, event } = await makeEngine();
  let sampled = 0;
  document.createElementNS = () => ({ setAttribute() {}, getTotalLength: () => 10,
    getPointAtLength: length => { sampled++; return { x: length, y: length }; } });
  engine.setKana({ strokes: ['M1 1L9 9'], starts: [] });
  canvas.emit('pointerdown', event());
  canvas.emit('pointerup', event({ clientX: 90 }));
  const first = engine.score();
  const count = sampled;
  assert.ok(count > 0);
  assert.deepEqual(engine.score(), first);
  assert.equal(sampled, count);
  engine.destroy();
});

test('lost capture preserves a stroke and window events continue it without duplication', async () => {
  const { engine, canvas, event } = await makeEngine();
  canvas.emit('pointerdown', event());
  canvas.emit('pointermove', event({ clientX: 90 }));
  canvas.emit('lostpointercapture', event({ clientX: 0, clientY: 0 }));
  assert.equal(engine.pointerId, 1);
  assert.equal(engine.strokes[0].length, 2, 'capture loss adds no fake coordinate');
  const outside = (type, fields) => {
    const e = new Event(type);
    Object.assign(e, { pointerId: 1, pointerType: 'touch', clientX: 110, clientY: 20, pressure: .5 }, fields);
    window.dispatchEvent(e);
  };
  outside('pointermove');
  assert.equal(engine.strokes.length, 1);
  assert.equal(engine.strokes[0].length, 3);
  outside('pointerup', { clientX: 120 });
  assert.equal(engine.pointerId, null);
  canvas.emit('pointerdown', event({ pointerId: 2 }));
  canvas.emit('pointerup', event({ pointerId: 2, clientX: 100 }));
  assert.equal(engine.strokes.length, 2);
  engine.destroy();
  outside('pointermove');
  assert.equal(engine.pointerId, null);
});

test('fresh primary contact recovers after capture and up were both lost', async () => {
  const { engine, canvas, event } = await makeEngine();
  canvas.emit('pointerdown', event());
  canvas.emit('pointermove', event({ clientX: 90 }));
  canvas.emit('lostpointercapture', event());
  canvas.emit('pointerdown', event({ pointerId: 2, isPrimary: true }));
  assert.equal(engine.pointerId, 2);
  assert.equal(engine.strokes.length, 2);
  canvas.emit('pointerup', event({ pointerId: 2, clientX: 100 }));
  engine.destroy();
});

test('coalesced failures and stale lists retain the latest real endpoint', async () => {
  const { engine, canvas, event } = await makeEngine();
  canvas.emit('pointerdown', event());
  canvas.emit('pointermove', event({ timeStamp: 2, clientX: 80, getCoalescedEvents() { throw Error('unavailable'); } }));
  canvas.emit('pointermove', event({ timeStamp: 4, clientX: 120, getCoalescedEvents: () => [event({timeStamp:3,clientX:100})] }));
  assert.equal(engine.strokes[0].length, 4);
  assert.equal(engine.strokes[0].at(-1).x, 120 / 400 * 109);
  canvas.emit('pointerup', event({ timeStamp: 5, clientX: 120 }));
  assert.equal(engine.strokes[0].length, 4, 'duplicate endpoint is not appended');
  engine.destroy();
});

test('cancellation and returning from background preserve real samples without phantom dots', async () => {
  const { engine, canvas, event } = await makeEngine();
  canvas.emit('pointerdown', event());
  canvas.emit('pointercancel', event({ clientX: 0, clientY: 0 }));
  assert.equal(engine.strokes.length, 0);
  canvas.emit('pointerdown', event({ pointerId: 2 }));
  canvas.emit('pointermove', event({ pointerId: 2, clientX: 80 }));
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(engine.pointerId, null);
  assert.equal(engine.strokes.length, 1);
  document.visibilityState = 'visible';
  canvas.emit('pointerdown', event({ pointerId: 3 }));
  assert.equal(engine.pointerId, 3);
  window.dispatchEvent(new Event('blur'));
  assert.equal(engine.pointerId, null);
  engine.destroy();
});

test('Pencil preempts an accidental palm touch and palm protection renews on pen-up', async () => {
  const { engine, canvas, event } = await makeEngine();
  canvas.emit('pointerdown', event());
  canvas.emit('pointerdown', event({ pointerId: 2, pointerType: 'pen' }));
  assert.equal(engine.pointerId, 2);
  assert.equal(engine.strokes.length, 1);
  engine.penRecentlyActiveUntil = 0;
  canvas.emit('pointerup', event({ pointerId: 2, pointerType: 'pen', clientX: 90 }));
  assert.ok(engine.penRecentlyActiveUntil > Date.now());
  canvas.emit('pointerdown', event({ pointerId: 3 }));
  assert.equal(engine.pointerId, null);
  assert.equal(engine.strokes.length, 1);
  engine.destroy();
});

test('guide animation and direct resize cannot repaint an active stroke', async () => {
  const { engine, canvas, event } = await makeEngine();
  engine.animateGuide();
  assert.notEqual(engine.animationTimer, null);
  canvas.emit('pointerdown', event());
  assert.equal(engine.animationTimer, null);
  const paints = canvas.context.fullPaints;
  engine.animateGuide(); engine.revealGuide(); engine.resize();
  assert.equal(canvas.context.fullPaints, paints);
  assert.equal(engine.resizePending, true);
  canvas.emit('pointerup', event({ clientX: 100 }));
  engine.destroy();
});

test('one hundred consecutive strokes remain responsive and destroy removes handlers and frames', async () => {
  const { engine, canvas, frames, event } = await makeEngine();
  for (let i = 0; i < 100; i++) {
    canvas.emit('pointerdown', event({ pointerId: i + 1 }));
    for (let j = 0; j < 40; j++) canvas.emit('pointermove', event({ pointerId: i + 1, clientX: 30 + j * 2 }));
    canvas.emit('pointerup', event({ pointerId: i + 1, clientX: 120 }));
    assert.equal(engine.pointerId, null);
    assert.ok(frames.size <= 1);
  }
  assert.equal(engine.strokes.length, 100);
  engine.destroy();
  assert.equal(frames.size, 0);
  assert.equal(canvas.listeners.size, 0);
});
