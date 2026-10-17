'use strict';
// Graphite WP0 performance spike: throwaway. 2D canvas, grid spatial index, semantic zoom LOD.
const TYPES = [
  { name: 'document', color: '#4f8cff', glyph: 'D', shape: 'rect' },
  { name: 'task',     color: '#34c759', glyph: 'T', shape: 'circle' },
  { name: 'note',     color: '#ffcc00', glyph: 'N', shape: 'rect' },
  { name: 'image',    color: '#ff6b6b', glyph: 'I', shape: 'diamond' },
  { name: 'link',     color: '#a78bfa', glyph: 'L', shape: 'circle' },
  { name: 'board',    color: '#2dd4bf', glyph: 'B', shape: 'diamond' },
];
const COUNTS = [1000, 5000, 10000];
const CELL = 320;                       // layout cell; one node per cell => no overlap
const ORIGIN_X = 1e9, ORIGIN_Y = -5e8;  // far-from-zero float64 coords
const MAX_ZOOM = 3;
const LOD1 = 0.12, LOD2 = 0.5;          // zoom thresholds: shapes -> icons -> titles
const WORDS = 'graph idea note plan draft research meeting sketch design journal recipe travel budget reading project music photo goal habit todo'.split(' ');

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

function makeGraph(n) {
  const r = rng(n * 7 + 1);
  const cols = Math.ceil(Math.sqrt(n * 1.6)), rows = Math.ceil((n * 1.6) / cols), total = cols * rows;
  const cells = new Int32Array(total); for (let i = 0; i < total; i++) cells[i] = i;
  for (let i = total - 1; i > 0; i--) { const j = (r() * (i + 1)) | 0; const t = cells[i]; cells[i] = cells[j]; cells[j] = t; }
  const x = new Float64Array(n), y = new Float64Array(n), w = new Float32Array(n), h = new Float32Array(n);
  const type = new Uint8Array(n), title = new Array(n), cellOf = new Int32Array(total).fill(-1), cellIdx = new Int32Array(n);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const c = cells[i], cx = c % cols, cy = (c / cols) | 0;
    w[i] = 70 + r() * 170; h[i] = 40 + r() * 90;
    x[i] = ORIGIN_X + cx * CELL + 20 + r() * (CELL - 40 - w[i]);
    y[i] = ORIGIN_Y + cy * CELL + 20 + r() * (CELL - 40 - h[i]);
    type[i] = (r() * TYPES.length) | 0;
    title[i] = WORDS[(r() * WORDS.length) | 0] + ' ' + WORDS[(r() * WORDS.length) | 0] + ' #' + i;
    cellOf[c] = i; cellIdx[i] = c;
    minX = Math.min(minX, x[i]); minY = Math.min(minY, y[i]); maxX = Math.max(maxX, x[i] + w[i]); maxY = Math.max(maxY, y[i] + h[i]);
  }
  // ~1.5 edges per node, to nearby nodes
  const es = [], ed = [];
  for (let i = 0; i < n; i++) {
    const k = r() < 0.5 ? 1 : 2, c = cellIdx[i], cx = c % cols, cy = (c / cols) | 0;
    for (let a = 0, tries = 0; a < k && tries < 12; tries++) {
      const nx = cx + ((r() * 7) | 0) - 3, ny = cy + ((r() * 7) | 0) - 3;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const j = cellOf[ny * cols + nx]; if (j < 0 || j === i) continue;
      es.push(i); ed.push(j); a++;
    }
  }
  const E = es.length, src = Int32Array.from(es), dst = Int32Array.from(ed);
  // incident-edge CSR adjacency
  const deg = new Int32Array(n + 1);
  for (let e = 0; e < E; e++) { deg[src[e] + 1]++; deg[dst[e] + 1]++; }
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const adj = new Int32Array(E * 2), fill = deg.slice(0, n);
  for (let e = 0; e < E; e++) { adj[fill[src[e]]++] = e; adj[fill[dst[e]]++] = e; }
  const g = { n, x, y, w, h, type, title, E, src, dst, adjStart: deg, adj, minX, minY, maxX, maxY,
    visStamp: new Uint32Array(n), edgeStamp: new Uint32Array(E), vis: new Int32Array(n) };
  buildIndex(g);
  return g;
}

