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
  }
  getContext() { return this.context; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 400 }; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
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
  assert.ok(canvas.context.segmentPaints > 0, 'new line segments are rendered incrementally');
  assert.equal(canvas.context.fullPaints, paintsBeforeWriting);

  canvas.emit('pointerup', { ...baseEvent, clientX: 90, clientY: 72, timeStamp: 50 });
  assert.equal(strokeCount, 1);
  engine.destroy();
});
