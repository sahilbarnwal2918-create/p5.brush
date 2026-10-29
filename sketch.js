/* Brush Studio — a touch-friendly drawing app built on p5.brush (p5 build, v3).
 *
 * Library API used (all documented in the p5.brush README):
 *   brush.load, brush.scaleBrushes, brush.box,
 *   brush.set, brush.stroke-state resets (noStroke / noFill / noHatch / noWash / noMass / noField),
 *   brush.line, brush.spline, brush.polygon,
 *   brush.fill, brush.fillBleed, brush.fillTexture, brush.wash,
 *   brush.hatch, brush.hatchStyle, and Polygon.hatch().
 * p5 functions used: createCanvas (WEBGL), pixelDensity, background, randomSeed, frameRate.
 *
 * How drawing works:
 *   - While your finger is down we show a thin guide line on a 2D overlay canvas.
 *   - When you lift, the gesture becomes an "op" that is rendered with p5.brush inside draw().
 *   - Every op stores its own random seed, so Undo can replay all remaining ops identically.
 */
'use strict';

/* ------------------------------------------------------------------ */
/* Settings you may want to tweak                                      */
/* ------------------------------------------------------------------ */
const W = 720;                 // logical canvas width  (portrait sheet)
const H = 960;                 // logical canvas height
const PAPER = '#f7f3ea';       // paper colour (also used by Clear)
const BRUSH_SCALE = 3;         // README: ~3 is a good start for a 600px canvas; adjust visually
const WEBGL_CENTER_ORIGIN = true; // p5's WEBGL origin is the canvas centre (see README Quick Start).
                                  // If your strokes appear shifted by half the canvas, set this to false.

const BRUSH_LABELS = {
  '2B': '2B pencil', 'HB': 'HB pencil', '2H': '2H pencil',
  'cpencil': 'Colored pencil', 'pen': 'Pen', 'rotring': 'Rotring',
  'spray': 'Spray', 'marker': 'Marker', 'marker2': 'Marker 2',
  'charcoal': 'Charcoal', 'hatch_brush': 'Clean hatch'
};

const PALETTE = ['#2f2a26', '#d7263d', '#f46036', '#f2b134', '#3a9d5d',
                 '#1b998b', '#2f45d0', '#6a4c93', '#c97b84', '#ffffff'];

const HINTS = {
  draw:  'Drag to draw. The brush texture appears when you lift your finger.',
  water: 'Draw a closed loop to fill it with watercolor.',
  hatch: 'Draw a loop to fill it with hatching lines.'
};

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
const S = {
  tool: 'draw',
  brush: 'HB',
  hatchBrush: 'hatch_brush',
  color: '#2f2a26',
  size: 1,
  opacity: 110,
  bleed: 0.3,
  texture: 0.6,
  flat: false,
  spacing: 10,
  angle: 45,
  rough: 0,
  cross: false,
  outline: true
};

const ops = [];          // committed drawing operations (for Undo)
const queue = [];        // jobs run one per frame inside draw()
let drawing = null;      // gesture in progress: { id, pts: [[x, y], ...] }
let saveRequested = false;
let previewQueued = false;

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let stage, wrap, preview, pctx, mainCanvas;

/* ------------------------------------------------------------------ */
/* p5 lifecycle                                                        */
/* ------------------------------------------------------------------ */
function setup() {
  stage   = $('#stage');
  wrap    = $('#stageWrap');
  preview = $('#preview');
  pctx    = preview.getContext('2d');

  // Cap pixel density so phones don't allocate a huge WEBGL buffer.
  pixelDensity(Math.min(window.devicePixelRatio || 1, 2));

  // README: the p5 build needs a WEBGL canvas.
  createCanvas(W, H, WEBGL);
  frameRate(30);

  // Move p5's canvas into our stage, underneath the preview overlay.
  mainCanvas = document.getElementById('defaultCanvas0') || $('canvas.p5Canvas');
  if (mainCanvas) stage.insertBefore(mainCanvas, preview);

  fitStage();
  window.addEventListener('resize', fitStage);
  window.addEventListener('orientationchange', fitStage);
  if (window.ResizeObserver) new ResizeObserver(fitStage).observe(wrap);

  if (typeof brush === 'undefined') {
    showBanner('p5.brush could not be loaded. Check your internet connection and the script ' +
               'URLs at the bottom of index.html, then reload.');
    noLoop();
    return;
  }

  try {
    brush.load();                       // target the main canvas (as in the README examples)
    brush.scaleBrushes(BRUSH_SCALE);    // README: built-in brushes need scaling
  } catch (err) {
    console.error(err);
    showBanner('p5.brush failed to initialise: ' + err.message);
  }

  background(PAPER);
  buildUI();
  wireCanvas();
}

