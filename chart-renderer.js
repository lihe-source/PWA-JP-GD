function cssVar(name, fallback) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  } catch {
    return fallback;
  }
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
  ctx.beginPath();
  ctx.roundRect?.(x, y, width, height, r);
  if (!ctx.roundRect) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
  }
  ctx.closePath();
}

function drawLegend(ctx, width, colors, textColor) {
  const items = [
    { label: '正確', color: colors.correct, type: 'box' },
    { label: '錯誤', color: colors.wrong, type: 'box' },
    { label: '正確率%', color: colors.accuracy, type: 'line' }
  ];
  ctx.save();
  ctx.font = '700 11px Nunito, sans-serif';
  ctx.textBaseline = 'middle';
  const total = items.reduce((sum, item) => sum + 26 + ctx.measureText(item.label).width, 0) + (items.length - 1) * 12;
  let x = Math.max(8, (width - total) / 2);
  for (const item of items) {
    if (item.type === 'line') {
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x, 12);
      ctx.lineTo(x + 16, 12);
      ctx.stroke();
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.arc(x + 8, 12, 3, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = item.color;
      roundedRect(ctx, x, 6, 13, 12, 3);
      ctx.fill();
    }
    x += 20;
    ctx.fillStyle = textColor;
    ctx.fillText(item.label, x, 12);
    x += ctx.measureText(item.label).width + 12;
  }
  ctx.restore();
}

function createTrendChart(canvas, { labels, correctData, wrongData, accuracyData }) {
  if (!(canvas instanceof HTMLCanvasElement)) return { destroy() {} };
  let resizeObserver = null;
  let resizeHandler = null;
  let destroyed = false;

  const draw = () => {
    if (destroyed || !canvas.isConnected) return;
    const parent = canvas.parentElement;
    const cssWidth = Math.max(280, parent?.clientWidth || canvas.clientWidth || 320);
    const cssHeight = Math.max(200, parent?.clientHeight || 220);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '答題趨勢圖：綠色為正確題數、紅色為錯誤題數、黃色折線為正確率');

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const colors = {
      correct: 'rgba(26,122,74,0.72)',
      wrong: 'rgba(229,57,53,0.72)',
      accuracy: '#f5a623',
      grid: 'rgba(107,128,112,0.16)',
      text: cssVar('--text-muted', '#6b8070'),
      strongText: cssVar('--text', '#1a2e22')
    };
    drawLegend(ctx, cssWidth, colors, colors.text);

    const pad = { left: 38, right: 42, top: 32, bottom: 42 };
    const plotW = Math.max(1, cssWidth - pad.left - pad.right);
    const plotH = Math.max(1, cssHeight - pad.top - pad.bottom);
    const totals = labels.map((_, i) => Number(correctData[i] || 0) + Number(wrongData[i] || 0));
    const maxCountRaw = Math.max(1, ...totals);
    const maxCount = maxCountRaw <= 5 ? 5 : Math.ceil(maxCountRaw / 5) * 5;

    ctx.save();
    ctx.font = '10px Nunito, sans-serif';
    ctx.fillStyle = colors.text;
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const ratio = i / 4;
      const y = pad.top + plotH - ratio * plotH;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
      ctx.fillText(String(Math.round(maxCount * ratio)), pad.left - 6, y);
      ctx.textAlign = 'left';
      ctx.fillText(`${Math.round(100 * ratio)}%`, pad.left + plotW + 6, y);
      ctx.textAlign = 'right';
    }
    ctx.restore();

    const count = Math.max(1, labels.length);
    const slot = plotW / count;
    const barW = Math.max(3, Math.min(16, slot * 0.58));
    for (let i = 0; i < labels.length; i++) {
      const correct = Number(correctData[i] || 0);
      const wrong = Number(wrongData[i] || 0);
      const x = pad.left + slot * i + slot / 2 - barW / 2;
      const correctH = (correct / maxCount) * plotH;
      const wrongH = (wrong / maxCount) * plotH;
      const baseY = pad.top + plotH;
      if (correctH > 0) {
        ctx.fillStyle = colors.correct;
        roundedRect(ctx, x, baseY - correctH, barW, correctH, 3);
        ctx.fill();
      }
      if (wrongH > 0) {
        ctx.fillStyle = colors.wrong;
        roundedRect(ctx, x, baseY - correctH - wrongH, barW, wrongH, 3);
        ctx.fill();
      }
    }

    ctx.save();
    ctx.strokeStyle = colors.accuracy;
    ctx.fillStyle = colors.accuracy;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    let hasPoint = false;
    ctx.beginPath();
    accuracyData.forEach((value, i) => {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return;
      const x = pad.left + slot * i + slot / 2;
      const y = pad.top + plotH - (Math.max(0, Math.min(100, Number(value))) / 100) * plotH;
      if (!hasPoint) { ctx.moveTo(x, y); hasPoint = true; }
      else ctx.lineTo(x, y);
    });
    if (hasPoint) ctx.stroke();
    accuracyData.forEach((value, i) => {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return;
      const x = pad.left + slot * i + slot / 2;
      const y = pad.top + plotH - (Math.max(0, Math.min(100, Number(value))) / 100) * plotH;
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();

    ctx.save();
    ctx.fillStyle = colors.text;
    ctx.font = '10px Nunito, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const labelStep = labels.length > 21 ? 4 : labels.length > 14 ? 2 : 1;
    labels.forEach((label, i) => {
      if (i % labelStep !== 0 && i !== labels.length - 1) return;
      const x = pad.left + slot * i + slot / 2;
      ctx.save();
      ctx.translate(x, pad.top + plotH + 8);
      if (labels.length > 14) ctx.rotate(-Math.PI / 5);
      ctx.fillText(String(label), 0, 0);
      ctx.restore();
    });
    ctx.restore();
  };

  if ('ResizeObserver' in window) {
    resizeObserver = new ResizeObserver(() => requestAnimationFrame(draw));
    if (canvas.parentElement) resizeObserver.observe(canvas.parentElement);
  } else {
    resizeHandler = () => requestAnimationFrame(draw);
    window.addEventListener('resize', resizeHandler, { passive: true });
  }
  requestAnimationFrame(draw);

  return {
    destroy() {
      destroyed = true;
      resizeObserver?.disconnect();
      if (resizeHandler) window.removeEventListener('resize', resizeHandler);
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  };
}

export const TrendChart = { create: createTrendChart };
