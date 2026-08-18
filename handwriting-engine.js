const VIEWBOX_SIZE = 109;
const SVG_NS = 'http://www.w3.org/2000/svg';

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
    this.kana = null;
    this.mode = 'trace';
    this.strokes = [];
    this.activeStroke = null;
    this.pointerId = null;
    this.penRecentlyActiveUntil = 0;
    this.reveal = false;
    this.animationStroke = -1;
    this.animationTimer = null;
    this.destroyed = false;
    this._bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  _bindEvents() {
    this._pointerDown = event => {
      if (this.destroyed || !this.kana) return;
      if (event.pointerType === 'touch' && Date.now() < this.penRecentlyActiveUntil) return;
      if (this.pointerId !== null) return;
      if (event.pointerType === 'pen') this.penRecentlyActiveUntil = Date.now() + 900;
      event.preventDefault();
      this.pointerId = event.pointerId;
      this.canvas.setPointerCapture?.(event.pointerId);
      const point = this._eventPoint(event);
      this.activeStroke = [point];
      this.strokes.push(this.activeStroke);
      this._render();
      this.options.onStrokeStart?.(this.strokes.length);
    };
    this._pointerMove = event => {
      if (event.pointerId !== this.pointerId || !this.activeStroke) return;
      event.preventDefault();
      const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
      for (const item of events) {
        const point = this._eventPoint(item);
        const previous = this.activeStroke.at(-1);
        if (!previous || distance(previous, point) >= 0.22) this.activeStroke.push(point);
      }
      this._render();
    };
    this._pointerUp = event => {
      if (event.pointerId !== this.pointerId) return;
      event.preventDefault();
      this.canvas.releasePointerCapture?.(event.pointerId);
      if (this.activeStroke?.length === 1) {
        const point = this.activeStroke[0];
        this.activeStroke.push({ ...point, x: point.x + 0.15, y: point.y + 0.15 });
      }
      this.activeStroke = null;
      this.pointerId = null;
      this.options.onStrokeEnd?.(this.strokes.length);
      this._render();
    };
    this.canvas.addEventListener('pointerdown', this._pointerDown, { passive: false });
    this.canvas.addEventListener('pointermove', this._pointerMove, { passive: false });
    this.canvas.addEventListener('pointerup', this._pointerUp, { passive: false });
    this.canvas.addEventListener('pointercancel', this._pointerUp, { passive: false });
  }

  _eventPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / Math.max(1, rect.width) * VIEWBOX_SIZE, 0, VIEWBOX_SIZE),
      y: clamp((event.clientY - rect.top) / Math.max(1, rect.height) * VIEWBOX_SIZE, 0, VIEWBOX_SIZE),
      pressure: event.pointerType === 'pen' && event.pressure > 0 ? event.pressure : 0.5,
      time: performance.now()
    };
  }

  resize() {
    if (this.destroyed) return;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = clamp(window.devicePixelRatio || 1, 1, 3);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this._render();
  }

  setKana(kana) {
    this.stopAnimation();
    this.kana = kana || null;
    this.clear();
  }

  setMode(mode) {
    this.mode = ['trace', 'copy', 'recall'].includes(mode) ? mode : 'trace';
    this.reveal = false;
    this._render();
  }

  clear() {
    this.strokes = [];
    this.activeStroke = null;
    this.pointerId = null;
    this.reveal = false;
    this._render();
    this.options.onChange?.(0);
  }

  undo() {
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
    if (!this.kana?.strokes?.length) return;
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
        context.stroke(new Path2D(pathData));
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
      for (let index = 1; index < stroke.length; index++) {
        const before = stroke[index - 1]; const current = stroke[index];
        context.beginPath();
        context.lineWidth = 2.6 + clamp((before.pressure + current.pressure) / 2, 0.15, 1) * 2.1;
        context.moveTo(before.x, before.y); context.lineTo(current.x, current.y); context.stroke();
      }
    }
    context.restore();
  }

  score() {
    const reference = (this.kana?.strokes || []).map(path => sampleSvgPath(path));
    const user = this.strokes.filter(stroke => stroke.length >= 2).map(stroke => resample(stroke));
    const expectedStrokeCount = reference.length;
    const strokeCount = user.length;
    if (!expectedStrokeCount || !strokeCount) {
      return { score: 0, strokeCount, expectedStrokeCount, shape: 0, order: 0, direction: 0, endpoints: 0, balance: 0 };
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
    return { score, strokeCount, expectedStrokeCount, shape, order, direction, endpoints, balance };
  }

  destroy() {
    this.destroyed = true;
    this.stopAnimation();
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('pointerdown', this._pointerDown);
    this.canvas.removeEventListener('pointermove', this._pointerMove);
    this.canvas.removeEventListener('pointerup', this._pointerUp);
    this.canvas.removeEventListener('pointercancel', this._pointerUp);
  }
}

