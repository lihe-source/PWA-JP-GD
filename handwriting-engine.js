const VIEWBOX_SIZE = 109;
const SVG_NS = 'http://www.w3.org/2000/svg';
const referenceCache = new Map();

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function distance(a, b) {
  return Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
}

function bounds(points) {
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function resample(points, count = 36) {
  if (!points.length) return [];
  if (points.length === 1) return Array.from({ length: count }, () => ({ ...points[0] }));
  const cumulative = [0];
  for (let index = 1; index < points.length; index++) {
    cumulative.push(cumulative[index - 1] + distance(points[index - 1], points[index]));
  }
  const total = cumulative.at(-1) || 1;
  return Array.from({ length: count }, (_, sampleIndex) => {
    const target = total * sampleIndex / Math.max(1, count - 1);
    let segment = 1;
    while (segment < cumulative.length && cumulative[segment] < target) segment++;
    const before = points[Math.max(0, segment - 1)];
    const after = points[Math.min(points.length - 1, segment)];
    const span = (cumulative[segment] || total) - (cumulative[segment - 1] || 0) || 1;
    const ratio = clamp((target - (cumulative[segment - 1] || 0)) / span, 0, 1);
    return {
      x: before.x + (after.x - before.x) * ratio,
      y: before.y + (after.y - before.y) * ratio
    };
  });
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function closestDistance(point, candidates) {
  return candidates.reduce((best, candidate) => Math.min(best, distance(point, candidate)), Infinity);
}

function symmetricPathDistance(first, second) {
  if (!first.length || !second.length) return 109;
  return (mean(first.map(point => closestDistance(point, second))) +
    mean(second.map(point => closestDistance(point, first)))) / 2;
}

function sampleSvgPath(pathData, count = 42) {
  try {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathData);
    const length = path.getTotalLength();
    return Array.from({ length: count }, (_, index) => {
      const point = path.getPointAtLength(length * index / Math.max(1, count - 1));
      return { x: point.x, y: point.y };
    });
  } catch {
    return [];
  }
}

export class HandwritingEngine {
  constructor(canvas, options = {}) {
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('HANDWRITING_CANVAS_REQUIRED');
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.options = options;
    this.inputMode = ['auto', 'pen', 'touch'].includes(options.inputMode) ? options.inputMode : 'auto';
    this.diagnostics = options.diagnostics === true;
    this.metrics = {
      frames: 0, maxDrawMs: 0, maxSampleAgeMs: 0, maxInputGapMs: 0,
      maxHandlerMs: 0, delayedInputs: 0, longTasks: 0, maxLongTaskMs: 0,
      lastScoreMs: 0, interruptions: 0, resizes: 0
    };
    this.timingSamples = this.diagnostics ? { handler: [], draw: [], inputGap: [] } : null;
    this.timingPositions = { handler: 0, draw: 0, inputGap: 0 };
    this.lastInputTime = 0;
    this.longTaskObserver = null;
    this.kana = null;
    this.mode = 'trace';
    this.strokes = [];
    this.activeStroke = null;
    this.pointerId = null;
    this.activePointerType = '';
    this.captureLost = false;
    this.fullRenderPending = false;
    this.penRecentlyActiveUntil = 0;
    this.reveal = false;
    this.animationStroke = -1;
    this.animationTimer = null;
    this.guidePaths = [];
    this.canvasRect = null;
    this.pixelRatio = 1;
    this.drawnPointIndex = 0;
    this.resizeFrame = null;
    this.resizePending = false;
    this.destroyed = false;
    if (this.diagnostics && typeof PerformanceObserver === 'function') {
      try {
        this.longTaskObserver = new PerformanceObserver(list => {
          list.getEntries().forEach(entry => {
            this.metrics.longTasks += 1;
            this.metrics.maxLongTaskMs = Math.max(this.metrics.maxLongTaskMs, entry.duration || 0);
          });
        });
        this.longTaskObserver.observe({ type: 'longtask', buffered: true });
      } catch { this.longTaskObserver = null; }
    }
    this._bindEvents();
    this.resizeObserver = new ResizeObserver(() => {
      // Safari can report visual-viewport changes while a finger/Pencil is
      // moving. Resizing the backing bitmap then would erase and redraw it in
      // the middle of the stroke, so postpone that work until pen-up.
      if (this.pointerId !== null) {
        this.resizePending = true;
        return;
      }
      this.resize();
    });
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  _bindEvents() {
    this._pointerDown = event => {
      if (this.destroyed || !this.kana) return;
      if (this.inputMode === 'pen' && event.pointerType !== 'pen') return;
      if (this.inputMode === 'touch' && event.pointerType === 'pen') return;
      if (event.pointerType === 'touch' && Date.now() < this.penRecentlyActiveUntil) return;
      if (event.pointerType === 'pen' && this.activePointerType === 'touch') this._finishStroke(null, true, true);
      // A new primary down is a fresh contact, even if an old capture was lost
      // outside the window and its up event could not be delivered.
      if (this.captureLost && event.isPrimary) this._finishStroke(null, true);
      if (this.pointerId !== null) return;
      if (event.pointerType === 'mouse' && event.button !== undefined && event.button !== 0) return;
      if (event.pointerType === 'pen') this.penRecentlyActiveUntil = Date.now() + 1200;
      if (this.animationTimer || this.animationStroke >= 0) {
        this.stopAnimation();
        this.animationStroke = -1;
        this.fullRenderPending = true;
      }
      event.preventDefault();
      this.pointerId = event.pointerId;
      this.activePointerType = event.pointerType;
      this.captureLost = false;
      try { this.canvas.setPointerCapture?.(event.pointerId); } catch {}
      this._refreshCanvasRect();
      const point = this._eventPoint(event);
      this.lastInputTime = point.time;
      this.activeStroke = [point];
      this.drawnPointIndex = 0;
      this.strokes.push(this.activeStroke);
      // Show contact immediately; do not wait for a move event or a frame.
      this._drawContact(point);
      this.options.onStrokeStart?.(this.strokes.length);
    };
    this._pointerMove = event => {
      if (event.pointerId !== this.pointerId || !this.activeStroke) return;
      const handlerStartedAt = this.diagnostics ? performance.now() : 0;
      if (this.diagnostics && Number.isFinite(event.timeStamp)) {
        const gap = this.lastInputTime ? Math.max(0, event.timeStamp - this.lastInputTime) : 0;
        this.metrics.maxInputGapMs = Math.max(this.metrics.maxInputGapMs, gap);
        this._trackTiming('inputGap', gap);
        if (gap > 50) this.metrics.delayedInputs += 1;
        this.lastInputTime = event.timeStamp;
        const age = handlerStartedAt - event.timeStamp;
        if (age >= 0 && age < 60000) this.metrics.maxSampleAgeMs = Math.max(this.metrics.maxSampleAgeMs, age);
      }
      if (this.activePointerType === 'pen') this.penRecentlyActiveUntil = Date.now() + 1200;
      this._appendPointerSamples(event);
      if (this.diagnostics) {
        const duration = performance.now() - handlerStartedAt;
        this.metrics.maxHandlerMs = Math.max(this.metrics.maxHandlerMs, duration);
        this._trackTiming('handler', duration);
      }
    };
    this._pointerUp = event => {
      if (event.pointerId !== this.pointerId) return;
      this._finishStroke(event);
    };
    this._pointerCancel = event => {
      if (event.pointerId === this.pointerId) this._finishStroke(null, true);
    };
    // Capture loss is not cancellation. Keep receiving the same stroke through
    // window bubbling; never end it solely because capture changed.
    this._captureLost = event => {
      if (event.pointerId === this.pointerId) this.captureLost = true;
    };
    this._windowMove = event => {
      if (event.target !== this.canvas) this._pointerMove(event);
    };
    this._windowUp = event => {
      if (event.target !== this.canvas) this._pointerUp(event);
    };
    this._windowCancel = event => {
      if (event.target !== this.canvas) this._pointerCancel(event);
    };
    this._interrupt = () => this._finishStroke(null, true);
    this._visibilityChange = () => {
      if (globalThis.document?.visibilityState === 'hidden') this._interrupt();
    };
    this.canvas.addEventListener('pointerdown', this._pointerDown, { passive: false });
    // `touch-action:none` already prevents scrolling. Passive move/up listeners
    // let WebKit dispatch Pencil/touch samples without waiting for JS to decide
    // whether it will cancel the browser gesture.
    this.canvas.addEventListener('pointermove', this._pointerMove, { passive: true });
    this.canvas.addEventListener('pointerup', this._pointerUp, { passive: true });
    this.canvas.addEventListener('pointercancel', this._pointerCancel, { passive: true });
    this.canvas.addEventListener('lostpointercapture', this._captureLost, { passive: true });
    globalThis.window?.addEventListener?.('pointermove', this._windowMove, { passive: true });
    globalThis.window?.addEventListener?.('pointerup', this._windowUp, { passive: true });
    globalThis.window?.addEventListener?.('pointercancel', this._windowCancel, { passive: true });
    globalThis.window?.addEventListener?.('blur', this._interrupt);
    globalThis.window?.addEventListener?.('pagehide', this._interrupt);
    globalThis.document?.addEventListener?.('visibilitychange', this._visibilityChange);
  }

  _finishStroke(event, interrupted = false, discard = false) {
    if (this.pointerId === null) return;
    const pointerId = this.pointerId;
    if (this.diagnostics && interrupted) this.metrics.interruptions += 1;
    if (event) this._appendPointerSamples(event);
    if (this.activePointerType === 'pen') this.penRecentlyActiveUntil = Date.now() + 1200;
    if (!interrupted && this.activeStroke?.length === 1) {
      const point = this.activeStroke[0];
      this.activeStroke.push({ ...point, x: point.x + 0.15, y: point.y + 0.15 });
    }
    if (discard || (interrupted && this.activeStroke?.length === 1)) {
      this.strokes = this.strokes.filter(stroke => stroke !== this.activeStroke);
      this.fullRenderPending = true;
    } else this._flushActiveStrokeSegments();
    this.activeStroke = null;
    this.drawnPointIndex = 0;
    this.pointerId = null;
    this.activePointerType = '';
    this.captureLost = false;
    // Reset state before releasing capture: WebKit may dispatch the loss event
    // immediately. A cancellation never contributes a synthetic (0, 0) point.
    try { this.canvas.releasePointerCapture?.(pointerId); } catch {}
    this.options.onStrokeEnd?.(this.strokes.length);
    this.options.onChange?.(this.strokes.length);
    if (this.diagnostics) this.options.onDiagnostic?.(this._diagnosticSnapshot());
    if (this.resizePending) this._scheduleResize();
    else if (this.fullRenderPending) this._render();
  }

  _refreshCanvasRect() {
    this.canvasRect = this.canvas.getBoundingClientRect();
    return this.canvasRect;
  }

  _trackTiming(kind, duration) {
    if (!this.timingSamples || !Number.isFinite(duration)) return;
    const samples = this.timingSamples[kind];
    const position = this.timingPositions[kind];
    samples[position % 200] = duration;
    this.timingPositions[kind] = position + 1;
  }

  _diagnosticSnapshot() {
    const percentile = (kind, fraction) => {
      const samples = [...this.timingSamples[kind]].sort((a, b) => a - b);
      return samples.length ? samples[Math.ceil(fraction * samples.length) - 1] : 0;
    };
    return {
      ...this.metrics,
      handlerP95Ms: percentile('handler', 0.95), handlerP99Ms: percentile('handler', 0.99),
      drawP95Ms: percentile('draw', 0.95), inputGapP95Ms: percentile('inputGap', 0.95)
    };
  }

  _drawContact(point) {
    const context = this.context;
    if (!context) return;
    context.save();
    context.setTransform(this.canvas.width / VIEWBOX_SIZE, 0, 0, this.canvas.height / VIEWBOX_SIZE, 0, 0);
    context.fillStyle = '#102a43';
    context.beginPath();
    context.arc(point.x, point.y, this._lineWidth(point, point) / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  _eventPoint(event) {
    const rect = this.canvasRect || this._refreshCanvasRect();
    return {
      x: clamp((event.clientX - rect.left) / Math.max(1, rect.width) * VIEWBOX_SIZE, 0, VIEWBOX_SIZE),
      y: clamp((event.clientY - rect.top) / Math.max(1, rect.height) * VIEWBOX_SIZE, 0, VIEWBOX_SIZE),
      pressure: event.pointerType === 'pen' && event.pressure > 0 ? event.pressure : 0.5,
      time: Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now()
    };
  }

  _appendPointerSamples(event) {
    if (!this.activeStroke) return;
    let coalesced = [];
    try { coalesced = event.getCoalescedEvents?.() || []; } catch {}
    // Always include the dispatch endpoint. Some implementations return an
    // empty/stale coalesced list. Position/time filtering removes duplicates.
    const samples = coalesced.length ? [...coalesced, event] : [event];
    let added = false;
    for (const item of samples) {
      if (!Number.isFinite(item.clientX) || !Number.isFinite(item.clientY)) continue;
      const point = this._eventPoint(item);
      const previous = this.activeStroke[this.activeStroke.length - 1];
      if (previous && point.time < previous.time) continue;
      // 0.22 viewBox units is roughly one CSS pixel on the supported phone/iPad
      // layouts. It removes duplicate touch samples without changing scoring data.
      const deltaX = previous ? previous.x - point.x : 0;
      const deltaY = previous ? previous.y - point.y : 0;
      if (previous && deltaX * deltaX + deltaY * deltaY < 0.0484) continue;
      this.activeStroke.push(point);
      added = true;
    }
    // Draw one incremental batch per delivered input event. An additional rAF
    // wait makes ink depend on the page's animation cadence, particularly when
    // that cadence is throttled. No full repaint, DOM writes or storage here.
    if (added) this._flushActiveStrokeSegments();
  }

  _lineWidth(before, current) {
    const raw = 2.6 + clamp((before.pressure + current.pressure) / 2, 0.15, 1) * 2.1;
    // Quarter-unit buckets retain visible Pencil pressure while avoiding a new
    // Canvas stroke call for every tiny pressure fluctuation.
    return Math.round(raw * 4) / 4;
  }

  _drawStrokeRange(context, points, startIndex = 1) {
    if (!points || startIndex >= points.length) return;
    context.beginPath();
    context.moveTo(points[startIndex - 1].x, points[startIndex - 1].y);
    let widthTotal = 0;
    for (let index = startIndex; index < points.length; index++) {
      widthTotal += this._lineWidth(points[index - 1], points[index]);
      context.lineTo(points[index].x, points[index].y);
    }
    // One Canvas stroke per input batch avoids dozens of GPU state flushes on
    // iOS while retaining the batch's average Pencil pressure.
    context.lineWidth = widthTotal / Math.max(1, points.length - startIndex);
    context.stroke();
  }

  _flushActiveStrokeSegments() {
    const stroke = this.activeStroke;
    const startIndex = Math.max(1, this.drawnPointIndex + 1);
    if (!stroke || startIndex >= stroke.length || !this.context || !this.canvas.width || !this.canvas.height) return;
    const startedAt = this.diagnostics ? performance.now() : 0;
    const context = this.context;
    context.save();
    context.setTransform(this.canvas.width / VIEWBOX_SIZE, 0, 0, this.canvas.height / VIEWBOX_SIZE, 0, 0);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#102a43';
    this._drawStrokeRange(context, stroke, startIndex);
    context.restore();
    this.drawnPointIndex = stroke.length - 1;
    if (this.diagnostics) {
      this.metrics.frames += 1;
      const duration = performance.now() - startedAt;
      this.metrics.maxDrawMs = Math.max(this.metrics.maxDrawMs, duration);
      this._trackTiming('draw', duration);
      this.metrics.maxSampleAgeMs = Math.max(this.metrics.maxSampleAgeMs, Math.max(0, startedAt - stroke.at(-1).time));
    }
  }

  _scheduleResize() {
    if (this.resizeFrame !== null || this.destroyed) return;
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = null;
      if (this.pointerId !== null) {
        this.resizePending = true;
        return;
      }
      this.resizePending = false;
      this.resize();
    });
  }

  resize() {
    if (this.destroyed) return;
    if (this.pointerId !== null) { this.resizePending = true; return; }
    const rect = this._refreshCanvasRect();
    if (!rect.width || !rect.height) return;
    // A 3x full-size square canvas is expensive on iPhone and brings no useful
    // handwriting detail. 2x remains sharp on Retina and keeps iPad under 1280px.
    const edgeLimitRatio = 1280 / Math.max(rect.width, rect.height);
    const ratio = clamp(Math.min(window.devicePixelRatio || 1, 2, edgeLimitRatio), 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (this.canvas.width === width && this.canvas.height === height) {
      if (this.fullRenderPending) this._render();
      return;
    }
    this.pixelRatio = ratio;
    if (this.diagnostics) this.metrics.resizes += 1;
    this.canvas.width = width;
    this.canvas.height = height;
    this._render();
  }

  setKana(kana) {
    this._interrupt();
    this.stopAnimation();
    this.animationStroke = -1;
    this.kana = kana || null;
    this.guidePaths = (this.kana?.strokes || []).map(pathData => {
      try { return new Path2D(pathData); } catch { return null; }
    });
    this.clear();
  }

  setMode(mode) {
    this.mode = ['trace', 'copy', 'recall'].includes(mode) ? mode : 'trace';
    this.reveal = false;
    if (this.kana) this._render();
  }

  clear() {
    this._interrupt();
    this.stopAnimation();
    this.animationStroke = -1;
    this.strokes = [];
    this.activeStroke = null;
    this.pointerId = null;
    this.reveal = false;
    this._render();
    this.options.onChange?.(0);
  }

  undo() {
    this._interrupt();
    if (!this.strokes.length) return;
    this.strokes.pop();
    this.reveal = false;
    this._render();
    this.options.onChange?.(this.strokes.length);
  }

  revealGuide() {
    this.reveal = true;
    this._render();
  }

  animateGuide() {
    if (!this.kana?.strokes?.length || this.pointerId !== null) return;
    this.stopAnimation();
    this.animationStroke = 0;
    this._render();
    this.animationTimer = setInterval(() => {
      this.animationStroke += 1;
      if (this.animationStroke >= this.kana.strokes.length) {
        this.stopAnimation();
        this.animationStroke = -1;
      }
      this._render();
    }, 720);
  }

  stopAnimation() {
    if (this.animationTimer) clearInterval(this.animationTimer);
    this.animationTimer = null;
  }

  _render() {
    if (this.pointerId !== null) { this.fullRenderPending = true; return; }
    this.fullRenderPending = false;
    const context = this.context;
    if (!context || !this.canvas.width || !this.canvas.height) return;
    const sx = this.canvas.width / VIEWBOX_SIZE;
    const sy = this.canvas.height / VIEWBOX_SIZE;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    context.scale(sx, sy);

    context.lineWidth = 0.55;
    context.strokeStyle = '#c9d8ef';
    context.setLineDash([2.5, 2.5]);
    context.beginPath();
    context.moveTo(VIEWBOX_SIZE / 2, 4); context.lineTo(VIEWBOX_SIZE / 2, VIEWBOX_SIZE - 4);
    context.moveTo(4, VIEWBOX_SIZE / 2); context.lineTo(VIEWBOX_SIZE - 4, VIEWBOX_SIZE / 2);
    context.stroke();
    context.setLineDash([]);
    context.lineWidth = 0.9;
    context.strokeStyle = '#a9c3e8';
    context.strokeRect(1.5, 1.5, VIEWBOX_SIZE - 3, VIEWBOX_SIZE - 3);

    const shouldShowGuide = this.mode === 'trace' || this.reveal || this.animationStroke >= 0;
    if (shouldShowGuide && this.kana?.strokes) {
      this.kana.strokes.forEach((pathData, index) => {
        context.save();
        context.strokeStyle = this.animationStroke === index ? '#0d47a1' : '#89aee2';
        context.globalAlpha = this.animationStroke === index ? 0.95 : this.mode === 'trace' ? 0.38 : 0.22;
        context.lineWidth = this.animationStroke === index ? 4.1 : 3.2;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        const guidePath = this.guidePaths[index];
        if (guidePath) context.stroke(guidePath);
        context.restore();
        const start = this.kana.starts?.[index];
        if (start && (this.reveal || this.mode === 'trace' || this.animationStroke === index)) {
          context.save();
          context.globalAlpha = this.animationStroke === index ? 1 : 0.65;
          context.fillStyle = '#0d47a1';
          context.beginPath(); context.arc(start.x, start.y, 3.8, 0, Math.PI * 2); context.fill();
          context.fillStyle = '#ffffff';
          context.font = '700 4.7px sans-serif';
          context.textAlign = 'center'; context.textBaseline = 'middle';
          context.fillText(String(index + 1), start.x, start.y + 0.2);
          context.restore();
        }
      });
    }

    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#102a43';
    for (const stroke of this.strokes) {
      if (stroke.length < 2) continue;
      this._drawStrokeRange(context, stroke, 1);
    }
    context.restore();
    this.drawnPointIndex = this.activeStroke ? Math.max(0, this.activeStroke.length - 1) : 0;
  }

  score() {
    const scoreStartedAt = this.diagnostics ? performance.now() : 0;
    this._interrupt();
    this.stopAnimation();
    this.animationStroke = -1;
    const paths = this.kana?.strokes || [];
    const key = JSON.stringify(paths);
    let reference = referenceCache.get(key);
    if (!reference) {
      reference = paths.map(path => sampleSvgPath(path));
      if (reference.every(points => points.length)) {
        if (referenceCache.size >= 128) referenceCache.delete(referenceCache.keys().next().value);
        referenceCache.set(key, reference);
      }
    }
    const user = this.strokes.filter(stroke => stroke.length >= 2).map(stroke => resample(stroke));
    const expectedStrokeCount = reference.length;
    const strokeCount = user.length;
    if (!expectedStrokeCount || !strokeCount) {
      if (this.diagnostics) this.metrics.lastScoreMs = performance.now() - scoreStartedAt;
      return { score: 0, strokeCount, expectedStrokeCount, shape: 0, strokeCountScore: 0, order: 0, direction: 0, endpoints: 0, balance: 0 };
    }

    const matched = Math.min(reference.length, user.length);
    const pathDistances = [];
    const directionDistances = [];
    const endpointDistances = [];
    for (let index = 0; index < matched; index++) {
      pathDistances.push(symmetricPathDistance(user[index], reference[index]));
      const aligned = distance(user[index][0], reference[index][0]) + distance(user[index].at(-1), reference[index].at(-1));
      const reversed = distance(user[index][0], reference[index].at(-1)) + distance(user[index].at(-1), reference[index][0]);
      directionDistances.push(aligned <= reversed ? aligned / 2 : 54.5);
      endpointDistances.push(aligned / 2);
    }

    const shape = Math.round(40 * clamp(1 - mean(pathDistances) / 24, 0, 1));
    const order = Math.round(25 * clamp(1 - Math.abs(strokeCount - expectedStrokeCount) / Math.max(2, expectedStrokeCount), 0, 1));
    const direction = Math.round(15 * clamp(1 - mean(directionDistances) / 34, 0, 1));
    const endpoints = Math.round(10 * clamp(1 - mean(endpointDistances) / 34, 0, 1));
    const userBounds = bounds(user.flat());
    const refBounds = bounds(reference.flat());
    const boundsDifference = Math.abs(userBounds.x - refBounds.x) + Math.abs(userBounds.y - refBounds.y) +
      Math.abs(userBounds.width - refBounds.width) + Math.abs(userBounds.height - refBounds.height);
    const balance = Math.round(10 * clamp(1 - boundsDifference / 95, 0, 1));
    const score = clamp(shape + order + direction + endpoints + balance, 0, 100);
    this.reveal = true;
    this._render();
    if (this.diagnostics) {
      this.metrics.lastScoreMs = performance.now() - scoreStartedAt;
      this.options.onDiagnostic?.(this._diagnosticSnapshot());
    }
    // `order` remains a legacy API alias, not a claim of stroke-order recognition.
    return { score, strokeCount, expectedStrokeCount, shape, strokeCountScore: order, order, direction, endpoints, balance };
  }

  destroy() {
    this._interrupt();
    this.destroyed = true;
    this.stopAnimation();
    if (this.resizeFrame !== null) cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = null;
    this.resizeObserver?.disconnect();
    this.longTaskObserver?.disconnect();
    this.canvas.removeEventListener('pointerdown', this._pointerDown);
    this.canvas.removeEventListener('pointermove', this._pointerMove);
    this.canvas.removeEventListener('pointerup', this._pointerUp);
    this.canvas.removeEventListener('pointercancel', this._pointerCancel);
    this.canvas.removeEventListener('lostpointercapture', this._captureLost);
    globalThis.window?.removeEventListener?.('pointermove', this._windowMove);
    globalThis.window?.removeEventListener?.('pointerup', this._windowUp);
    globalThis.window?.removeEventListener?.('pointercancel', this._windowCancel);
    globalThis.window?.removeEventListener?.('blur', this._interrupt);
    globalThis.window?.removeEventListener?.('pagehide', this._interrupt);
    globalThis.document?.removeEventListener?.('visibilitychange', this._visibilityChange);
  }
}
