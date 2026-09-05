import test from 'node:test';
import assert from 'node:assert/strict';

class MockContext {
  constructor() { this.fullPaints = 0; this.segmentPaints = 0; }
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
  fill() {}
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

test('handwriting batches pointer samples and avoids full-canvas repaint while drawing', async () => {
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

  const samples = Array.from({ length: 40 }, (_, index) => ({
    ...baseEvent, clientX: 12 + index * 2, clientY: 12 + index * 1.5, timeStamp: index + 2
  }));
  canvas.emit('pointermove', { ...baseEvent, getCoalescedEvents: () => samples });
  canvas.emit('pointermove', { ...baseEvent, getCoalescedEvents: () => samples.slice(-3) });

  assert.equal(frames.size, 1, 'multiple pointer events share one animation frame');
  assert.equal(canvas.context.fullPaints, paintsBeforeWriting, 'pointer movement does not clear the canvas');
  for (const callback of [...frames.values()]) callback();
  frames.clear();
  assert.equal(canvas.context.segmentPaints - strokesBeforeWriting, 1,
    'many touch samples are painted as one batched Canvas path');
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

test('lost capture releases the input lock and the next stroke works', async () => {
  const { engine, canvas, event } = await makeEngine();
  canvas.emit('pointerdown', event());
  canvas.emit('pointermove', event({ clientX: 90 }));
  canvas.emit('lostpointercapture', event({ clientX: 0, clientY: 0 }));
  assert.equal(engine.pointerId, null);
  assert.equal(engine.strokes[0].length, 2, 'capture loss adds no fake coordinate');
  canvas.emit('pointerdown', event({ pointerId: 2 }));
  canvas.emit('pointerup', event({ pointerId: 2, clientX: 100 }));
  assert.equal(engine.strokes.length, 2);
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