// Uniform-grid spatial index (CSR). Nodes bucketed by min corner; queries expand by max node size.
const BUCKET = 1024;
function buildIndex(g) {
  const bw = Math.ceil((g.maxX - g.minX) / BUCKET) + 1, bh = Math.ceil((g.maxY - g.minY) / BUCKET) + 1;
  const start = new Int32Array(bw * bh + 1), b = new Int32Array(g.n);
  let maxW = 0, maxH = 0;
  for (let i = 0; i < g.n; i++) {
    b[i] = (((g.y[i] - g.minY) / BUCKET) | 0) * bw + (((g.x[i] - g.minX) / BUCKET) | 0);
    start[b[i] + 1]++; maxW = Math.max(maxW, g.w[i]); maxH = Math.max(maxH, g.h[i]);
  }
  for (let i = 0; i < bw * bh; i++) start[i + 1] += start[i];
  const items = new Int32Array(g.n), f = start.slice(0, bw * bh);
  for (let i = 0; i < g.n; i++) items[f[b[i]]++] = i;
  g.idx = { bw, bh, start, items, maxW, maxH };
}
function query(g, x0, y0, x1, y1, stamp) {
  const { bw, bh, start, items, maxW, maxH } = g.idx;
  const bx0 = Math.max(0, Math.floor((x0 - maxW - g.minX) / BUCKET)), by0 = Math.max(0, Math.floor((y0 - maxH - g.minY) / BUCKET));
  const bx1 = Math.min(bw - 1, Math.floor((x1 - g.minX) / BUCKET)), by1 = Math.min(bh - 1, Math.floor((y1 - g.minY) / BUCKET));
  let k = 0; const vis = g.vis, X = g.x, Y = g.y, W = g.w, H = g.h;
  for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
    const c = by * bw + bx;
    for (let p = start[c], e = start[c + 1]; p < e; p++) {
      const i = items[p];
      if (X[i] <= x1 && X[i] + W[i] >= x0 && Y[i] <= y1 && Y[i] + H[i] >= y0) { vis[k++] = i; g.visStamp[i] = stamp; }
    }
  }
  return k;
}

// ---------- canvas + camera ----------
const canvas = document.getElementById('c'), ctx = canvas.getContext('2d', { alpha: false });
let dpr = 1, vw = 1, vh = 1;
const cam = { x: 0, y: 0, z: 1 };
let G = null, frameNo = 0, visibleCount = 0, lodLevel = 0;

function margin() { return Math.max(400, 0.05 * Math.max(G.maxX - G.minX, G.maxY - G.minY)); }
function minZoom() { const m = margin(); return Math.min(vw / (G.maxX - G.minX + 2 * m), vh / (G.maxY - G.minY + 2 * m)); }
function clampCam() {
  cam.z = Math.min(MAX_ZOOM, Math.max(minZoom(), cam.z));
  const m = margin();
  cam.x = Math.min(G.maxX + m, Math.max(G.minX - m, cam.x));
  cam.y = Math.min(G.maxY + m, Math.max(G.minY - m, cam.y));
}
function fitAll() { cam.x = (G.minX + G.maxX) / 2; cam.y = (G.minY + G.maxY) / 2; cam.z = minZoom(); }
function zoomAt(sx, sy, factor) {
  const wx = cam.x + (sx - vw / 2) / cam.z, wy = cam.y + (sy - vh / 2) / cam.z;
  cam.z = Math.min(MAX_ZOOM, Math.max(minZoom(), cam.z * factor));
  cam.x = wx - (sx - vw / 2) / cam.z; cam.y = wy - (sy - vh / 2) / cam.z; clampCam();
}
function resize() {
  dpr = window.devicePixelRatio || 1; vw = window.innerWidth; vh = window.innerHeight;
  canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr);
  if (G) clampCam();
}
window.addEventListener('resize', resize);

