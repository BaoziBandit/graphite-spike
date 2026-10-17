'use strict';
const Q = new URLSearchParams(location.search);
const RENDERER = Q.get('renderer') === 'v1' ? 'v1' : 'v2';
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
  g.label = title.map((t, i) => TYPES[type[i]].glyph + '  ' + t);
  buildIndex(g);
  if (RENDERER === 'v2') buildV2(g);
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

function drawV1() {
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


// ================= Renderer v2: cached vector geometry (Path2D) per spatial tile =================
// Geometry is built once per fixture in tile-local coordinates (float64 world -> small local
// offsets, so no precision loss), then re-rasterized as vectors every frame through the canvas
// transform. Nothing is cached as a bitmap: every frame is a full-resolution vector draw.
const TILE = 4096, CLUSTER = 1280;
const Z_CLUSTER = 0.02;  // below this, average node < ~2-3 CSS px: aggregate into grid-cell clusters
const Z_ICON = 0.2;      // vector type icons only when they're big enough to read
const EDGE_MIN = 320;    // shortest edge (world units); skip all edges when they'd be < 2 px
function iconPath(p, t, lx, ly, w, h) {
  const s = Math.min(w, h) * 0.4, cx = lx + w / 2, cy = ly + h / 2, q = s / 2;
  switch (t) {
    case 0: for (let k = -1; k <= 1; k++) p.rect(cx - q, cy + k * s * 0.3 - s * 0.06, s, s * 0.12); break; // document: text lines
    case 1: p.rect(cx - q, cy - q, s, s * 0.18); p.rect(cx - q, cy - q, s * 0.18, s); p.rect(cx - q, cy + q - s * 0.18, s, s * 0.18); p.rect(cx + q - s * 0.18, cy - q, s * 0.18, s); break; // task: checkbox
    case 2: p.rect(cx - q, cy - s * 0.08, s, s * 0.16); break; // note: single line
    case 3: p.moveTo(cx - q, cy + q); p.lineTo(cx - s * 0.1, cy - q); p.lineTo(cx + q, cy + q); p.closePath(); break; // image: mountain
    case 4: p.moveTo(cx - s * 0.2 + s * 0.18, cy); p.arc(cx - s * 0.2, cy, s * 0.18, 0, 6.2832); p.moveTo(cx + s * 0.2 + s * 0.18, cy); p.arc(cx + s * 0.2, cy, s * 0.18, 0, 6.2832); break; // link: chain
    default: { const c = s * 0.42; p.rect(cx - q, cy - q, c, c); p.rect(cx + q - c, cy - q, c, c); p.rect(cx - q, cy + q - c, c, c); p.rect(cx + q - c, cy + q - c, c, c); } // board: grid
  }
}
function buildV2(g) {
  const tw = Math.ceil((g.maxX - g.minX) / TILE) + 1, th = Math.ceil((g.maxY - g.minY) / TILE) + 1;
  const byIdx = new Array(tw * th), tiles = [];
  const tileOf = (x, y) => {
    const k = (((y - g.minY) / TILE) | 0) * tw + (((x - g.minX) / TILE) | 0);
    let t = byIdx[k];
    if (!t) {
      const ox = g.minX + (k % tw) * TILE, oy = g.minY + ((k / tw) | 0) * TILE;
      t = byIdx[k] = { ox, oy, n: 0, shapes: TYPES.map(() => new Path2D()), cards: TYPES.map(() => new Path2D()), icons: new Path2D(), edges: new Path2D(),
        x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, nodes: [] };
      tiles.push(t);
    }
    return t;
  };
  const grow = (t, x0, y0, x1, y1) => { if (x0 < t.x0) t.x0 = x0; if (y0 < t.y0) t.y0 = y0; if (x1 > t.x1) t.x1 = x1; if (y1 > t.y1) t.y1 = y1; };
  for (let i = 0; i < g.n; i++) {
    const t = tileOf(g.x[i], g.y[i]), lx = g.x[i] - t.ox, ly = g.y[i] - t.oy, w = g.w[i], h = g.h[i], ty = g.type[i];
    const s = TYPES[ty].shape, p = t.shapes[ty];
    if (s === 'rect') p.rect(lx, ly, w, h);
    else if (s === 'circle') { const r = Math.min(w, h) / 2; p.moveTo(lx + w / 2 + r, ly + h / 2); p.arc(lx + w / 2, ly + h / 2, r, 0, 6.2832); }
    else { p.moveTo(lx + w / 2, ly); p.lineTo(lx + w, ly + h / 2); p.lineTo(lx + w / 2, ly + h); p.lineTo(lx, ly + h / 2); p.closePath(); }
    t.cards[ty].rect(lx, ly, w, h);
    iconPath(t.icons, ty, lx, ly, w, h);
    t.n++; t.nodes.push(i); grow(t, g.x[i], g.y[i], g.x[i] + w, g.y[i] + h);
  }
  for (let e = 0; e < g.E; e++) {
    const s = g.src[e], d = g.dst[e], t = tileOf(g.x[s], g.y[s]);
    const ax = g.x[s] + g.w[s] / 2, ay = g.y[s] + g.h[s] / 2, bx = g.x[d] + g.w[d] / 2, by = g.y[d] + g.h[d] / 2;
    t.edges.moveTo(ax - t.ox, ay - t.oy); t.edges.lineTo(bx - t.ox, by - t.oy);
    grow(t, Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
  }
  for (const t of tiles) t.nodes = Int32Array.from(t.nodes);
  // grid-cell clusters for sub-visible zoom: dominant type per cell, area ~ node count
  const cw = Math.ceil((g.maxX - g.minX) / CLUSTER) + 1, ch = Math.ceil((g.maxY - g.minY) / CLUSTER) + 1;
  const cnt = new Uint16Array(cw * ch * TYPES.length);
  for (let i = 0; i < g.n; i++) {
    const c = (((g.y[i] + g.h[i] / 2 - g.minY) / CLUSTER) | 0) * cw + (((g.x[i] + g.w[i] / 2 - g.minX) / CLUSTER) | 0);
    cnt[c * TYPES.length + g.type[i]]++;
  }
  const clusters = TYPES.map(() => new Path2D());
  for (let c = 0; c < cw * ch; c++) {
    let tot = 0, best = 0;
    for (let t = 0; t < TYPES.length; t++) { const v = cnt[c * TYPES.length + t]; tot += v; if (v > cnt[c * TYPES.length + best]) best = t; }
    if (!tot) continue;
    const side = Math.min(0.85, 0.27 * Math.sqrt(tot)) * CLUSTER, cx = (c % cw + 0.5) * CLUSTER, cy = (((c / cw) | 0) + 0.5) * CLUSTER;
    clusters[best].rect(cx - side / 2, cy - side / 2, side, side);
  }
  g.v2 = { tiles, clusters, visTiles: new Int32Array(tiles.length) };
}
const fontCache = new Map();
function font(px) { let f = fontCache.get(px); if (!f) fontCache.set(px, (f = px + 'px system-ui,sans-serif')); return f; }
const EDGE_FAR = 'rgba(140,160,200,0.18)', EDGE_NEAR = 'rgba(140,160,200,0.45)';
const TYPE_TINT = TYPES.map((t) => t.color + '33');
function drawV2() {
  frameNo++;
  const g = G, V = g.v2, z = cam.z, a = dpr * z, hw = vw / 2 / z, hh = vh / 2 / z;
  const x0 = cam.x - hw, y0 = cam.y - hh, x1 = cam.x + hw, y1 = cam.y + hh;
  lodLevel = z < Z_CLUSTER ? -1 : z < LOD1 ? 0 : z < LOD2 ? 1 : 2;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0f1115'; ctx.fillRect(0, 0, vw, vh);
  let nt = 0, vis = 0; const tiles = V.tiles, vt = V.visTiles;
  for (let k = 0; k < tiles.length; k++) { const t = tiles[k]; if (t.x0 <= x1 && t.x1 >= x0 && t.y0 <= y1 && t.y1 >= y0) { vt[nt++] = k; vis += t.n; } }
  visibleCount = vis;
  const ex = dpr * vw / 2, ey = dpr * vh / 2;
  if (z * EDGE_MIN >= 2) {
    ctx.strokeStyle = lodLevel <= 0 ? EDGE_FAR : EDGE_NEAR; ctx.lineWidth = (lodLevel === 2 ? 1.5 : 1) / z;
    for (let k = 0; k < nt; k++) { const t = tiles[vt[k]]; ctx.setTransform(a, 0, 0, a, ex + (t.ox - cam.x) * a, ey + (t.oy - cam.y) * a); ctx.stroke(t.edges); }
  }
  if (lodLevel === -1) {
    ctx.setTransform(a, 0, 0, a, ex + (g.minX - cam.x) * a, ey + (g.minY - cam.y) * a);
    for (let t = 0; t < TYPES.length; t++) { ctx.fillStyle = TYPES[t].color; ctx.fill(V.clusters[t]); }
  } else {
    const card = lodLevel === 2;
    for (let ty = 0; ty < TYPES.length; ty++) {
      ctx.fillStyle = card ? TYPE_TINT[ty] : TYPES[ty].color;
      if (card) { ctx.strokeStyle = TYPES[ty].color; ctx.lineWidth = 1.5 / z; }
      for (let k = 0; k < nt; k++) {
        const t = tiles[vt[k]]; ctx.setTransform(a, 0, 0, a, ex + (t.ox - cam.x) * a, ey + (t.oy - cam.y) * a);
        const p = card ? t.cards[ty] : t.shapes[ty]; ctx.fill(p); if (card) ctx.stroke(p);
      }
    }
    if (lodLevel === 1 && z >= Z_ICON) {
      ctx.fillStyle = 'rgba(15,17,21,0.85)';
      for (let k = 0; k < nt; k++) { const t = tiles[vt[k]]; ctx.setTransform(a, 0, 0, a, ex + (t.ox - cam.x) * a, ey + (t.oy - cam.y) * a); ctx.fill(t.icons); }
    }
    if (card) { // titles: screen-space text, only nodes actually on screen
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const fs = Math.round(Math.min(18, 14 * z + 4)); ctx.font = font(fs); ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = '#e6e8ee';
      const ox = vw / 2 - cam.x * z, oy = vh / 2 - cam.y * z, X = g.x, Y = g.y, W = g.w, H = g.h;
      for (let k = 0; k < nt; k++) {
        const ns = tiles[vt[k]].nodes;
        for (let m = 0; m < ns.length; m++) {
          const i = ns[m];
          if (X[i] > x1 || X[i] + W[i] < x0 || Y[i] > y1 || Y[i] + H[i] < y0) continue;
          ctx.fillText(g.label[i], X[i] * z + ox + 6, Y[i] * z + oy + 6, W[i] * z - 12);
        }
      }
    }
  }
}

const draw = RENDERER === 'v1' ? drawV1 : drawV2;

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

// ---------- environment ----------
function browserLabel() {
  const ua = navigator.userAgent, tauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
  const ver = (re) => (ua.match(re) || [])[1] || '';
  const android = /Android/.test(ua), wv = /; wv\)/.test(ua);
  const cr = ver(/Chrome\/(\d+)/);
  if (tauri) return android ? `Tauri · Android System WebView ${cr}` : /Windows/.test(ua) ? `Tauri · WebView2 ${ver(/Edg\/(\d+)/) || cr}` : `Tauri · WebView ${cr}`;
  if (wv) return `Android System WebView ${cr}`;
  if (/Edg[A]?\//.test(ua)) return `Edge ${ver(/Edg[A]?\/(\d+)/)}${android ? ' (Android)' : ''}`;
  if (/SamsungBrowser/.test(ua)) return `Samsung Internet ${ver(/SamsungBrowser\/(\d+)/)}`;
  if (/Firefox\//.test(ua)) return `Firefox ${ver(/Firefox\/(\d+)/)}`;
  if (/HeadlessChrome/.test(ua)) return `Headless Chrome ${ver(/HeadlessChrome\/(\d+)/)}`;
  if (cr) return `Chrome ${cr}${android ? ' (Android)' : ''}`;
  if (/Safari\//.test(ua)) return `Safari ${ver(/Version\/(\d+)/)}`;
  return 'Unknown browser';
}
const BROWSER = browserLabel();
let refreshHz = 0; // detected at startup from idle rAF intervals (no drawing while detecting)
const HZ = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 240];
function snapHz(ms) { const raw = 1000 / ms; return HZ.reduce((b, h) => (Math.abs(h - raw) < Math.abs(b - raw) ? h : b), 60); }

// ---------- telemetry ----------
const RING = 240, ring = new Float64Array(RING), dring = new Float64Array(RING), sortBuf = new Float64Array(RING); let rn = 0;
function pct(arr, p) { if (!arr.length) return 0; const s = Float64Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
function ringPct(src, m, ps) { const s = sortBuf.subarray(0, m); s.set(src.subarray(0, m)); s.sort(); return ps.map((p) => (m ? s[Math.min(m - 1, Math.floor(p * m))] : 0)); }
const statsEl = document.getElementById('stats'), progEl = document.getElementById('progress');
const LOD_NAMES = { '-1': 'clusters', 0: 'shapes', 1: 'icons', 2: 'titles' };
let lastHud = 0;
function hud(now) {
  if (bench || now - lastHud < 250) return; lastHud = now; // no DOM work during benchmark runs
  const m = Math.min(rn, RING); let sum = 0; for (let i = 0; i < m; i++) sum += ring[i];
  const [p50, p95, p99] = ringPct(ring, m, [0.5, 0.95, 0.99]), [d95, d99] = ringPct(dring, m, [0.95, 0.99]);
  statsEl.innerHTML =
    `<div>renderer <b>${RENDERER}</b> · ${BROWSER} · ${refreshHz ? refreshHz + ' Hz' : 'detecting Hz…'}</div>` +
    `<div>FPS <b>${m ? (1000 / (sum / m)).toFixed(0) : '-'}</b> · nodes ${G.n.toLocaleString()} · edges ${G.E.toLocaleString()}</div>` +
    `<div>frame p50/p95/p99: <b>${p50.toFixed(1)} / ${p95.toFixed(1)} / ${p99.toFixed(1)}</b> ms</div>` +
    `<div>draw p95/p99: ${d95.toFixed(1)} / ${d99.toFixed(1)} ms</div>` +
    `<div>visible ${visibleCount.toLocaleString()}${RENDERER === 'v2' ? ' (in visible tiles)' : ''} · LOD ${LOD_NAMES[lodLevel]} · zoom ${cam.z.toFixed(3)}</div>` +
    `<div>DPR ${dpr} · canvas ${canvas.width}×${canvas.height}</div>`;
}

// ---------- auto benchmark ----------
const BENCH_MS = (+Q.get('secs') || 15) * 1000, WARM_MS = 1000, JITTER = 1.0;
let bench = null;
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
  if (!refreshHz) return;
  document.getElementById('results').style.display = 'none';
  bench = { queue: COUNTS.slice(), results: [], cur: null };
  nextBench();
}
function nextBench() {
  const n = bench.queue.shift();
  if (n === undefined) return finishBench();
  load(n); bench.cur = { n, t0: performance.now(), iv: [], dv: [], maxVis: 0 };
}
const passCell = (ok) => `<td class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</td>`;
function finishBench() {
  const res = bench.results; bench = null; progEl.textContent = '';
  const nat = 1000 / refreshHz;
  const rows = res.map((r) => `<tr><td>${r.n.toLocaleString()}</td><td>${r.frames}</td><td>${r.fps.toFixed(0)}</td><td>${r.p50.toFixed(1)}</td><td>${r.p95.toFixed(1)}</td><td><b>${r.p99.toFixed(1)}</b></td><td>${r.d95.toFixed(1)}</td><td>${r.d99.toFixed(1)}</td><td>${r.maxVis.toLocaleString()}</td>${passCell(r.pass60)}${passCell(r.passNative)}</tr>`).join('');
  document.getElementById('rtable').innerHTML = `<tr><th>Nodes</th><th>Frames</th><th>Avg FPS</th><th>p50 ms</th><th>p95 ms</th><th>p99 ms</th><th>Draw p95</th><th>Draw p99</th><th>Max visible</th><th>60 fps floor<br>(p99 ≤ ${(16.7 + JITTER).toFixed(1)})</th><th>Native ${refreshHz} Hz<br>(p99 ≤ ${(nat + JITTER).toFixed(1)})</th></tr>` + rows;
  document.getElementById('rmeta').innerHTML = `<b>${BROWSER}</b> · renderer <b>${RENDERER}</b> · display ${refreshHz} Hz · DPR ${dpr} · viewport ${vw}×${vh} · ${new Date().toLocaleString()}<br>${navigator.userAgent}`;
  document.getElementById('results').style.display = 'flex';
  window.__benchResults = res; document.title = 'BENCH_DONE';
  setActive();
}
function benchTick(now, dt, drawMs) {
  const b = bench.cur, el = now - b.t0;
  if (el >= BENCH_MS) {
    const fps = b.iv.length / (b.iv.reduce((s, v) => s + v, 0) / 1000);
    const r = { n: b.n, frames: b.iv.length, fps, p50: pct(b.iv, 0.5), p95: pct(b.iv, 0.95), p99: pct(b.iv, 0.99), d95: pct(b.dv, 0.95), d99: pct(b.dv, 0.99), maxVis: b.maxVis };
    r.pass60 = r.p99 <= 16.7 + JITTER; r.passNative = r.p99 <= 1000 / refreshHz + JITTER; bench.results.push(r); nextBench(); return;
  }
  if (el > WARM_MS) { b.iv.push(dt); b.dv.push(drawMs); b.maxVis = Math.max(b.maxVis, visibleCount); }
  const secs = Math.ceil((BENCH_MS - el) / 1000);
  if (secs !== b.secs) { b.secs = secs; progEl.textContent = `Benchmarking ${b.n.toLocaleString()} nodes… ${secs}s`; } // DOM touch once per second
  benchCamera(Math.max(0, el - WARM_MS) / (BENCH_MS - WARM_MS));
}

// ---------- main loop ----------
let last = 0, lastDraw = 0;
const detect = []; // idle frame intervals for refresh-rate detection
function loop(now) {
  const dt = last ? now - last : 0; last = now;
  if (!refreshHz) {
    if (dt) detect.push(dt);
    if (detect.length >= 40) { refreshHz = snapHz(pct(detect.slice(5), 0.5)); progEl.textContent = ''; setActive(); if (Q.has('bench')) startBench(); }
    else { progEl.textContent = 'Detecting display refresh rate…'; requestAnimationFrame(loop); return; }
  }
  if (bench && bench.cur) benchTick(now, dt, lastDraw);
  const t0 = performance.now(); draw(); lastDraw = performance.now() - t0;
  if (dt) { ring[rn % RING] = dt; dring[rn % RING] = lastDraw; rn++; }
  hud(now);
  requestAnimationFrame(loop);
}

function load(n) { G = makeGraph(n); fitAll(); rn = 0; last = 0; setActive(); }
const countsEl = document.getElementById('counts');
function setActive() {
  countsEl.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', +b.dataset.n === G.n); b.disabled = !!bench; });
  document.getElementById('bench').disabled = !!bench || !refreshHz;
}
COUNTS.forEach((n) => { const b = document.createElement('button'); b.textContent = n / 1000 + 'k'; b.dataset.n = n; b.onclick = () => load(n); countsEl.appendChild(b); });
document.getElementById('bench').onclick = startBench;
document.getElementById('rclose').onclick = () => (document.getElementById('results').style.display = 'none');
const swap = document.getElementById('swap');
swap.textContent = RENDERER === 'v1' ? 'Use renderer v2' : 'Use renderer v1 (A/B)';
swap.onclick = () => { const q = new URLSearchParams(location.search); if (RENDERER === 'v1') q.delete('renderer'); else q.set('renderer', 'v1'); q.delete('bench'); location.search = q.toString(); };

resize(); load(+Q.get('n') || 10000);
requestAnimationFrame(loop);