function draw() {
  if (typeof brush === 'undefined') return;

  // One job per frame keeps the UI responsive and lets watercolor "dry" between ops.
  if (queue.length) {
    const job = queue.shift();
    try { job(); }
    catch (err) { console.error(err); toast('Drawing error: ' + err.message); }
    return;
  }

  // Export only on an idle frame, after the last brush job was fully flushed.
  if (saveRequested) {
    saveRequested = false;
    exportPNG();
  }
}

/* ------------------------------------------------------------------ */
/* Rendering an op with p5.brush                                       */
/* ------------------------------------------------------------------ */
function toBrushPoints(pts) {
  const ox = WEBGL_CENTER_ORIGIN ? W / 2 : 0;
  const oy = WEBGL_CENTER_ORIGIN ? H / 2 : 0;
  return pts.map(p => [p[0] - ox, p[1] - oy]);
}

function resetBrushState() {
  brush.noStroke();
  brush.noFill();
  brush.noHatch();
  brush.noWash();
  brush.noMass();
  brush.noField();
}

function runOp(op) {
  randomSeed(op.seed);          // README: also seeds p5.brush, so replays look identical
  resetBrushState();
  const P = toBrushPoints(op.pts);

  if (op.type === 'stroke') {
    brush.set(op.brush, op.color, op.size);      // activates stroke mode
    if (P.length === 1) {
      brush.line(P[0][0], P[0][1], P[0][0] + 2, P[0][1] + 1);   // a tap makes a small dot
    } else if (P.length === 2) {
      brush.line(P[0][0], P[0][1], P[1][0], P[1][1]);
    } else {
      brush.spline(P, 0.5);
    }
    return;
  }

  if (op.type === 'water') {
    brush.noStroke();
    if (op.flat) {
      brush.wash(op.color, op.opacity);
    } else {
      brush.fill(op.color, op.opacity);
      brush.fillBleed(op.bleed);
      brush.fillTexture(op.texture, 0.4);        // (textureStrength, borderIntensity)
    }
    brush.polygon(P);
    return;
  }

  if (op.type === 'hatch') {
    brush.noFill();
    if (op.outline) brush.set(op.brush, op.color, op.size);   // outline uses the same pen
    brush.hatchStyle(op.brush, op.color, op.size);
    const opts = { rand: op.rough > 0 ? op.rough : false, continuous: false, gradient: false };
    const rad = a => a * Math.PI / 180;          // p5 angleMode defaults to radians
    brush.hatch(op.spacing, rad(op.angle), opts);
    const poly = brush.polygon(P);               // returns a brush.Polygon
    if (op.cross && poly && typeof poly.hatch === 'function') {
      poly.hatch(op.spacing, rad(op.angle + 90), opts);       // second pass, perpendicular
    }
  }
}

function commit(op) {
  op.seed = Math.floor(Math.random() * 1e9);
  ops.push(op);
  queue.push(() => runOp(op));
  syncButtons();
}

function blank() { background(PAPER); }

function undo() {
  if (!ops.length) return;
  ops.pop();
  queue.length = 0;
  queue.push(blank);
  ops.forEach(op => queue.push(() => runOp(op)));
  syncButtons();
}