function shapePath(t, sx, sy, sw, shh) {
  const s = TYPES[t].shape;
  if (s === 'rect' || sw < 4) ctx.rect(sx, sy, sw, shh);
  else if (s === 'circle') { const rr = Math.min(sw, shh) / 2, cx = sx + sw / 2, cy = sy + shh / 2; ctx.moveTo(cx + rr, cy); ctx.arc(cx, cy, rr, 0, 6.2832); }
  else { const cx = sx + sw / 2, cy = sy + shh / 2; ctx.moveTo(cx, sy); ctx.lineTo(sx + sw, cy); ctx.lineTo(cx, sy + shh); ctx.lineTo(sx, cy); ctx.closePath(); }
}

function draw() {
  frameNo++;
  const g = G, z = cam.z, hw = vw / 2 / z, hh = vh / 2 / z;
  const x0 = cam.x - hw, y0 = cam.y - hh, x1 = cam.x + hw, y1 = cam.y + hh;
  const k = query(g, x0, y0, x1, y1, frameNo); visibleCount = k;
  lodLevel = z < LOD1 ? 0 : z < LOD2 ? 1 : 2;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0f1115'; ctx.fillRect(0, 0, vw, vh);
  // world->screen in float64 JS math (never hand huge coords to the canvas transform)
  const ox = vw / 2 - cam.x * z, oy = vh / 2 - cam.y * z;
  const X = g.x, Y = g.y, W = g.w, H = g.h, T = g.type, vis = g.vis;
  // edges incident to visible nodes, batched in one path
  ctx.beginPath();
  for (let a = 0; a < k; a++) {
    const i = vis[a];
    for (let p = g.adjStart[i], e1 = g.adjStart[i + 1]; p < e1; p++) {
      const e = g.adj[p]; if (g.edgeStamp[e] === frameNo) continue; g.edgeStamp[e] = frameNo;
      const s = g.src[e], d = g.dst[e];
      ctx.moveTo((X[s] + W[s] / 2) * z + ox, (Y[s] + H[s] / 2) * z + oy);
      ctx.lineTo((X[d] + W[d] / 2) * z + ox, (Y[d] + H[d] / 2) * z + oy);
    }
  }
  ctx.strokeStyle = lodLevel === 0 ? 'rgba(140,160,200,0.18)' : 'rgba(140,160,200,0.45)';
  ctx.lineWidth = lodLevel === 2 ? 1.5 : 1; ctx.stroke();
  // nodes: one batched path per type
  for (let t = 0; t < TYPES.length; t++) {
    ctx.beginPath();
    for (let a = 0; a < k; a++) {
      const i = vis[a]; if (T[i] !== t) continue;
      const sw = Math.max(1.5, W[i] * z), shh = Math.max(1.5, H[i] * z);
      if (lodLevel === 2) ctx.rect(X[i] * z + ox, Y[i] * z + oy, sw, shh);
      else shapePath(t, X[i] * z + ox, Y[i] * z + oy, sw, shh);
    }
    ctx.fillStyle = lodLevel === 2 ? TYPES[t].color + '33' : TYPES[t].color; ctx.fill();
    if (lodLevel === 2) { ctx.strokeStyle = TYPES[t].color; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
  if (lodLevel === 1) { // icons (type glyph)
    ctx.fillStyle = '#0f1115'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.round(Math.min(16, Math.max(8, 60 * z)))}px system-ui,sans-serif`;
    for (let a = 0; a < k; a++) { const i = vis[a]; ctx.fillText(TYPES[T[i]].glyph, (X[i] + W[i] / 2) * z + ox, (Y[i] + H[i] / 2) * z + oy); }
  } else if (lodLevel === 2) { // titles
    const fs = Math.round(Math.min(18, 14 * z + 4)); ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.font = `${fs}px system-ui,sans-serif`; ctx.fillStyle = '#e6e8ee';
    for (let a = 0; a < k; a++) {
      const i = vis[a], sx = X[i] * z + ox, sy = Y[i] * z + oy, sw = W[i] * z;
      ctx.fillText(TYPES[T[i]].glyph + '  ' + g.title[i], sx + 6, sy + 6, sw - 12);
    }
  }
}

// ---------- input: mouse wheel/drag + touch pinch/pan via pointer events ----------
const ptrs = new Map(); let pinch = null;
canvas.addEventListener('wheel', (e) => { e.preventDefault(); if (!bench) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015))); }, { passive: false });
canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); pinch = null; });
canvas.addEventListener('pointermove', (e) => {
  const p = ptrs.get(e.pointerId); if (!p || bench) { if (p) { p.x = e.clientX; p.y = e.clientY; } return; }
  if (ptrs.size === 1) { cam.x -= (e.clientX - p.x) / cam.z; cam.y -= (e.clientY - p.y) / cam.z; p.x = e.clientX; p.y = e.clientY; clampCam(); return; }
  p.x = e.clientX; p.y = e.clientY;
  const [a, b] = [...ptrs.values()], mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
  if (pinch) { cam.x -= (mx - pinch.mx) / cam.z; cam.y -= (my - pinch.my) / cam.z; zoomAt(mx, my, d / pinch.d); }
  pinch = { mx, my, d };
});
const up = (e) => { ptrs.delete(e.pointerId); pinch = null; };
canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);

// ---------- telemetry ----------
const RING = 240, ring = new Float64Array(RING), dring = new Float64Array(RING); let rn = 0;
function pct(arr, p) { if (!arr.length) return 0; const s = Float64Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
const statsEl = document.getElementById('stats'), progEl = document.getElementById('progress');
let lastHud = 0;
function hud(now) {
  if (now - lastHud < 250) return; lastHud = now;
  const m = Math.min(rn, RING), iv = ring.subarray(0, m), dv = dring.subarray(0, m);
  const p50 = pct(iv, 0.5), p95 = pct(iv, 0.95), p99 = pct(iv, 0.99);
  statsEl.innerHTML =
    `<div>FPS <b>${p50 ? (1000 / (iv.reduce((s, v) => s + v, 0) / m)).toFixed(0) : '-'}</b> · nodes ${G.n.toLocaleString()} · edges ${G.E.toLocaleString()}</div>` +
    `<div>frame p50/p95/p99: <b>${p50.toFixed(1)} / ${p95.toFixed(1)} / ${p99.toFixed(1)}</b> ms</div>` +
    `<div>draw p95/p99: ${pct(dv, 0.95).toFixed(1)} / ${pct(dv, 0.99).toFixed(1)} ms</div>` +
    `<div>visible ${visibleCount.toLocaleString()} · LOD ${['shapes', 'icons', 'titles'][lodLevel]} · zoom ${cam.z.toFixed(3)}</div>` +
    `<div>DPR ${dpr} · canvas ${canvas.width}×${canvas.height}</div>`;
}

// ---------- auto benchmark ----------
const BENCH_MS = 15000, WARM_MS = 500;
let bench = null; // { queue, i, t0, iv:[], dv:[], maxVis, results }
function benchCamera(t) { // scripted sweep, t in [0,1)
  const cx = (G.minX + G.maxX) / 2, cy = (G.minY + G.maxY) / 2, bwid = G.maxX - G.minX, bhgt = G.maxY - G.minY, zMin = minZoom();
  const lerp = (a, b, u) => a + (b - a) * u;
  if (t < 0.2) { const u = t / 0.2 * 6.283; cam.z = zMin * 1.05; cam.x = cx + Math.cos(u) * bwid * 0.03; cam.y = cy + Math.sin(u) * bhgt * 0.03; }
  else if (t < 0.6) { const u = (t - 0.2) / 0.4, tri = u < 0.5 ? u * 2 : 2 - u * 2; cam.z = zMin * Math.pow(1.5 / zMin, tri); cam.x = lerp(G.minX + bwid * 0.25, G.minX + bwid * 0.75, u); cam.y = lerp(G.minY + bhgt * 0.3, G.minY + bhgt * 0.7, u); }
  else if (t < 0.8) { const u = (t - 0.6) / 0.2; cam.z = 0.3; cam.x = lerp(G.minX, G.maxX, u); cam.y = lerp(G.minY + bhgt * 0.2, G.minY + bhgt * 0.8, u); }
  else { const u = (t - 0.8) / 0.2; cam.z = 1.2; cam.x = lerp(G.maxX, G.minX, u); cam.y = lerp(G.minY + bhgt * 0.4, G.minY + bhgt * 0.6, u); }
  clampCam();
}
function startBench() {
  document.getElementById('results').style.display = 'none';
  bench = { queue: COUNTS.slice(), results: [], cur: null };
  nextBench();
}
function nextBench() {
  const n = bench.queue.shift();
  if (n === undefined) return finishBench();
  load(n); bench.cur = { n, t0: performance.now(), iv: [], dv: [], maxVis: 0 };
}
function finishBench() {
  const res = bench.results; bench = null; progEl.textContent = '';
  const rows = res.map((r) => `<tr><td>${r.n.toLocaleString()}</td><td>${r.frames}</td><td>${r.fps.toFixed(0)}</td><td>${r.p50.toFixed(1)}</td><td>${r.p95.toFixed(1)}</td><td><b>${r.p99.toFixed(1)}</b></td><td>${r.d95.toFixed(1)}</td><td>${r.d99.toFixed(1)}</td><td>${r.maxVis.toLocaleString()}</td><td class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</td></tr>`).join('');
  document.getElementById('rtable').innerHTML = `<tr><th>Nodes</th><th>Frames</th><th>Avg FPS</th><th>p50 ms</th><th>p95 ms</th><th>p99 ms</th><th>Draw p95</th><th>Draw p99</th><th>Max visible</th><th>60fps floor</th></tr>` + rows;
  document.getElementById('rmeta').textContent = `${new Date().toLocaleString()} · DPR ${dpr} · viewport ${vw}×${vh} · ${navigator.userAgent}`;
  document.getElementById('results').style.display = 'flex';
  window.__benchResults = res; document.title = 'BENCH_DONE';
  setActive();
}
const PASS_MS = 16.7 + 1.0;
function benchTick(now, dt, drawMs) {
  const b = bench.cur, el = now - b.t0;
  if (el >= BENCH_MS) {
    const fps = b.iv.length / (b.iv.reduce((s, v) => s + v, 0) / 1000);
    const r = { n: b.n, frames: b.iv.length, fps, p50: pct(b.iv, 0.5), p95: pct(b.iv, 0.95), p99: pct(b.iv, 0.99), d95: pct(b.dv, 0.95), d99: pct(b.dv, 0.99), maxVis: b.maxVis };
    r.pass = r.p99 <= PASS_MS; bench.results.push(r); nextBench(); return;
  }
  if (el > WARM_MS) { b.iv.push(dt); b.dv.push(drawMs); b.maxVis = Math.max(b.maxVis, visibleCount); }
  progEl.textContent = `Benchmarking ${b.n.toLocaleString()} nodes… ${Math.ceil((BENCH_MS - el) / 1000)}s`;
  benchCamera(el / BENCH_MS);
}

// ---------- main loop ----------
let last = 0;
function loop(now) {
  const dt = last ? now - last : 16.7; last = now;
  if (bench && bench.cur) benchTick(now, dt, lastDraw);
  const t0 = performance.now(); draw(); lastDraw = performance.now() - t0;
  ring[rn % RING] = dt; dring[rn % RING] = lastDraw; rn++;
  hud(now);
  requestAnimationFrame(loop);
}
let lastDraw = 0;

function load(n) { G = makeGraph(n); fitAll(); rn = 0; last = 0; setActive(); }
const countsEl = document.getElementById('counts');
function setActive() {
  countsEl.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', +b.dataset.n === G.n); b.disabled = !!bench; });
  document.getElementById('bench').disabled = !!bench;
}
COUNTS.forEach((n) => { const b = document.createElement('button'); b.textContent = n / 1000 + 'k'; b.dataset.n = n; b.onclick = () => load(n); countsEl.appendChild(b); });
document.getElementById('bench').onclick = startBench;
document.getElementById('rclose').onclick = () => (document.getElementById('results').style.display = 'none');

resize(); load(+(new URLSearchParams(location.search).get('n')) || 10000);
requestAnimationFrame(loop);
if (new URLSearchParams(location.search).has('bench')) startBench();