function clearAll() {
  if (!ops.length) return;
  if (!window.confirm('Clear the whole drawing?')) return;
  ops.length = 0;
  queue.length = 0;
  queue.push(blank);
  syncButtons();
}

/* ------------------------------------------------------------------ */
/* Save as PNG                                                         */
/* ------------------------------------------------------------------ */
function exportPNG() {
  if (!mainCanvas) { toast('Nothing to save yet.'); return; }
  mainCanvas.toBlob(blob => {
    if (!blob) { toast('Could not export the image.'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'brush-studio-' + Date.now() + '.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Saved. Check your Downloads.');
  }, 'image/png');
}

/* ------------------------------------------------------------------ */
/* Pointer input (touch, pen and mouse)                                */
/* ------------------------------------------------------------------ */
function toLogical(e) {
  const r = stage.getBoundingClientRect();
  return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)];
}

function wireCanvas() {
  stage.addEventListener('contextmenu', e => e.preventDefault());

  stage.addEventListener('pointerdown', e => {
    if (!e.isPrimary || drawing) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* not critical */ }
    drawing = { id: e.pointerId, pts: [toLogical(e)] };
    schedulePreview();
  });

  stage.addEventListener('pointermove', e => {
    if (!drawing || e.pointerId !== drawing.id) return;
    e.preventDefault();
    const events = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    (events.length ? events : [e]).forEach(ev => {
      const p = toLogical(ev);
      const last = drawing.pts[drawing.pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 2) drawing.pts.push(p);
    });
    schedulePreview();
  });

  const end = e => {
    if (!drawing || e.pointerId !== drawing.id) return;
    e.preventDefault();
    finishGesture(e.type === 'pointercancel');
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

function schedulePreview() {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(() => { previewQueued = false; renderPreview(); });
}

function renderPreview() {
  pctx.clearRect(0, 0, W, H);
  if (!drawing || !drawing.pts.length) return;
  const pts = drawing.pts;

  pctx.lineJoin = 'round';
  pctx.lineCap = 'round';
  pctx.beginPath();
  pts.forEach((p, i) => (i ? pctx.lineTo(p[0], p[1]) : pctx.moveTo(p[0], p[1])));

  if (S.tool === 'draw') {
    pctx.globalAlpha = 0.5;
    pctx.strokeStyle = S.color;
    pctx.lineWidth = Math.max(2, S.size * 3);
    pctx.stroke();
  } else {
    pctx.closePath();
    pctx.globalAlpha = 0.16;
    pctx.fillStyle = S.color;
    pctx.fill();
    pctx.globalAlpha = 0.9;
    pctx.strokeStyle = S.color;
    pctx.lineWidth = 2.5;
    pctx.setLineDash([10, 8]);
    pctx.stroke();
    pctx.setLineDash([]);
  }
  pctx.globalAlpha = 1;
}

/* Thin out a raw gesture: keep points at least minDist apart, cap the total. */
function simplify(pts, minDist, maxN) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const q = out[out.length - 1];
    if (Math.hypot(pts[i][0] - q[0], pts[i][1] - q[1]) >= minDist) out.push(pts[i]);
  }
  if (out.length > maxN) {
    const r = [];
    for (let i = 0; i < maxN; i++) r.push(out[Math.round(i * (out.length - 1) / (maxN - 1))]);
    return r;
  }
  return out;
}

function finishGesture(cancelled) {
  const g = drawing;
  drawing = null;
  pctx.clearRect(0, 0, W, H);
  if (!g || cancelled || typeof brush === 'undefined') return;

  if (S.tool === 'draw') {
    commit({
      type: 'stroke',
      pts: simplify(g.pts, 8, 90),
      brush: S.brush, color: S.color, size: S.size
    });
    return;
  }

  const pts = simplify(g.pts, 14, 40);
  if (pts.length < 3) { toast('Draw a larger loop to fill an area.'); return; }

  if (S.tool === 'water') {
    commit({
      type: 'water', pts,
      color: S.color, opacity: S.opacity, bleed: S.bleed, texture: S.texture, flat: S.flat
    });
  } else {
    commit({
      type: 'hatch', pts,
      brush: S.hatchBrush, color: S.color, size: S.size,
      spacing: S.spacing, angle: S.angle, rough: S.rough, cross: S.cross, outline: S.outline
    });
  }
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */
function buildUI() {
  // Brush names come from the library itself (README: brush.box()).
  let available = [];
  try { available = brush.box(); } catch (_) { /* fall back below */ }
  if (!available || !available.length) {
    available = ['2B', 'HB', '2H', 'cpencil', 'pen', 'rotring', 'spray', 'marker', 'marker2', 'charcoal', 'hatch_brush'];
  }

  const drawNames = available.filter(n => n !== 'hatch_brush');
  const preferredHatch = ['hatch_brush', 'rotring', 'pen', 'HB', '2B', 'charcoal'];
  const hatchNames = preferredHatch.filter(n => available.includes(n));

  if (!drawNames.includes(S.brush)) S.brush = drawNames[0];
  if (!hatchNames.includes(S.hatchBrush)) S.hatchBrush = hatchNames[0] || drawNames[0];

  buildChips($('#brushChips'), drawNames, 'brush');
  buildChips($('#hatchChips'), hatchNames.length ? hatchNames : drawNames, 'hatchBrush');

  // Palette
  const picker = $('#colorPicker');
  const sw = $('#swatches');
  PALETTE.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = c;
    b.dataset.value = c;
    b.setAttribute('aria-label', 'Colour ' + c);
    b.setAttribute('aria-pressed', String(c === S.color));
    b.addEventListener('click', () => setColor(c));
    sw.appendChild(b);
  });
  picker.addEventListener('input', () => setColor(picker.value));

  // Sliders and checkboxes bound to S via data-key
  $$('[data-key]').forEach(el => {
    const key = el.dataset.key;
    const out = el.closest('label') && $('output', el.closest('label'));
    if (el.type === 'checkbox') {
      el.checked = !!S[key];
      el.addEventListener('change', () => { S[key] = el.checked; });
    } else {
      el.value = S[key];
      if (out) out.textContent = el.value;
      el.addEventListener('input', () => {
        S[key] = parseFloat(el.value);
        if (out) out.textContent = el.value;
      });
    }
  });

  // Tool tabs
  $$('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  // Actions
  $('#undoBtn').addEventListener('click', undo);
  $('#clearBtn').addEventListener('click', clearAll);
  $('#saveBtn').addEventListener('click', () => { saveRequested = true; });
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  });

  setTool(S.tool);
  syncButtons();
}

function buildChips(container, names, key) {
  container.innerHTML = '';
  names.forEach(name => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = BRUSH_LABELS[name] || name;
    b.dataset.value = name;
    b.setAttribute('aria-pressed', String(S[key] === name));
    b.addEventListener('click', () => {
      S[key] = name;
      $$('.chip', container).forEach(c => c.setAttribute('aria-pressed', String(c.dataset.value === name)));
    });
    container.appendChild(b);
  });
}

function setColor(c) {
  S.color = c;
  $('#colorPicker').value = c;
  $$('.swatch').forEach(s => s.setAttribute('aria-pressed', String(s.dataset.value === c)));
}

function setTool(tool) {
  S.tool = tool;
  $$('[data-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
  $$('[data-tools]').forEach(el => { el.hidden = !el.dataset.tools.split(' ').includes(tool); });
  $('#hint').textContent = HINTS[tool];
}

function syncButtons() {
  $('#undoBtn').disabled = ops.length === 0;
}

function fitStage() {
  if (!wrap || !stage) return;
  const pad = 12;
  const aw = Math.max(wrap.clientWidth - pad * 2, 50);
  const ah = Math.max(wrap.clientHeight - pad * 2, 50);
  const k = Math.min(aw / W, ah / H);
  stage.style.width = Math.floor(W * k) + 'px';
  stage.style.height = Math.floor(H * k) + 'px';
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function showBanner(msg) {
  const b = $('#banner');
  b.textContent = msg;
  b.hidden = false;
    }
