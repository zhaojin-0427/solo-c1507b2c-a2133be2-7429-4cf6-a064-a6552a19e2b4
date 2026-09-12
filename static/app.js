/* =====================================================================
 * app.js — 手织组织图校验台前端
 * 原生 Canvas 渲染：一张底图 canvas + 一张叠加 canvas（高亮/动画）。
 * ===================================================================== */
'use strict';

/* ------------------------------- 小工具 ------------------------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const deepClone = (o) => JSON.parse(JSON.stringify(o));

function toast(msg, ms = 1800) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ------------------------------- 全局状态 ----------------------------- */
const state = {
  draft: Engine.defaultDraft(),
  analysis: null,
  savedId: null,

  tool: 'paint',
  zoom: 1,
  selectedColor: 1,
  treadleBrush: 0,

  lockThreading: false,
  lockTieup: false,

  history: [],
  future: [],

  hover: null,            // {grid,r,c,x,y}
  gesture: null,          // 正在进行的涂绘手势
  selection: null,        // {grid,r0,c0,r1,c1}
  clipboard: null,        // {grid, rows, cols, matrix:[[0/1]]}
  pasteAnchor: null,

  activeIssue: -1,
  flashUntil: 0,

  compareB: null,         // 方案 B 缓存 {id,name,data}，编辑 A 时实时重算比较

  playing: false,
  stepHold: false,
  playPick: 0,
  playTimer: null,

  dirty: false,
};

/* ------------------------------- 布局 --------------------------------- */
const CELL = 22, BAND = 14, GAP = 18, STRIPW = 26;
const PADL = 86, PADT = 42, PADR = 44, PADB = 34;

function computeLayout(d) {
  const drawY0 = PADT + d.shafts * CELL + GAP;
  const rightX0 = PADL + d.ends * CELL + GAP;
  const bandX = PADL - BAND - 8;
  const bandY = PADT - BAND - 8;
  const stripX = bandX - 6 - STRIPW;
  const L = {
    W: PADL + (d.ends + d.shafts) * CELL + GAP + PADR,
    H: drawY0 + d.picks * CELL + PADB,
    drawY0, rightX0, bandX, bandY, stripX,
    regions: {
      threading: { x0: PADL, y0: PADT, cols: d.ends, rows: d.shafts, w: d.ends * CELL, h: d.shafts * CELL, cell: CELL },
      tieup:     { x0: rightX0, y0: PADT, cols: d.treadles, rows: d.shafts, w: d.treadles * CELL, h: d.shafts * CELL, cell: CELL },
      drawdown:  { x0: PADL, y0: drawY0, cols: d.ends, rows: d.picks, w: d.ends * CELL, h: d.picks * CELL, cell: CELL, readonly: true },
      treadling: { x0: rightX0, y0: drawY0, cols: d.treadles, rows: d.picks, w: d.treadles * CELL, h: d.picks * CELL, cell: CELL },
      warpband:  { x0: PADL, y0: bandY, cols: d.ends, rows: 1, w: d.ends * CELL, h: BAND, cell: CELL, band: true, axis: 'warp' },
      weftband:  { x0: bandX, y0: drawY0, cols: 1, rows: d.picks, w: BAND, h: d.picks * CELL, cell: CELL, band: true, axis: 'weft' },
    },
  };
  return L;
}

/* 综框/踏板的区分色 */
const shaftColor = (i, n) => `hsl(${(i * 360 / Math.max(n, 1)) | 0}, 58%, 45%)`;

/* ------------------------------- Canvas ------------------------------- */
let boardEl, baseCvs, ovCvs, baseCtx, ovCtx;
let dpr = Math.max(1, window.devicePixelRatio || 1);

function setupCanvas() {
  boardEl = $('#board');
  boardEl.innerHTML = '';
  baseCvs = document.createElement('canvas');
  baseCvs.id = 'baseCanvas';
  ovCvs = document.createElement('canvas');
  ovCvs.id = 'overlayCanvas';
  boardEl.appendChild(baseCvs);
  boardEl.appendChild(ovCvs);
  baseCtx = baseCvs.getContext('2d');
  ovCtx = ovCvs.getContext('2d');

  baseCvs.addEventListener('pointerdown', onPointerDown);
  baseCvs.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  baseCvs.addEventListener('pointerleave', () => { if (!state.gesture) { state.hover = null; } });
  baseCvs.addEventListener('contextmenu', e => e.preventDefault());
}

function resizeCanvases() {
  const d = state.draft, L = computeLayout(d);
  state.layout = L;
  const W = L.W * state.zoom, H = L.H * state.zoom;
  boardEl.style.width = W + 'px';
  boardEl.style.height = H + 'px';
  for (const [cvs, ctx] of [[baseCvs, baseCtx], [ovCvs, ovCtx]]) {
    cvs.width = Math.round(W * dpr);
    cvs.height = Math.round(H * dpr);
    cvs.style.width = W + 'px';
    cvs.style.height = H + 'px';
    ctx.setTransform(dpr * state.zoom, 0, 0, dpr * state.zoom, 0, 0);
  }
  drawBase();
}

/* ------------------------------- 底图绘制 ----------------------------- */
function drawBase() {
  const d = state.draft, A = state.analysis, L = state.layout;
  const ctx = baseCtx;
  ctx.clearRect(0, 0, L.W, L.H);
  drawRegionFrame(ctx, L.regions.threading);
  drawRegionFrame(ctx, L.regions.tieup);
  drawRegionFrame(ctx, L.regions.drawdown);
  drawRegionFrame(ctx, L.regions.treadling);
  drawBands(ctx, d);
  drawShuttleStrip(ctx, d);
  drawThreading(ctx, d);
  drawTieup(ctx, d);
  drawTreadling(ctx, d);
  drawDrawdown(ctx, d, A);
  drawLabels(ctx, d, L);
  drawRepeatMarks(ctx, d, A, L);
}

function drawRegionFrame(ctx, R) {
  ctx.fillStyle = '#fffdf7';
  ctx.fillRect(R.x0, R.y0, R.w, R.h);
  ctx.strokeStyle = '#b9ae94';
  ctx.lineWidth = 1;
  ctx.strokeRect(R.x0 + .5, R.y0 + .5, R.w - 1, R.h - 1);
  ctx.strokeStyle = '#e4dcc9';
  ctx.beginPath();
  for (let c = 1; c < R.cols; c++) {
    const x = R.x0 + c * R.cell + .5;
    ctx.moveTo(x, R.y0); ctx.lineTo(x, R.y0 + R.h);
  }
  for (let r = 1; r < R.rows; r++) {
    const y = R.y0 + r * R.cell + .5;
    ctx.moveTo(R.x0, y); ctx.lineTo(R.x0 + R.w, y);
  }
  ctx.stroke();
}

function drawBands(ctx, d) {
  const Rw = state.layout.regions.warpband, Rf = state.layout.regions.weftband;
  for (let e = 0; e < d.ends; e++) {
    ctx.fillStyle = colorOf(d, d.warpColor[e]);
    ctx.fillRect(Rw.x0 + e * CELL, Rw.y0, CELL, BAND);
  }
  ctx.strokeStyle = '#b9ae94';
  ctx.strokeRect(Rw.x0 + .5, Rw.y0 + .5, Rw.w - 1, BAND - 1);
  for (let p = 0; p < d.picks; p++) {
    ctx.fillStyle = colorOf(d, d.weftColor[p]);
    ctx.fillRect(Rf.x0, Rf.y0 + p * CELL, BAND, CELL);
  }
  ctx.strokeStyle = '#b9ae94';
  ctx.strokeRect(Rf.x0 + .5, Rf.y0 + .5, BAND - 1, Rf.h - 1);
  if (state.zoom >= .75) {
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    drawBandNumbers(ctx, d, Rw, d.warpColor, true);
    drawBandNumbers(ctx, d, Rf, d.weftColor, false);
  }
}

function drawBandNumbers(ctx, d, R, arr, horizontal) {
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.strokeStyle = 'rgba(0,0,0,.55)';
  ctx.lineWidth = 2;
  const n = horizontal ? d.ends : d.picks;
  for (let i = 0; i < n; i++) {
    const txt = String((arr[i] ?? 0) + 1);
    let x, y;
    if (horizontal) { x = R.x0 + i * CELL + CELL / 2; y = R.y0 + BAND / 2; }
    else { x = R.x0 + BAND / 2; y = R.y0 + i * CELL + CELL / 2; }
    ctx.strokeText(txt, x, y);
    ctx.fillText(txt, x, y);
  }
}

function colorOf(d, idx) {
  const c = d.palette[idx];
  return c ? c.hex : '#888';
}

/* ------------------------------- 梭道（多梭布边） ---------------------- */
const JOIN_NAMES = { wrap: '包绕', lock: '交锁', cut: '剪断重接' };
const JOIN_SHORT = { wrap: '包', lock: '锁', cut: '剪' };

/** 交接方式小符号：包绕=圆圈，交锁=叉，剪断=双斜杠 */
function drawJoinMark(ctx, x, y, size, join, color) {
  ctx.save();
  ctx.strokeStyle = color || '#2d2a24';
  ctx.lineWidth = 1.4;
  const cx = x + size / 2, cy = y + size / 2, r = size * .3;
  if (join === 'wrap') {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  } else if (join === 'lock') {
    ctx.beginPath();
    ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
    ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r);
    ctx.stroke();
  } else if (join === 'cut') {
    ctx.beginPath();
    ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx - r * .2, cy - r);
    ctx.moveTo(cx + r * .2, cy + r); ctx.lineTo(cx + r, cy - r);
    ctx.stroke();
  }
  ctx.restore();
}

/** 梭子色块（圆角小牌 + 梭号） */
function drawShuttleChip(ctx, x, y, w, h, hex, num, opts = {}) {
  ctx.save();
  ctx.globalAlpha = opts.alpha != null ? opts.alpha : 1;
  ctx.fillStyle = hex;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, 3);
  else ctx.rect(x, y, w, h);
  ctx.fill();
  if (opts.ring) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = opts.ring;
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.min(10, h - 3)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,.6)';
  ctx.shadowBlur = 2;
  ctx.fillText(String(num), x + w / 2, y + h / 2 + .5);
  ctx.restore();
}

/** 图板左侧梭道：逐纬显示梭子 / 入梭方向 / 交接符号 / 锁定点 */
function drawShuttleStrip(ctx, d) {
  const L = state.layout, A = state.analysis;
  const x0 = L.stripX, y0 = L.drawY0;
  const H = d.picks * CELL;
  ctx.fillStyle = '#fffdf7';
  ctx.fillRect(x0, y0, STRIPW, H);
  ctx.strokeStyle = '#e4dcc9';
  ctx.beginPath();
  for (let p = 1; p < d.picks; p++) {
    const y = y0 + p * CELL + .5;
    ctx.moveTo(x0, y); ctx.lineTo(x0 + STRIPW, y);
  }
  ctx.stroke();
  ctx.strokeStyle = '#b9ae94';
  ctx.strokeRect(x0 + .5, y0 + .5, STRIPW - 1, H - 1);

  // 列标题
  ctx.fillStyle = '#6b6457';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('梭', x0 + STRIPW / 2, y0 - 8);

  const sh = d.shuttles;
  if (!sh) return;
  const sp = A && A.shuttle;
  for (let p = 0; p < d.picks; p++) {
    const y = y0 + p * CELL;
    const a = sh.picks[p];
    if (sh.locked[p]) {
      // 锁定点（已织纬）
      ctx.fillStyle = 'rgba(107,100,87,.65)';
      ctx.beginPath();
      ctx.arc(x0 + STRIPW - 4, y + 4, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!a) {
      ctx.fillStyle = 'rgba(107,100,87,.4)';
      ctx.beginPath();
      ctx.arc(x0 + 9, y + CELL / 2, 1.6, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    const r = sp && sp.rows ? sp.rows[p] : null;
    drawShuttleChip(ctx, x0 + 2, y + 4, 14, CELL - 8,
      colorOf(d, sh.colors[a.s]), a.s + 1,
      r && r.mismatch ? { ring: '#b3352a' } : {});
    // 入梭方向小三角（左入▶ / 右入◀），画在色块下缘
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    const ay = y + CELL - 6, ax = x0 + 9;
    ctx.beginPath();
    if (a.enter === 'L') {   // 左入 → 向右织
      ctx.moveTo(ax - 2.5, ay - 2.5); ctx.lineTo(ax + 2.5, ay); ctx.lineTo(ax - 2.5, ay + 2.5);
    } else {                 // 右入 → 向左织
      ctx.moveTo(ax + 2.5, ay - 2.5); ctx.lineTo(ax - 2.5, ay); ctx.lineTo(ax + 2.5, ay + 2.5);
    }
    ctx.closePath();
    ctx.fill();
    if (a.join) drawJoinMark(ctx, x0 + 16, y + (CELL - 10) / 2, 10, a.join);
  }
}

function markRect(ctx, x, y, size) {
  const pad = Math.max(2, size * .14);
  const r = Math.max(2, size * .18);
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x + pad, y + pad, size - pad * 2, size - pad * 2, r);
  else ctx.rect(x + pad, y + pad, size - pad * 2, size - pad * 2);
  ctx.fill();
}

function drawThreading(ctx, d) {
  const R = state.layout.regions.threading;
  for (let e = 0; e < d.ends; e++) {
    const s = d.threading[e];
    if (s >= 0 && s < d.shafts) {
      ctx.fillStyle = shaftColor(s, d.shafts);
      markRect(ctx, R.x0 + e * CELL, R.y0 + s * CELL, CELL);
    } else {
      // 越界 / 未穿：列底红色警示三角
      const x = R.x0 + e * CELL, y = R.y0 + R.h;
      ctx.fillStyle = '#b3352a';
      ctx.beginPath();
      ctx.moveTo(x + CELL / 2, y - 7);
      ctx.lineTo(x + CELL - 4, y - 1.5);
      ctx.lineTo(x + 4, y - 1.5);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function drawTieup(ctx, d) {
  const R = state.layout.regions.tieup;
  ctx.fillStyle = '#2d2a24';
  for (let s = 0; s < d.shafts; s++)
    for (let t = 0; t < d.treadles; t++)
      if (d.tieup[s][t]) markRect(ctx, R.x0 + t * CELL, R.y0 + s * CELL, CELL);
}

function drawTreadling(ctx, d) {
  const R = state.layout.regions.treadling;
  for (let p = 0; p < d.picks; p++) {
    const t = d.treadling[p];
    if (t >= 0 && t < d.treadles) {
      const cx = R.x0 + t * CELL + CELL / 2;
      const cy = R.y0 + p * CELL + CELL / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, CELL * .32, 0, Math.PI * 2);
      ctx.fillStyle = shaftColor(t, d.treadles);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#2d2a24';
      ctx.stroke();
    } else {
      const x = R.x0, y = R.y0 + p * CELL;
      ctx.strokeStyle = '#b3352a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 5, y + 6); ctx.lineTo(x + R.w - 5, y + CELL - 6);
      ctx.moveTo(x + R.w - 5, y + 6); ctx.lineTo(x + 5, y + CELL - 6);
      ctx.stroke();
    }
  }
}

function drawDrawdown(ctx, d, A) {
  const R = state.layout.regions.drawdown;
  const dd = A.derived.drawdown;
  for (let p = 0; p < d.picks; p++) {
    for (let e = 0; e < d.ends; e++) {
      const v = dd[p][e];
      const x = R.x0 + e * CELL, y = R.y0 + p * CELL;
      if (v === null) {
        ctx.fillStyle = '#e9e2d2';
        ctx.fillRect(x, y, CELL, CELL);
        ctx.strokeStyle = 'rgba(179,53,42,.55)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x + 5, y + 5); ctx.lineTo(x + CELL - 5, y + CELL - 5);
        ctx.moveTo(x + CELL - 5, y + 5); ctx.lineTo(x + 5, y + CELL - 5);
        ctx.stroke();
      } else {
        const warpUp = v === 1;
        ctx.fillStyle = colorOf(d, warpUp ? d.warpColor[e] : d.weftColor[p]);
        ctx.fillRect(x, y, CELL, CELL);
      }
    }
  }
}

function drawLabels(ctx, d, L) {
  ctx.fillStyle = '#6b6457';
  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 综框号（穿综左侧）
  const Rth = L.regions.threading;
  for (let s = 0; s < d.shafts; s++)
    ctx.fillText(String(s + 1), Rth.x0 - 14, Rth.y0 + s * CELL + CELL / 2);

  // 踏板号（联结上方 + 踩踏下方）
  const Rti = L.regions.tieup, Rtr = L.regions.treadling;
  for (let t = 0; t < d.treadles; t++) {
    ctx.fillText(String(t + 1), Rti.x0 + t * CELL + CELL / 2, Rti.y0 - 12);
    ctx.fillText(String(t + 1), Rtr.x0 + t * CELL + CELL / 2, Rtr.y0 + Rtr.h + 13);
  }

  // 经线号（组织图下方）
  const stepE = d.ends <= 60 ? 1 : d.ends <= 120 ? 5 : 10;
  const Rd = L.regions.drawdown;
  for (let e = 0; e < d.ends; e += stepE)
    ctx.fillText(String(e + 1), Rd.x0 + e * CELL + CELL / 2, Rd.y0 + Rd.h + 13);

  // 纬线号（踩踏右侧）
  const stepP = d.picks <= 60 ? 1 : d.picks <= 120 ? 5 : 10;
  for (let p = 0; p < d.picks; p += stepP)
    ctx.fillText(String(p + 1), Rtr.x0 + Rtr.w + 14, Rtr.y0 + p * CELL + CELL / 2);
}

function drawRepeatMarks(ctx, d, A, L) {
  const r = A.rep;
  if (r.hasNull) return;
  const Rd = L.regions.drawdown;
  ctx.save();
  ctx.strokeStyle = 'rgba(41,82,140,.85)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  if (r.warp < d.ends) {
    const x = Rd.x0 + r.warp * CELL + .5;
    ctx.moveTo(x, Rd.y0); ctx.lineTo(x, Rd.y0 + Rd.h);
  }
  if (r.weft < d.picks) {
    const y = Rd.y0 + r.weft * CELL + .5;
    ctx.moveTo(Rd.x0, y); ctx.lineTo(Rd.x0 + Rd.w, y);
  }
  ctx.stroke();
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'left';
  const tag = (txt, x, y) => {
    const w = ctx.measureText(txt).width + 8;
    ctx.fillStyle = 'rgba(255,255,255,.88)';
    ctx.fillRect(x - 2, y - 10, w, 13);
    ctx.fillStyle = 'rgba(41,82,140,.95)';
    ctx.fillText(txt, x + 2, y);
  };
  if (r.warp < d.ends) tag(`经循环 ${r.warp}`, Rd.x0 + r.warp * CELL + 4, Rd.y0 + 12);
  if (r.weft < d.picks) tag(`纬循环 ${r.weft}`, Rd.x0 + 4, Rd.y0 + r.weft * CELL + 12);
  ctx.restore();
}

/* ------------------------------- 叠加层绘制 --------------------------- */
function frame(now) {
  drawOverlay(now);
  requestAnimationFrame(frame);
}

function drawOverlay(now) {
  const d = state.draft, A = state.analysis, L = state.layout;
  const ctx = ovCtx;
  ctx.clearRect(0, 0, L.W, L.H);
  if (!A) return;

  drawCrossHighlight(ctx);
  drawPlayback(ctx, now);
  drawIssues(ctx, now);
  drawSelection(ctx, now);
  drawPastePreview(ctx);
  drawLocateFlash(ctx, now);
}

/* 外部模块定位闪烁（locateCell） */
function drawLocateFlash(ctx, now) {
  const f = state.locateFlash;
  if (!f || now > f.until) { if (f) state.locateFlash = null; return; }
  const R = state.layout.regions[f.grid];
  if (!R) return;
  let x, y, w, h;
  if (f.r < 0 || f.c < 0) {
    x = f.c < 0 ? R.x0 : R.x0 + f.c * CELL;
    y = f.r < 0 ? R.y0 : R.y0 + f.r * CELL;
    // c1：连续区段定位（如工艺单步骤对应的经线范围）
    w = f.c < 0 ? R.w : (f.c1 != null && f.c1 > f.c ? (f.c1 - f.c + 1) * CELL : CELL);
    h = f.r < 0 ? R.h : CELL;
  } else {
    x = R.x0 + f.c * CELL; y = R.y0 + f.r * CELL; w = h = CELL;
  }
  const pulse = .5 + .4 * Math.sin(now / 150);
  ctx.save();
  ctx.strokeStyle = '#c8784f';
  ctx.fillStyle = `rgba(200,120,79,${.12 + pulse * .12})`;
  ctx.lineWidth = 3;
  ctx.shadowColor = '#c8784f';
  ctx.shadowBlur = 10;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
  ctx.restore();
}

function cellRect(R, r, c) {
  return {
    x: R.x0 + c * R.cell,
    y: R.y0 + (R.band && R.axis === 'warp' ? 0 : r) * (R.band && R.axis === 'warp' ? 1 : R.cell),
    w: R.band ? (R.axis === 'weft' ? BAND : R.cell) : R.cell,
    h: R.band ? (R.axis === 'warp' ? BAND : R.cell) : R.cell,
  };
}

function fillRegionCell(ctx, R, r, c, alpha) {
  let x, y, w, h;
  if (R.band) {
    x = R.axis === 'warp' ? R.x0 + c * CELL : R.x0;
    y = R.axis === 'weft' ? R.y0 + r * CELL : R.y0;
    w = R.axis === 'warp' ? CELL : BAND;
    h = R.axis === 'weft' ? CELL : BAND;
  } else {
    x = R.x0 + c * CELL; y = R.y0 + r * CELL; w = h = CELL;
  }
  ctx.globalAlpha = alpha;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
}

/* 悬停十字联动高亮 */
function drawCrossHighlight(ctx) {
  const h = state.hover;
  if (!h || state.gesture || state.playing) return;
  const L = state.layout, d = state.draft;
  ctx.fillStyle = 'rgba(217,164,65,.22)';
  const fill = (name, r, c) => {
    const R = L.regions[name];
    if (r < 0) ctx.fillRect(R.x0 + c * CELL, R.y0, CELL, R.h);
    else if (c < 0) ctx.fillRect(R.x0, R.y0 + r * CELL, R.w, CELL);
    else fillRegionCell(ctx, R, r, c, 1);
  };
  if (h.grid === 'threading') {
    fill('threading', h.r, h.c);
    ctx.fillRect(L.regions.drawdown.x0 + h.c * CELL, L.regions.drawdown.y0, CELL, L.regions.drawdown.h);
    fill('warpband', 0, h.c);
  } else if (h.grid === 'tieup') {
    fill('tieup', h.r, h.c);
    ctx.fillRect(L.regions.threading.x0, L.regions.threading.y0 + h.r * CELL, L.regions.threading.w, CELL);
    ctx.fillRect(L.regions.treadling.x0 + h.c * CELL, L.regions.treadling.y0, CELL, L.regions.treadling.h);
  } else if (h.grid === 'treadling') {
    fill('treadling', h.r, h.c);
    ctx.fillRect(L.regions.drawdown.x0, L.regions.drawdown.y0 + h.r * CELL, L.regions.drawdown.w, CELL);
    fill('weftband', h.r, 0);
    fill('tieup', -1, h.c);
  } else if (h.grid === 'drawdown') {
    fill('drawdown', h.r, h.c);
    fill('threading', -1, h.c);
    fill('treadling', h.r, -1);
    fill('warpband', 0, h.c);
    fill('weftband', h.r, 0);
  } else if (h.grid === 'warpband') {
    fill('warpband', 0, h.c);
    fill('threading', -1, h.c);
    ctx.fillRect(L.regions.drawdown.x0 + h.c * CELL, L.regions.drawdown.y0, CELL, L.regions.drawdown.h);
  } else if (h.grid === 'weftband') {
    fill('weftband', h.r, 0);
    fill('treadling', h.r, -1);
    ctx.fillRect(L.regions.drawdown.x0, L.regions.drawdown.y0 + h.r * CELL, L.regions.drawdown.w, CELL);
  }
}

/* 问题定位标记 */
function drawIssues(ctx, now) {
  const list = state.analysis.validation.issues;
  const pulse = .55 + .35 * Math.sin(now / 280);
  list.forEach((iss, idx) => {
    const active = idx === state.activeIssue;
    ctx.save();
    ctx.strokeStyle = iss.level === 'warn' ? '#b8862f' : '#b3352a';
    ctx.lineWidth = active ? 3 : 1.6;
    ctx.globalAlpha = active ? 1 : .45 + pulse * .4;
    ctx.shadowColor = ctx.strokeStyle;
    if (active) ctx.shadowBlur = 8;
    for (const loc of iss.loc) {
      const R = state.layout.regions[loc.grid];
      if (!R) continue;
      let x, y, w, h;
      if (loc.r < 0 || loc.c < 0) {
        x = loc.c < 0 ? R.x0 : R.x0 + loc.c * CELL;
        y = loc.r < 0 ? R.y0 : R.y0 + loc.r * CELL;
        w = loc.c < 0 ? R.w : CELL;
        h = loc.r < 0 ? R.h : CELL;
      } else if (R.band) {
        x = R.axis === 'warp' ? R.x0 + loc.c * CELL : R.x0;
        y = R.axis === 'weft' ? R.y0 + loc.r * CELL : R.y0;
        w = R.axis === 'warp' ? CELL : BAND;
        h = R.axis === 'weft' ? CELL : BAND;
      } else {
        x = R.x0 + loc.c * CELL; y = R.y0 + loc.r * CELL; w = h = CELL;
      }
      ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
    }
    ctx.restore();
  });
}

/* 选区蚂蚁线 */
function drawSelection(ctx, now) {
  const sel = state.selection;
  if (!sel) return;
  const R = state.layout.regions[sel.grid];
  const ww = R.band && R.axis === 'weft' ? BAND : (sel.c1 - sel.c0 + 1) * CELL;
  const hh = R.band && R.axis === 'warp' ? BAND : (sel.r1 - sel.r0 + 1) * CELL;
  const x = R.band && R.axis === 'weft' ? R.x0 : R.x0 + sel.c0 * CELL;
  const y = R.band && R.axis === 'warp' ? R.y0 : R.y0 + sel.r0 * CELL;
  ctx.save();
  ctx.fillStyle = 'rgba(41,82,140,.12)';
  ctx.fillRect(x, y, ww, hh);
  ctx.strokeStyle = '#29528c';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.lineDashOffset = -now / 60;
  ctx.strokeRect(x + 1, y + 1, ww - 2, hh - 2);
  ctx.restore();
}

/* 粘贴预览 */
function drawPastePreview(ctx) {
  if (!state.clipboard || !state.hover || state.tool !== 'select') return;
  if (state.clipboard.grid !== state.hover.grid) return;
  const { grid } = state.clipboard;
  const R = state.layout.regions[grid];
  const r0 = state.hover.r < 0 ? 0 : state.hover.r;
  const c0 = state.hover.c < 0 ? 0 : state.hover.c;
  ctx.save();
  ctx.strokeStyle = '#4a7c59';
  ctx.fillStyle = 'rgba(74,124,89,.15)';
  ctx.lineWidth = 2;
  const x = R.x0 + c0 * CELL, y = R.y0 + r0 * CELL;
  const w = state.clipboard.cols * CELL, h = state.clipboard.rows * CELL;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  ctx.restore();
}

/* 播放高亮 + 梭路径 */
function drawPlayback(ctx, now) {
  if (!state.playing) return;
  const d = state.draft, L = state.layout, A = state.analysis;
  const p = state.playPick;
  // 升综矩阵驱动时踩踏序列不再决定组织，不再高亮踏板列
  const dobbyOn = !!(d.dobby && d.dobby.enabled);
  const t = dobbyOn ? -1 : d.treadling[p];
  const Rd = L.regions.drawdown;

  // 当前纬整行
  ctx.fillStyle = 'rgba(217,164,65,.28)';
  ctx.fillRect(Rd.x0, Rd.y0 + p * CELL, Rd.w, CELL);
  ctx.strokeStyle = '#9c6b1f';
  ctx.lineWidth = 2;
  ctx.strokeRect(Rd.x0 + 1, Rd.y0 + p * CELL + 1, Rd.w - 2, CELL - 2);

  // 踏板行 / 联结列
  const Rtr = L.regions.treadling, Rti = L.regions.tieup, Rth = L.regions.threading;
  ctx.fillStyle = 'rgba(217,164,65,.3)';
  ctx.fillRect(Rtr.x0, Rtr.y0 + p * CELL, Rtr.w, CELL);
  if (t >= 0 && t < d.treadles) {
    ctx.fillRect(Rti.x0 + t * CELL, Rti.y0, CELL, Rti.h);
  }

  // 升起的综框：穿综行 + 联结格金圈
  const lifted = A.derived.lifted[p];
  ctx.save();
  ctx.strokeStyle = '#e0a52e';
  ctx.lineWidth = 3;
  lifted.forEach(s => {
    ctx.strokeRect(Rth.x0 + 2, Rth.y0 + s * CELL + 2, Rth.w - 4, CELL - 4);
    ctx.beginPath();
    ctx.arc(Rti.x0 + t * CELL + CELL / 2, Rti.y0 + s * CELL + CELL / 2, CELL * .42, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.restore();

  // 梭子沿纬向行进；经浮点处线段隐到下方
  const sp = A.shuttle;
  const shRow = sp ? sp.rows[p] : null;
  const sh = d.shuttles;
  const yarn = shRow ? colorOf(d, sh.colors[shRow.shuttle]) : '#1d6f8e';
  const cycle = 1400 / Number($('#playSpeed').value || 3);
  const prog = ((now % cycle) / cycle);
  const dd = A.derived.drawdown[p];
  ctx.save();
  ctx.lineWidth = 3;
  for (let e = 0; e < d.ends; e++) {
    const x = Rd.x0 + e * CELL;
    const y = Rd.y0 + p * CELL + CELL / 2;
    const v = dd[e];
    if (v === null) { ctx.strokeStyle = 'rgba(179,53,42,.5)'; ctx.setLineDash([3, 3]); }
    else if (v === 0) { ctx.strokeStyle = yarn; ctx.setLineDash([]); } // 纬在上：可见
    else { ctx.strokeStyle = 'rgba(29,111,142,.3)'; ctx.setLineDash([2, 3]); } // 经在上：压在下面
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + CELL, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // 梭头：方向随入梭边（左入右行 / 右入左行）
  const enter = shRow ? shRow.enter : 'L';
  const sx = enter === 'L' ? Rd.x0 + prog * d.ends * CELL
                           : Rd.x0 + (1 - prog) * d.ends * CELL;
  const sy = Rd.y0 + p * CELL + CELL / 2;
  ctx.fillStyle = yarn;
  ctx.beginPath();
  if (enter === 'L') {
    ctx.moveTo(sx + 7, sy); ctx.lineTo(sx - 6, sy - 6); ctx.lineTo(sx - 6, sy + 6);
  } else {
    ctx.moveTo(sx - 7, sy); ctx.lineTo(sx + 6, sy - 6); ctx.lineTo(sx + 6, sy + 6);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 多梭布边：停放位置 + 当前交接
  if (sp && sp.active && sh) {
    const before = p > 0 ? sp.parked[p - 1] : sp.home;
    const groups = { L: [], R: [] };
    for (let k = 0; k < sh.count; k++) {
      if (shRow && shRow.shuttle === k) continue;   // 当前梭在织，不停放
      groups[before[k]].push(k);
    }
    for (const side of ['L', 'R']) {
      const g = groups[side];
      g.forEach((k, i) => {
        const cw = 16, ch = 13;
        const x = side === 'L' ? Rd.x0 + 2 : Rd.x0 + Rd.w - cw - 2;
        const y = Rd.y0 + p * CELL + CELL / 2 + (i - (g.length - 1) / 2) * (ch + 2) - ch / 2;
        drawShuttleChip(ctx, x, y, cw, ch, colorOf(d, sh.colors[k]), k + 1, { alpha: .92 });
      });
    }
    // 当前纬交接符号（入梭侧）
    if (shRow && shRow.join) {
      const jx = shRow.enter === 'L' ? Rd.x0 + 2 : Rd.x0 + Rd.w - 12;
      ctx.fillStyle = 'rgba(255,253,247,.9)';
      ctx.fillRect(jx - 1, Rd.y0 + p * CELL + 1, 12, 12);
      drawJoinMark(ctx, jx, Rd.y0 + p * CELL + 2, 10, shRow.join, '#9c4a2f');
    }
  }
}

/* ------------------------------- 命中测试 ----------------------------- */
function eventCell(ev) {
  const rect = baseCvs.getBoundingClientRect();
  const x = (ev.clientX - rect.left) / state.zoom;
  const y = (ev.clientY - rect.top) / state.zoom;
  const L = state.layout, d = state.draft;
  // 梭道（多梭布边）：独立命中，不在通用 regions 内
  if (L.stripX !== undefined && x >= L.stripX && x < L.stripX + STRIPW &&
      y >= L.drawY0 && y < L.drawY0 + d.picks * CELL) {
    return { grid: 'shuttletrack', r: clamp(Math.floor((y - L.drawY0) / CELL), 0, d.picks - 1), c: 0, x, y };
  }
  for (const [grid, R] of Object.entries(state.layout.regions)) {
    if (x >= R.x0 && x < R.x0 + R.w && y >= R.y0 && y < R.y0 + R.h) {
      const c = R.band && R.axis === 'weft' ? 0 : Math.floor((x - R.x0) / R.cell);
      const r = R.band && R.axis === 'warp' ? 0 : Math.floor((y - R.y0) / R.cell);
      return { grid, r: clamp(r, 0, R.rows - 1), c: clamp(c, 0, R.cols - 1), x, y };
    }
  }
  return null;
}

/* ------------------------------- 指针交互 ----------------------------- */
function onPointerDown(ev) {
  if (ev.button === 1) { startPan(ev); return; }       // 中键始终平移
  const hit = eventCell(ev);
  if (!hit) return;
  state.hover = hit;
  baseCvs.setPointerCapture(ev.pointerId);

  if (state.tool === 'pan') { startPan(ev); return; }
  if (state.tool === 'select') {
    state.selection = { grid: hit.grid, r0: hit.r, c0: hit.c, r1: hit.r, c1: hit.c };
    state.gesture = { type: 'select', pointerId: ev.pointerId };
    updateSelectionButtons();
    return;
  }

  if (hit.grid === 'drawdown') { toast('组织图为推导结果，请编辑穿综 / 联结 / 踩踏'); return; }
  if (hit.grid === 'shuttletrack') {
    if (state.tool === 'select') return;   // 梭道不支持框选
    handleShuttleTrackClick(hit, ev.button === 2);
    return;
  }
  if ((hit.grid === 'threading' && state.lockThreading) ||
      (hit.grid === 'tieup' && state.lockTieup)) {
    $('#brushHint').textContent = hit.grid === 'threading' ? '穿综已锁定：仅可修改踩踏序列与色带。'
                                                           : '联结已锁定：仅可修改踩踏序列与色带。';
    return;
  }

  pushHistory();
  const erase = ev.button === 2;
  state.gesture = { type: 'paint', pointerId: ev.pointerId, erase, last: null };
  applyPaint(hit, erase);
  afterEdit();
}

function onPointerMove(ev) {
  const hit = eventCell(ev);
  state.hover = hit;
  updateHoverInfo();

  const g = state.gesture;
  if (!g || g.pointerId !== ev.pointerId) return;

  if (g.type === 'pan') {
    const vp = $('#viewport');
    vp.scrollLeft -= ev.clientX - g.x;
    vp.scrollTop -= ev.clientY - g.y;
    g.x = ev.clientX; g.y = ev.clientY;
    return;
  }
  if (!hit) return;

  if (g.type === 'select') {
    const sel = state.selection;
    if (sel.grid !== hit.grid) return;
    sel.r1 = hit.r; sel.c1 = hit.c;
    normalizeSelection();
    updateSelectionButtons();
    return;
  }
  if (g.type === 'paint') {
    if (!['threading', 'treadling', 'tieup', 'warpband', 'weftband'].includes(hit.grid)) return;
    if (hit.grid !== g.lastGrid) return;   // 拖动只在同一图区内填充
    if (sameCell(hit, g.last)) return;
    if ((hit.grid === 'threading' && state.lockThreading) ||
        (hit.grid === 'tieup' && state.lockTieup)) return;
    applyPaint(hit, g.erase);
    g.last = { r: hit.r, c: hit.c };
    afterEdit();
  }
}

function onPointerUp(ev) {
  const g = state.gesture;
  if (!g || g.pointerId !== ev.pointerId) return;
  if (g.type === 'select') { normalizeSelection(); updateSelectionButtons(); }
  state.gesture = null;
  $('#viewport').classList.remove('panning');
}

function startPan(ev) {
  ev.preventDefault();
  state.gesture = { type: 'pan', pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY };
  $('#viewport').classList.add('panning');
}

const sameCell = (a, b) => !b ? false : a.grid === b.grid && a.r === b.r && a.c === b.c;

function normalizeSelection() {
  const s = state.selection;
  const r0 = Math.min(s.r0, s.r1), r1 = Math.max(s.r0, s.r1);
  const c0 = Math.min(s.c0, s.c1), c1 = Math.max(s.c0, s.c1);
  Object.assign(s, { r0, c0, r1, c1 });
}

/* 涂绘赋值 */
function applyPaint(hit, erase) {
  const d = state.draft;
  state.gesture.last = { r: hit.r, c: hit.c };
  state.gesture.lastGrid = hit.grid;
  switch (hit.grid) {
    case 'threading':
      d.threading[hit.c] = erase ? -1 : hit.r;
      break;
    case 'tieup': {
      if (!state.gesture.initDone) {
        state.gesture.value = erase ? false : !d.tieup[hit.r][hit.c];
        state.gesture.initDone = true;
      }
      d.tieup[hit.r][hit.c] = state.gesture.value;
      break;
    }
    case 'treadling':
      d.treadling[hit.r] = erase ? -1 : hit.c;
      break;
    case 'warpband':
      d.warpColor[hit.c] = erase ? 0 : state.selectedColor;
      break;
    case 'weftband':
      d.weftColor[hit.r] = erase ? 0 : state.selectedColor;
      break;
  }
}

/* 梭道点击：左键循环分配梭子（入梭边按推演停放边自动给定），右键清除 */
function handleShuttleTrackClick(hit, erase) {
  const d = state.draft, sh = d.shuttles;
  if (!sh) return;
  const p = hit.r;
  if (sh.locked[p]) { toast(`第 ${p + 1} 纬已锁定（已织），不可改梭`); return; }
  pushHistory();
  if (erase) {
    sh.picks[p] = null;
  } else {
    const cur = sh.picks[p];
    const nextS = cur == null ? 0 : (cur.s + 1 >= sh.count ? null : cur.s + 1);
    if (nextS === null) {
      sh.picks[p] = null;
    } else {
      // 该梭在第 p 纬前的停放边 = 上次离场边（从未使用则为初始停放边）
      const sp = state.analysis && state.analysis.shuttle;
      const enter = sp ? (p > 0 ? sp.parked[p - 1][nextS] : sp.home[nextS]) : sh.home[nextS];
      sh.picks[p] = { s: nextS, enter, join: cur && cur.s === nextS ? cur.join : null };
    }
  }
  afterEdit();
  const a = sh.picks[p];
  toast(a ? `第 ${p + 1} 纬 → 梭${a.s + 1}（${a.enter === 'L' ? '左' : '右'}入）` : `第 ${p + 1} 纬已清除梭子`);
}

/* ------------------------------- 撤销 / 重做 -------------------------- */
function pushHistory() {
  state.history.push(deepClone(state.draft));
  if (state.history.length > 60) state.history.shift();
  state.future.length = 0;
}

function undo() {
  if (!state.history.length) return;
  state.future.push(deepClone(state.draft));
  state.draft = state.history.pop();
  state.selection = null;
  afterStructural();
  toast('已撤销');
}

function redo() {
  if (!state.future.length) return;
  state.history.push(deepClone(state.draft));
  state.draft = state.future.pop();
  state.selection = null;
  afterStructural();
  toast('已重做');
}

/* ------------------------------- 选区操作 ----------------------------- */
function selectedBooleanMatrix() {
  const sel = state.selection;
  if (!sel) return null;
  const d = state.draft;
  const rows = sel.r1 - sel.r0 + 1, cols = sel.c1 - sel.c0 + 1;
  const m = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const pr = sel.r0 + r, pc = sel.c0 + c;
      if (sel.grid === 'tieup') m[r][c] = d.tieup[pr][pc] ? 1 : 0;
      else if (sel.grid === 'threading') m[r][c] = d.threading[pc] === pr ? 1 : 0;
      else if (sel.grid === 'treadling') m[r][c] = d.treadling[pr] === pc ? 1 : 0;
    }
  return { grid: sel.grid, rows, cols, matrix: m };
}

function copySelection() {
  const m = selectedBooleanMatrix();
  if (!m) return;
  state.clipboard = m;
  toast(`已复制 ${m.grid} 区域 ${m.cols}×${m.rows}`);
  updateSelectionButtons();
}

function pasteClipboard() {
  const hit = state.hover, clip = state.clipboard;
  if (!clip) { toast('剪贴板为空'); return; }
  let anchor;
  if (hit && hit.grid === clip.grid) anchor = { r: Math.max(0, hit.r), c: Math.max(0, hit.c) };
  else if (state.selection && state.selection.grid === clip.grid)
    anchor = { r: state.selection.r0, c: state.selection.c0 };
  else { toast(`请把指针悬停到${gridName(clip.grid)}区域以选择粘贴起点`); return; }

  if ((clip.grid === 'threading' && state.lockThreading) ||
      (clip.grid === 'tieup' && state.lockTieup)) { toast('该区域已锁定'); return; }

  pushHistory();
  writeBooleanMatrix(clip, anchor.r, anchor.c);
  state.selection = { grid: clip.grid, r0: anchor.r, c0: anchor.c,
                      r1: Math.min(anchor.r + clip.rows - 1, dimsOf(clip.grid).rows - 1),
                      c1: Math.min(anchor.c + clip.cols - 1, dimsOf(clip.grid).cols - 1) };
  afterStructural();
  updateSelectionButtons();
  toast('已粘贴');
}

function dimsOf(grid) {
  const d = state.draft;
  if (grid === 'threading') return { rows: d.shafts, cols: d.ends };
  if (grid === 'tieup') return { rows: d.shafts, cols: d.treadles };
  if (grid === 'treadling') return { rows: d.picks, cols: d.treadles };
  return { rows: 1, cols: 1 };
}

function gridName(g) {
  return { threading: '穿综', tieup: '联结', treadling: '踩踏' }[g] || g;
}

function writeBooleanMatrix(clip, r0, c0) {
  const d = state.draft;
  const dim = dimsOf(clip.grid);
  for (let r = 0; r < clip.rows; r++)
    for (let c = 0; c < clip.cols; c++) {
      const pr = r0 + r, pc = c0 + c;
      if (pr >= dim.rows || pc >= dim.cols) continue;
      if (clip.grid === 'tieup') d.tieup[pr][pc] = !!clip.matrix[r][c];
    }
  if (clip.grid === 'threading') {
    for (let c = 0; c < clip.cols; c++) {
      const pc = c0 + c;
      if (pc >= d.ends) continue;
      let val = -1;
      for (let r = clip.rows - 1; r >= 0; r--)
        if (clip.matrix[r][c]) { val = r0 + r; break; }
      d.threading[pc] = val >= d.shafts ? -1 : val;
    }
  } else if (clip.grid === 'treadling') {
    for (let r = 0; r < clip.rows; r++) {
      const pr = r0 + r;
      if (pr >= d.picks) continue;
      let val = -1;
      for (let c = 0; c < clip.cols; c++)
        if (clip.matrix[r][c]) { val = c0 + c; break; }
      d.treadling[pr] = val >= d.treadles ? -1 : val;
    }
  }
}

function mirrorSelection(axis) {
  const sel = state.selection;
  if (!sel) return;
  // 锁定的区域不得被镜像改动（色带不属于穿综，不受穿综锁影响）
  if (sel.grid === 'threading' && state.lockThreading) { toast('穿综已锁定：镜像未改动穿综数据'); return; }
  if (sel.grid === 'tieup' && state.lockTieup) { toast('联结已锁定：镜像未改对联结数据'); return; }
  const clip = selectedBooleanMatrix();
  const m = clip.matrix;
  const out = m.map(row => row.slice());
  if (axis === 'h') m.forEach((row, r) => row.forEach((v, c) => { out[r][row.length - 1 - c] = v; }));
  else m.forEach((row, r) => row.forEach((v, c) => { out[m.length - 1 - r][c] = v; }));
  pushHistory();
  writeBooleanMatrix({ ...clip, matrix: out }, sel.r0, sel.c0);
  // 色带镜像 = 颜色顺序反转
  const d = state.draft;
  if (sel.grid === 'warpband' && axis === 'h') {
    const saved = d.warpColor.slice(sel.c0, sel.c1 + 1);
    saved.reverse().forEach((v, i) => d.warpColor[sel.c0 + i] = v);
  }
  if (sel.grid === 'weftband' && axis === 'v') {
    const saved = d.weftColor.slice(sel.r0, sel.r1 + 1);
    saved.reverse().forEach((v, i) => d.weftColor[sel.r0 + i] = v);
  }
  afterStructural();
  toast(axis === 'h' ? '已左右镜像' : '已上下镜像');
}

function clearSelectionCells() {
  const sel = state.selection;
  if (!sel) return;
  const d = state.draft;
  if ((sel.grid === 'threading' && state.lockThreading) ||
      (sel.grid === 'tieup' && state.lockTieup)) { toast('该区域已锁定'); return; }
  pushHistory();
  for (let r = sel.r0; r <= sel.r1; r++)
    for (let c = sel.c0; c <= sel.c1; c++) {
      if (sel.grid === 'tieup') d.tieup[r][c] = false;
      else if (sel.grid === 'threading' && d.threading[c] === r) d.threading[c] = -1;
      else if (sel.grid === 'treadling' && d.treadling[r] === c) d.treadling[r] = -1;
      else if (sel.grid === 'warpband') d.warpColor[c] = 0;
      else if (sel.grid === 'weftband') d.weftColor[r] = 0;
    }
  afterEdit();
  toast('选区已清除（穿综/踩踏清除后将报“越界”，重新涂绘即可）');
}

function updateSelectionButtons() {
  const sel = state.selection;
  const has = !!sel;
  $('#btnCopy').disabled = !has;
  $('#btnMirrorH').disabled = !has;
  $('#btnMirrorV').disabled = !has;
  $('#btnClearSel').disabled = !has;
  $('#btnPaste').disabled = !state.clipboard;
}

/* ------------------------------- 数据变更后的级联 --------------------- */
function afterEdit() {
  state.dirty = true;
  state.analysis = Engine.analyze(state.draft);
  drawBase();
  refreshIssues();
  refreshStats();
  refreshPreviews();
  refreshCompareIfActive();
  if (window.__shuttleRefresh) window.__shuttleRefresh();
  if (window.__dobbyRefresh) window.__dobbyRefresh();
  if (window.__dlRefresh) window.__dlRefresh();
  scheduleAutosave();
}

function afterStructural() {
  syncInputs();
  state.analysis = Engine.analyze(state.draft);
  resizeCanvases();
  drawBase();
  refreshIssues();
  refreshStats();
  refreshPreviews();
  refreshTreadleBrush();
  refreshCompareIfActive();
  if (window.__shuttleRefresh) window.__shuttleRefresh();
  if (window.__dobbyRefresh) window.__dobbyRefresh();
  if (window.__dlRefresh) window.__dlRefresh();
  scheduleAutosave();
}

/* ------------------------------- 参数 / 模板 -------------------------- */
function applyDimensions(push = true) {
  const shafts = clamp(parseInt($('#numShafts').value, 10) || 1, 1, 24);
  const treadles = clamp(parseInt($('#numTreadles').value, 10) || 1, 1, 24);
  const ends = clamp(parseInt($('#numEnds').value, 10) || 1, 1, 200);
  const picks = clamp(parseInt($('#numPicks').value, 10) || 1, 1, 200);
  const maxFloat = clamp(parseInt($('#maxFloat').value, 10) || 1, 1, 200);
  if (push) pushHistory();
  state.draft = Engine.resize(state.draft, { shafts, treadles, ends, picks });
  state.draft.maxFloat = maxFloat;
  afterStructural();
  toast('尺寸已应用');
}

function syncInputs() {
  const d = state.draft;
  $('#numShafts').value = d.shafts;
  $('#numTreadles').value = d.treadles;
  $('#numEnds').value = d.ends;
  $('#numPicks').value = d.picks;
  $('#maxFloat').value = d.maxFloat;
}

function loadDraft(d, name, id) {
  stopPlay();
  state.draft = normalizeDraft(d);   // 旧草稿可能缺多梭等新字段，先补齐
  state.savedId = id ?? null;
  if (name) $('#draftName').value = name;
  state.history.length = 0;
  state.future.length = 0;
  state.selection = null;
  state.clipboard = null;
  state.lockThreading = $('#lockThreading').checked = false;
  state.lockTieup = $('#lockTieup').checked = false;  state.compareB = null;
  $('#cmpSource').value = '';
  $('#cmpResult').innerHTML = '<p class="hint">将当前草稿与已保存方案并排比较。</p>';
  afterStructural();
}

function makeTemplate(kind) {
  const d = state.draft;
  const E = d.ends, P = d.picks;
  let nd;
  if (kind === 'plain') {
    nd = Engine.resize(Engine.blankDraft(2, 2, E, P), { shafts: 2, treadles: 2, ends: E, picks: P });
    nd.threading = Array.from({ length: E }, (_, i) => i % 2);
    nd.treadling = Array.from({ length: P }, (_, i) => i % 2);
    nd.tieup = [[true, false], [false, true]];
    nd.maxFloat = 1;
  } else if (kind === 'twill') {
    nd = Engine.resize(Engine.defaultDraft(), { shafts: 4, treadles: 4, ends: E, picks: P });
    nd.threading = Array.from({ length: E }, (_, i) => i % 4);
    nd.treadling = Array.from({ length: P }, (_, i) => i % 4);
    nd.maxFloat = 3;
  } else if (kind === 'basket') {
    // 2/2 方平：2 综框 × 2 踏板
    nd = Engine.resize(Engine.blankDraft(2, 2, E, P), { shafts: 2, treadles: 2, ends: E, picks: P });
    nd.threading = Array.from({ length: E }, (_, i) => Math.floor(i / 2) % 2);
    nd.treadling = Array.from({ length: P }, (_, i) => Math.floor(i / 2) % 2);
    nd.tieup = [[true, false], [false, true]];
    nd.maxFloat = 3;
  } else if (kind === 'satin') {
    nd = Engine.resize(Engine.blankDraft(5, 5, E, P), { shafts: 5, treadles: 5, ends: E, picks: P });
    nd.threading = Array.from({ length: E }, (_, i) => i % 5);
    nd.treadling = Array.from({ length: P }, (_, i) => i % 5);
    // 五枚缎（飞数 2）
    nd.tieup = Array.from({ length: 5 }, (_, s) =>
      Array.from({ length: 5 }, (_, t) => s === (t * 2 % 5)));
    nd.maxFloat = 5;
  } else if (kind === 'clear') {
    nd = Engine.blankDraft(d.shafts, d.treadles, E, P);
    nd.maxFloat = d.maxFloat;
    nd.palette = d.palette.map(c => ({ ...c }));
  }
  return nd;
}

function applyTemplate(kind) {
  pushHistory();
  state.draft = makeTemplate(kind);
  afterStructural();
  toast({ plain: '平纹', twill: '2/2 斜纹', basket: '方平组织', satin: '五枚缎', clear: '已清空' }[kind] + ' 模板');
}

/* ------------------------------- 色板 --------------------------------- */
function buildPalette() {
  const el = $('#palette');
  el.innerHTML = '';
  state.draft.palette.forEach((c, i) => {
    const s = document.createElement('div');
    s.className = 'swatch' + (i === state.selectedColor ? ' sel' : '');
    s.style.background = c.hex;
    s.textContent = i + 1;
    s.title = `色号 ${i + 1}：${c.name}`;
    s.addEventListener('click', () => {
      state.selectedColor = i;
      buildPalette();
    });
    el.appendChild(s);
  });
}

function applyBandFill(axis) {
  pushHistory();
  const d = state.draft;
  if (axis === 'warp') d.warpColor = new Array(d.ends).fill(state.selectedColor);
  else d.weftColor = new Array(d.picks).fill(state.selectedColor);
  afterEdit();
  toast(axis === 'warp' ? '经线带已整带涂色' : '纬线带已整带涂色');
}

function refreshTreadleBrush() {
  const el = $('#treadleBrush');
  el.innerHTML = '';
  const d = state.draft;
  for (let t = 0; t < d.treadles; t++) {
    const dot = document.createElement('div');
    dot.className = 'brush-dot';
    dot.style.background = shaftColor(t, d.treadles);
    dot.textContent = t + 1;
    dot.title = `踏板 ${t + 1}（在踩踏区点行即可涂绘）`;
    el.appendChild(dot);
  }
}

/* ------------------------------- 校验问题列表 ------------------------- */
function refreshIssues() {
  const v = state.analysis.validation;
  const ul = $('#issueList');
  ul.innerHTML = '';
  const badge = $('#issueCount');
  badge.textContent = v.errors + v.warns;
  badge.className = 'badge' + (v.errors === 0 && v.warns === 0 ? ' ok' : v.errors === 0 ? ' warn' : '');

  if (!v.issues.length) {
    const li = document.createElement('li');
    li.className = 'all-good';
    li.textContent = '✓ 未发现越界、空踏板、未交织或过长浮线问题';
    ul.appendChild(li);
    state.activeIssue = -1;
    return;
  }
  v.issues.forEach((iss, i) => {
    const li = document.createElement('li');
    if (iss.level === 'warn') li.classList.add('warn');
    const tag = iss.level === 'warn' ? '⚠' : '✗';
    li.innerHTML = `<div>${tag} ${iss.msg}</div>`;
    li.addEventListener('click', () => focusIssue(i));
    ul.appendChild(li);
  });
}

function focusIssue(i) {
  state.activeIssue = i;
  const iss = state.analysis.validation.issues[i];
  const loc = iss.loc.find(l => {
    const R = state.layout.regions[l.grid];
    return R && (l.r >= 0 || l.c >= 0);
  });
  if (loc) {
    const R = state.layout.regions[loc.grid];
    const bx = loc.c < 0 ? R.x0 + R.w / 2 : R.x0 + loc.c * CELL + CELL / 2;
    const by = loc.r < 0 ? R.y0 + R.h / 2 : R.y0 + loc.r * CELL + CELL / 2;
    const vp = $('#viewport');
    vp.scrollTo({
      left: bx * state.zoom - vp.clientWidth / 2 + 26,
      top: by * state.zoom - vp.clientHeight / 2 + 26,
      behavior: 'smooth',
    });
  }
  state.flashUntil = performance.now() + 2400;
}

/* ------------------------------- 外部模块定位 ------------------------- */
/**
 * 供“试织缺陷回标”“上机工艺单”等模块调用：关闭弹窗后在主图板定位组织位置。
 * loc: { grid:'threading'|'tieup'|'treadling'|'drawdown', r, c, c1? }
 * r 或 c 为 -1 / null 表示整列 / 整行高亮；c1 表示 c..c1 的连续列区段。
 */
function locateCell(loc) {
  const L = state.layout;
  const R = L.regions[loc.grid];
  if (!R) return;
  // 关闭所有模态
  $$('.modal').forEach(m => m.classList.add('hidden'));
  state.activeIssue = -1;
  const c0 = loc.c ?? -1;
  const c1 = (loc.c1 != null && c0 >= 0) ? Math.max(c0, Math.min(loc.c1, (R.cols || 1) - 1)) : null;
  state.locateFlash = {
    grid: loc.grid, r: loc.r ?? -1, c: c0, c1, until: performance.now() + 4000,
  };
  const cx = c0 >= 0
    ? R.x0 + (c1 != null ? (c0 + c1 + 1) / 2 : c0 + 0.5) * CELL
    : R.x0 + R.w / 2;
  const cy = loc.r != null && loc.r >= 0 ? R.y0 + loc.r * CELL + CELL / 2 : R.y0 + R.h / 2;
  const vp = $('#viewport');
  vp.scrollTo({
    left: cx * state.zoom - vp.clientWidth / 2 + 26,
    top: cy * state.zoom - vp.clientHeight / 2 + 26,
    behavior: 'smooth',
  });
}

/* ------------------------------- 统计 / 预览 -------------------------- */
function refreshStats() {
  const a = state.analysis, d = state.draft, r = a.rep;
  $('#statText').textContent =
    `最小循环：经 ${r.warp} 根 × 纬 ${r.weft} 梭` +
    (r.hasNull ? '（含缺失格，循环仅供参考）' : '') +
    `\n穿综周期 ${r.threadingP}　踩踏周期 ${r.treadlingP}　色经周期 ${r.warpColorP}　色纬周期 ${r.weftColorP}` +
    `\n最长经浮长 ${a.stats.maxWarpFloat} 根纬　最长纬浮长 ${a.stats.maxWeftFloat} 根经　限值 ${d.maxFloat}` +
    `\n交织点 ${a.stats.interlacePoints}　缺失格 ${a.stats.missing}`;
}

function drawRepeatPreview(cvs, side) {
  const d = state.draft, A = state.analysis, r = A.rep;
  const ctx = cvs.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cvs.width, cvs.height);
  const W = Math.max(1, r.hasNull ? d.ends : r.warp);
  const H = Math.max(1, r.hasNull ? d.picks : r.weft);
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const octx = off.getContext('2d');
  const cg = Engine.colorGrid(d, A.derived, side);
  for (let p = 0; p < H; p++)
    for (let e = 0; e < W; e++) {
      octx.fillStyle = cg[p % d.picks][e % d.ends] || '#e9e2d2';
      octx.fillRect(e, p, 1, 1);
    }
  const scale = Math.max(1, Math.floor(Math.min(cvs.width / W, cvs.height / H)));
  const dw = W * scale, dh = H * scale;
  ctx.drawImage(off, 0, 0, dw, dh);
}

function refreshPreviews() {
  drawRepeatPreview($('#frontPreview'), 'front');
  drawRepeatPreview($('#backPreview'), 'back');
}

/* ------------------------------- 悬停信息 ----------------------------- */
function updateHoverInfo() {
  const h = state.hover, d = state.draft;
  const el = $('#playInfo');
  if (state.playing) return;
  if (!h) { el.textContent = '未播放'; return; }
  const map = {
    threading: () => {
      const s = d.threading[h.c];
      return `穿综：第 ${h.c + 1} 根经${s >= 0 ? ` → 综框 ${s + 1}` : '（未穿/越界）'}`;
    },
    tieup: () => `联结：综框 ${h.r + 1} × 踏板 ${h.c + 1}：${d.tieup[h.r][h.c] ? '联结' : '空'}`,
    treadling: () => {
      const t = d.treadling[h.r];
      return `踩踏：第 ${h.r + 1} 纬${t >= 0 ? ` → 踏板 ${t + 1}` : '（未踩踏）'}`;
    },
    drawdown: () => {
      const v = state.analysis.derived.drawdown[h.r][h.c];
      return `组织图：第 ${h.r + 1} 纬 × 第 ${h.c + 1} 经：${v === null ? '缺失' : v === 1 ? '经在上' : '纬在上'}`;
    },
    warpband: () => `经色带：第 ${h.c + 1} 根经 → 色号 ${d.warpColor[h.c] + 1} ${d.palette[d.warpColor[h.c]].name}`,
    weftband: () => `纬色带：第 ${h.r + 1} 纬 → 色号 ${d.weftColor[h.r] + 1} ${d.palette[d.weftColor[h.r]].name}`,
    shuttletrack: () => {
      const sh = d.shuttles;
      if (!sh) return '梭道（多梭布边）';
      const a = sh.picks[h.r];
      const base = `梭道：第 ${h.r + 1} 纬`;
      if (!a) return base + ' 未指定梭子（左键循环分配，右键清除）';
      const jn = a.join ? JOIN_NAMES[a.join] : '无';
      return base + ` → 梭${a.s + 1}，${a.enter === 'L' ? '左入右行' : '右入左行'}，交接 ${jn}` +
        (sh.locked[h.r] ? '，已锁定' : '');
    },
  };
  el.textContent = map[h.grid] ? map[h.grid]() : '';
}

/* ------------------------------- 播放 --------------------------------- */
function startPlay() {
  if (state.playing) { stopPlay(); return; }
  state.playing = true;
  state.stepHold = false;
  state.playPick = clamp(state.playPick, 0, state.draft.picks - 1);
  $('#btnPlay').textContent = '⏸ 暂停';
  updatePlayInfo();
  scheduleStep();
}

function scheduleStep() {
  clearTimeout(state.playTimer);
  const interval = 1400 / Number($('#playSpeed').value || 3);
  state.playTimer = setTimeout(() => {
    if (!state.playing || state.stepHold) return;
    state.playPick++;
    if (state.playPick >= state.draft.picks) { stopPlay(); return; }
    updatePlayInfo();
    scheduleStep();
  }, interval);
}

function stopPlay() {
  state.playing = false;
  state.stepHold = false;
  clearTimeout(state.playTimer);
  $('#btnPlay').textContent = '▶ 播放';
  updatePlayInfo();
}

function stepPick(delta) {
  clearTimeout(state.playTimer);
  state.stepHold = true;
  state.playing = true;              // 单步也显示高亮
  state.playPick = clamp(state.playPick + delta, 0, state.draft.picks - 1);
  $('#btnPlay').textContent = '▶ 播放';
  updatePlayInfo();
}

function updatePlayInfo() {
  const d = state.draft, p = state.playPick, A = state.analysis;
  const dobbyOn = !!(d.dobby && d.dobby.enabled);
  const t = d.treadling[p];
  const lifted = [...A.derived.lifted[p]].map(s => s + 1).join('、') || '无';
  let shTxt = '';
  const sp = A.shuttle, sh = d.shuttles;
  if (sp && sp.active && sh) {
    const row = sp.rows[p];
    if (row) {
      const cname = (d.palette[sh.colors[row.shuttle]] || {}).name || '';
      shTxt = `　梭子 <b>${row.shuttle + 1} ${cname}</b> ${row.enter === 'L' ? '左→右' : '右→左'}` +
        (row.join ? ` · ${JOIN_NAMES[row.join]}` : '');
    } else {
      shTxt = '　梭子 <b>未指定</b>';
    }
    const before = p > 0 ? sp.parked[p - 1] : sp.home;
    const parks = [];
    for (let k = 0; k < sh.count; k++) {
      if (row && row.shuttle === k) continue;
      parks.push(`梭${k + 1}@${before[k] === 'L' ? '左' : '右'}`);
    }
    if (parks.length) shTxt += `　停放：${parks.join(' ')}`;
  }
  $('#playInfo').innerHTML =
    `第 <b>${p + 1}</b>/${d.picks} 纬　` +
    (dobbyOn ? '升综 <b>多臂</b>' : `踏板 <b>${t >= 0 ? t + 1 : '—'}</b>`) +
    `　升起综框：<b>${lifted}</b>${shTxt}`;
}

/* ------------------------------- 缩放 / 平移 -------------------------- */
function setZoom(z, center) {
  const vp = $('#viewport');
  const old = state.zoom;
  state.zoom = clamp(z, .25, 2.5);
  if (center) {
    const bx = (vp.scrollLeft + vp.clientWidth / 2 - 26) / old;
    const by = (vp.scrollTop + vp.clientHeight / 2 - 26) / old;
    resizeCanvases();
    requestAnimationFrame(() => {
      vp.scrollLeft = bx * state.zoom - vp.clientWidth / 2 + 26;
      vp.scrollTop = by * state.zoom - vp.clientHeight / 2 + 26;
    });
  } else resizeCanvases();
  $('#zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
}

function zoomFit() {
  const L = state.layout, vp = $('#viewport');
  const z = clamp(Math.min((vp.clientWidth - 90) / L.W, (vp.clientHeight - 90) / L.H), .25, 1.5);
  setZoom(z);
  requestAnimationFrame(() => {
    vp.scrollLeft = (L.W * z - vp.clientWidth) / 2 + 26;
    vp.scrollTop = (L.H * z - vp.clientHeight) / 2 + 26;
  });
}

/* ------------------------------- 方案比较 ----------------------------- */
async function refreshCompareOptions() {
  const sel = $('#cmpSource');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— 选择已保存方案 —</option>';
  try {
    const list = await api('GET', '/api/drafts');
    list.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name;
      sel.appendChild(opt);
    });
    if (prev) sel.value = prev;
  } catch (e) { /* 离线库不可用时忽略 */ }
}

async function runCompare() {
  const id = $('#cmpSource').value;
  const box = $('#cmpResult');
  if (!id) { state.compareB = null; box.innerHTML = '<p class="hint">将当前草稿与已保存方案并排比较。</p>'; return; }
  let saved;
  try { saved = await api('GET', `/api/drafts/${id}`); }
  catch { box.innerHTML = '<p class="hint">无法读取该草稿。</p>'; return; }
  // 缓存方案 B：编辑当前方案后无需重新请求即可重算比较
  state.compareB = { id: saved.id, name: saved.name, data: saved.data };
  if (String($('#cmpSource').value) === String(saved.id)) renderCompare();
}

/** 当前方案被修改后，若比较面板已选方案 B，则基于缓存实时重算（轻量防抖）。 */
function refreshCompareIfActive() {
  if (!state.compareB) return;
  clearTimeout(refreshCompareIfActive._t);
  refreshCompareIfActive._t = setTimeout(() => {
    if (state.compareB &&
        String($('#cmpSource').value) === String(state.compareB.id)) {
      renderCompare();
    }
  }, 150);
}

function renderCompare() {
  const b = state.compareB;
  const box = $('#cmpResult');
  if (!b) { box.innerHTML = '<p class="hint">将当前草稿与已保存方案并排比较。</p>'; return; }
  // 比较选择器已切换到别的草稿时不覆盖
  if (String($('#cmpSource').value) !== String(b.id)) return;
  const r = Engine.compare(state.draft, b.data);
  const same = r.diffs === 0 &&
    r.repeatA.warp === r.repeatB.warp && r.repeatA.weft === r.repeatB.weft &&
    r.floatA.warp === r.floatB.warp && r.floatA.weft === r.floatB.weft;
  box.innerHTML = `
    <table>
      <tr><th></th><th>A 当前</th><th>B ${b.name}</th></tr>
      <tr><td>循环（经×纬）</td><td>${r.repeatA.warp}×${r.repeatA.weft}</td><td>${r.repeatB.warp}×${r.repeatB.weft}</td></tr>
      <tr><td>最长经浮</td><td>${r.floatA.warp}</td><td>${r.floatB.warp}</td></tr>
      <tr><td>最长纬浮</td><td>${r.floatA.weft}</td><td>${r.floatB.weft}</td></tr>
      <tr><td colspan="3">LCM 平铺 ${r.lcm.w}×${r.lcm.h}，采样 ${r.sampleW}×${r.sampleH}${r.capReached ? '（已限采样）' : ''}</td></tr>
      <tr><td colspan="3">交织点差异 <b style="color:${r.diffs ? '#b3352a' : '#4a7c59'}">${r.diffs}</b> / ${r.total} 格（${(r.diffRate * 100).toFixed(1)}%）${same ? '　✓ 两方案等效' : ''}</td></tr>
    </table>
    <div class="diff-pix">
      <div><div class="stat-title">A 采样（差异标红）</div><canvas id="diffA" width="120" height="80"></canvas></div>
      <div><div class="stat-title">B 采样（差异标红）</div><canvas id="diffB" width="120" height="80"></canvas></div>
    </div>`;
  drawDiffCanvas($('#diffA'), r, 'A');
  drawDiffCanvas($('#diffB'), r, 'B');
}

function drawDiffCanvas(cvs, r, side) {
  const ctx = cvs.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const grid = side === 'A' ? r.gridA : r.gridB;
  const d = side === 'A'
    ? { palette: r.paletteA, warpColor: r.warpColorA, weftColor: r.weftColorA }
    : { palette: r.paletteB, warpColor: r.warpColorB, weftColor: r.weftColorB };
  const off = document.createElement('canvas');
  off.width = r.sampleW; off.height = r.sampleH;
  const o = off.getContext('2d');
  for (let p = 0; p < r.sampleH; p++)
    for (let e = 0; e < r.sampleW; e++) {
      const v = grid[p][e];
      const diff = r.gridA[p][e] !== r.gridB[p][e];
      if (diff) o.fillStyle = '#e0352a';
      else if (v === null) o.fillStyle = '#ddd';
      else {
        // A、B 均按「正面」采样：值 1 恒为经在上。两侧须一致，B 不能取反。
        const warpUp = v === 1;
        const idx = warpUp ? d.warpColor[e % d.warpColor.length] : d.weftColor[p % d.weftColor.length];
        o.fillStyle = (d.palette[idx] || { hex: '#888' }).hex;
      }
      o.fillRect(e, p, 1, 1);
    }
  const sc = Math.max(1, Math.floor(Math.min(cvs.width / r.sampleW, cvs.height / r.sampleH)));
  ctx.drawImage(off, 0, 0, r.sampleW * sc, r.sampleH * sc);
}

/* ------------------------------- SQLite 草稿 API ---------------------- */
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
  return res.json();
}

async function saveDraft() {
  const name = $('#draftName').value.trim() || '未命名草稿';
  try {
    const r = await api('POST', '/api/drafts', { id: state.savedId, name, data: state.draft });
    state.savedId = r.id;
    $('#draftName').value = r.name;
    state.dirty = false;
    toast(`已保存到本地草稿库（#${r.id}）`);
    refreshCompareOptions();
  } catch (e) {
    toast('保存失败：' + e.message, 3000);
  }
}

async function openDrafts() {
  const tbody = $('#draftRows');
  tbody.innerHTML = '<tr><td colspan="3" class="hint">读取中…</td></tr>';
  $('#draftModal').classList.remove('hidden');
  let list;
  try { list = await api('GET', '/api/drafts'); }
  catch { tbody.innerHTML = '<tr><td colspan="3" class="hint">无法连接本地服务。</td></tr>'; return; }
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="hint">草稿箱为空，先点击右上角“保存草稿”。</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  list.forEach(d => {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = d.name;
    const tdTime = document.createElement('td');
    tdTime.textContent = d.updated_at.replace('T', ' ');
    const tdAct = document.createElement('td');
    tdAct.innerHTML = '<div class="row-actions"></div>';
    const btnLoad = document.createElement('button');
    btnLoad.className = 'btn tiny';
    btnLoad.textContent = '打开';
    btnLoad.onclick = async () => {
      const full = await api('GET', `/api/drafts/${d.id}`);
      loadDraft(full.data, full.name, full.id);
      $('#draftModal').classList.add('hidden');
      toast(`已打开「${full.name}」`);
    };
    const btnCmp = document.createElement('button');
    btnCmp.className = 'btn tiny';
    btnCmp.textContent = '选为方案B';
    btnCmp.onclick = () => {
      $('#cmpSource').value = d.id;
      $('#draftModal').classList.add('hidden');
      runCompare();
    };
    const btnDel = document.createElement('button');
    btnDel.className = 'btn tiny';
    btnDel.textContent = '删除';
    btnDel.onclick = async () => {
      if (!confirm(`确定删除草稿「${d.name}」？`)) return;
      await api('DELETE', `/api/drafts/${d.id}`);
      if (state.savedId === d.id) state.savedId = null;
      openDrafts();
      refreshCompareOptions();
    };
    tdAct.firstChild.append(btnLoad, btnCmp, btnDel);
    tr.append(tdName, tdTime, tdAct);
    tbody.appendChild(tr);
  });
}

/* ------------------------------- 本地自动保存 ------------------------- */
function scheduleAutosave() {
  clearTimeout(scheduleAutosave._t);
  scheduleAutosave._t = setTimeout(() => {
    try {
      localStorage.setItem('loom_autosave', JSON.stringify({
        name: $('#draftName').value, data: state.draft, t: Date.now(),
      }));
    } catch (e) {}
  }, 800);
}

function restoreAutosave() {
  try {
    const raw = localStorage.getItem('loom_autosave');
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (!s || !s.data || !Array.isArray(s.data.threading)) return false;
    state.draft = normalizeDraft(s.data);
    if (s.name) $('#draftName').value = s.name;
    return true;
  } catch (e) { return false; }
}

/* 旧版本数据补齐 */
function normalizeDraft(d) {
  const base = Engine.blankDraft(1, 1, 1, 1);
  const merged = { ...base, ...d };
  merged.palette = Array.isArray(d.palette) && d.palette.length ? d.palette : base.palette;
  merged.shuttles = Engine.normalizeShuttles(d.shuttles, merged.picks);
  // 升综计划按草稿实际纬数 × 综框数规整；旧草稿缺该字段时补“未启用”的默认矩阵
  merged.dobby = Engine.normalizeDobby(d.dobby, merged.picks, merged.shafts);
  // 双层配置按草稿实际经纬数规整；旧草稿缺该字段时补“未启用”的默认分层（可直接打开）
  merged.double = Engine.normalizeDouble(d.double, merged.ends, merged.picks);
  return merged;
}

/* ------------------------------- 打印 --------------------------------- */
function doPrint() {
  const d = state.draft, A = state.analysis;
  $('#printTitle').textContent = `${$('#draftName').value} — 手织组织图`;
  const r = A.rep;
  $('#printMeta').innerHTML =
    `打印时间：${new Date().toLocaleString()}<br>` +
    `综框 ${d.shafts}　踏板 ${d.treadles}　经线 ${d.ends}　纬线 ${d.picks}　允许最长浮线 ${d.maxFloat}<br>` +
    `最小循环：经 ${r.warp} × 纬 ${r.weft}　最长经浮长 ${A.stats.maxWarpFloat}　最长纬浮长 ${A.stats.maxWeftFloat}<br>` +
    `校验：错误 ${A.validation.errors}　警告 ${A.validation.warns}`;

  // 打印用小尺寸重绘到专用 canvas
  const PCELL = 16, PBAND = 10, PGAP = 14, PSTRIP = 20, PP = 72;
  const drawY = PP + d.shafts * PCELL + PGAP;
  const rightX = PP + d.ends * PCELL + PGAP;
  const pStripX = PP - PBAND - 6 - 6 - PSTRIP;
  const W = PP + (d.ends + d.shafts) * PCELL + PGAP + 40;
  const H = drawY + d.picks * PCELL + 40;
  const cvs = $('#printCanvas');
  cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  const printL = {
    stripX: pStripX, stripW: PSTRIP,
    regions: {
      threading: { x0: PP, y0: PP, cols: d.ends, rows: d.shafts, w: d.ends * PCELL, h: d.shafts * PCELL, cell: PCELL },
      tieup:     { x0: rightX, y0: PP, cols: d.treadles, rows: d.shafts, w: d.treadles * PCELL, h: d.shafts * PCELL, cell: PCELL },
      drawdown:  { x0: PP, y0: drawY, cols: d.ends, rows: d.picks, w: d.ends * PCELL, h: d.picks * PCELL, cell: PCELL },
      treadling: { x0: rightX, y0: drawY, cols: d.treadles, rows: d.picks, w: d.treadles * PCELL, h: d.picks * PCELL, cell: PCELL },
      warpband:  { x0: PP, y0: PP - PBAND - 6, cols: d.ends, rows: 1, w: d.ends * PCELL, h: PBAND, cell: PCELL, band: true, axis: 'warp' },
      weftband:  { x0: PP - PBAND - 6, y0: drawY, cols: 1, rows: d.picks, w: PBAND, h: d.picks * PCELL, cell: PCELL, band: true, axis: 'weft' },
    }, W, H,
  };
  state.layout = printL;
  // 在打印 canvas 上独立绘制
  drawPrintDraft(ctx, d, A, printL, PCELL, PBAND);

  // 恢复交互布局
  state.layout = computeLayout(d);
  resizeCanvases();

  // 色纱编号 + 穿综/踩踏序列 + 联结表
  const legend = $('#printLegend');
  let html = '<b>色纱编号：</b><br>';
  d.palette.forEach((c, i) => {
    html += `<span style="display:inline-block;margin-right:14px">
      <span style="display:inline-block;width:10px;height:10px;background:${c.hex};border:1px solid #555"></span>
      色号 ${i + 1} ${c.name}</span>`;
  });
  const seq = (arr, n) => arr.slice(0, n).map(v => v + 1).join(' ');
  html += `<br><br><b>穿综顺序（前 ${Math.min(d.ends, A.rep.threadingP)} 根循环）：</b> ${seq(d.threading, A.rep.threadingP)}`;
  html += `<br><b>踩踏序列（前 ${Math.min(d.picks, A.rep.treadlingP)} 纬循环）：</b> ${seq(d.treadling, A.rep.treadlingP)}`;
  html += '<br><b>踏板联结：</b><br>';
  for (let t = 0; t < d.treadles; t++) {
    const ss = [];
    for (let s = 0; s < d.shafts; s++) if (d.tieup[s][t]) ss.push(s + 1);
    html += `踏板 ${t + 1} → 综框 ${ss.length ? ss.join('、') : '（空！）'}<br>`;
  }

  // 多梭布边：梭子配置 + 按纬梭次 + 布边警告
  const sh = d.shuttles, sp = A.shuttle;
  if (sh && sp && sp.active) {
    html += `<br><b>多梭布边：</b>梭子 ${sh.count} 把　停放浮线上限 ${sh.parkLimit} 纬<br>`;
    for (let k = 0; k < sh.count; k++) {
      const c = d.palette[sh.colors[k]];
      html += `<span style="display:inline-block;margin-right:12px">
        <span style="display:inline-block;width:10px;height:10px;background:${c ? c.hex : '#888'};border:1px solid #555"></span>
        梭${k + 1} 色号${sh.colors[k] + 1} ${c ? c.name : ''}·初始停${sh.home[k] === 'L' ? '左' : '右'}边</span>`;
    }
    html += '<br><b>按纬梭次：</b>';
    const tokens = [];
    for (let p = 0; p < d.picks; p++) {
      const a = sh.picks[p];
      if (!a) { tokens.push(`${p + 1}:—`); continue; }
      tokens.push(`${p + 1}:${a.s + 1}${a.enter === 'L' ? '→' : '←'}${a.join ? JOIN_SHORT[a.join] : ''}` +
        (sh.locked[p] ? '🔒' : ''));
    }
    html += tokens.join(' ');
    const shIssues = A.validation.issues.filter(i => i.code.startsWith('shuttle-'));
    html += '<br><b>布边警告：</b>' + (shIssues.length
      ? shIssues.map(i => `${i.level === 'warn' ? '⚠' : '✗'} ${i.msg}`).join('<br>')
      : '无');
  }
  legend.innerHTML = html;

  setTimeout(() => window.print(), 120);
}

function drawPrintDraft(ctx, d, A, L, C, B) {
  const drawGrid = (R) => {
    ctx.strokeStyle = '#888';
    ctx.strokeRect(R.x0 + .5, R.y0 + .5, R.w - 1, R.h - 1);
    ctx.beginPath();
    for (let c = 1; c < R.cols; c++) {
      const x = R.x0 + c * C + .5; ctx.moveTo(x, R.y0); ctx.lineTo(x, R.y0 + R.h);
    }
    for (let r = 1; r < R.rows; r++) {
      const y = R.y0 + r * C + .5; ctx.moveTo(R.x0, y); ctx.lineTo(R.x0 + R.w, y);
    }
    ctx.stroke();
  };
  Object.values(L.regions).forEach(drawGrid);

  // 色带
  const Rw = L.regions.warpband, Rf = L.regions.weftband;
  for (let e = 0; e < d.ends; e++) {
    ctx.fillStyle = colorOf(d, d.warpColor[e]);
    ctx.fillRect(Rw.x0 + e * C, Rw.y0, C, B);
  }
  for (let p = 0; p < d.picks; p++) {
    ctx.fillStyle = colorOf(d, d.weftColor[p]);
    ctx.fillRect(Rf.x0, Rf.y0 + p * C, B, C);
  }

  // 梭道（多梭布边）
  const sh = d.shuttles;
  if (sh && L.stripX !== undefined) {
    const x0 = L.stripX, y0 = L.regions.drawdown.y0, SW = L.stripW || 20;
    ctx.strokeStyle = '#888';
    ctx.strokeRect(x0 + .5, y0 + .5, SW - 1, d.picks * C - 1);
    ctx.fillStyle = '#333';
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('梭', x0 + SW / 2, y0 - 8);
    for (let p = 0; p < d.picks; p++) {
      const a = sh.picks[p];
      if (!a) continue;
      const y = y0 + p * C;
      drawShuttleChip(ctx, x0 + 1, y + 2, 12, C - 4, colorOf(d, sh.colors[a.s]), a.s + 1);
      if (a.join) drawJoinMark(ctx, x0 + 12, y + (C - 8) / 2, 8, a.join);
      if (sh.locked[p]) {
        ctx.fillStyle = '#555';
        ctx.beginPath();
        ctx.arc(x0 + SW - 3, y + 3, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // 组织图彩色
  const Rd = L.regions.drawdown;
  const cg = Engine.colorGrid(d, A.derived, 'front');
  for (let p = 0; p < d.picks; p++)
    for (let e = 0; e < d.ends; e++) {
      ctx.fillStyle = cg[p][e] || '#eee';
      ctx.fillRect(Rd.x0 + e * C, Rd.y0 + p * C, C, C);
    }

  // 穿综 / 联结 / 踩踏：黑色标记
  ctx.fillStyle = '#111';
  const Rth = L.regions.threading;
  d.threading.forEach((s, e) => {
    if (s >= 0 && s < d.shafts) {
      const pad = 2.5;
      ctx.fillRect(Rth.x0 + e * C + pad, Rth.y0 + s * C + pad, C - pad * 2, C - pad * 2);
    }
  });
  const Rti = L.regions.tieup;
  for (let s = 0; s < d.shafts; s++)
    for (let t = 0; t < d.treadles; t++)
      if (d.tieup[s][t]) {
        const pad = 2.5;
        ctx.fillRect(Rti.x0 + t * C + pad, Rti.y0 + s * C + pad, C - pad * 2, C - pad * 2);
      }
  const Rtr = L.regions.treadling;
  d.treadling.forEach((t, p) => {
    if (t >= 0 && t < d.treadles) {
      ctx.beginPath();
      ctx.arc(Rtr.x0 + t * C + C / 2, Rtr.y0 + p * C + C / 2, C * .32, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  // 编号
  ctx.fillStyle = '#333';
  ctx.font = '9px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let s = 0; s < d.shafts; s++)
    ctx.fillText(String(s + 1), Rth.x0 - 12, Rth.y0 + s * C + C / 2);
  for (let t = 0; t < d.treadles; t++) {
    ctx.fillText(String(t + 1), Rti.x0 + t * C + C / 2, Rti.y0 - 10);
    ctx.fillText(String(t + 1), Rtr.x0 + t * C + C / 2, Rtr.y0 + Rtr.h + 11);
  }
  const stepE = d.ends <= 60 ? 1 : d.ends <= 120 ? 5 : 10;
  for (let e = 0; e < d.ends; e += stepE)
    ctx.fillText(String(e + 1), Rd.x0 + e * C + C / 2, Rd.y0 + Rd.h + 11);
  const stepP = d.picks <= 60 ? 1 : d.picks <= 120 ? 5 : 10;
  for (let p = 0; p < d.picks; p += stepP)
    ctx.fillText(String(p + 1), Rtr.x0 + Rtr.w + 12, Rtr.y0 + p * C + C / 2);

  // 循环标记
  const r = A.rep;
  if (!r.hasNull) {
    ctx.strokeStyle = '#29528c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (r.warp < d.ends) {
      const x = Rd.x0 + r.warp * C + .5;
      ctx.moveTo(x, Rd.y0); ctx.lineTo(x, Rd.y0 + Rd.h);
    }
    if (r.weft < d.picks) {
      const y = Rd.y0 + r.weft * C + .5;
      ctx.moveTo(Rd.x0, y); ctx.lineTo(Rd.x0 + Rd.w, y);
    }
    ctx.stroke();
  }
}

/* ------------------------------- 事件绑定 ----------------------------- */
function bindEvents() {
  $('#btnApply').addEventListener('click', () => applyDimensions(true));
  $('#btnNew').addEventListener('click', () => {
    if (state.dirty && !confirm('放弃当前修改并新建空白草稿？')) return;
    const s = parseInt($('#numShafts').value, 10) || 4;
    const t = parseInt($('#numTreadles').value, 10) || 4;
    const e = parseInt($('#numEnds').value, 10) || 16;
    const p = parseInt($('#numPicks').value, 10) || 16;
    pushHistory();
    loadDraft(Engine.blankDraft(clamp(s, 1, 24), clamp(t, 1, 24), clamp(e, 1, 200), clamp(p, 1, 200)),
              '未命名草稿', null);
  });
  $$('[data-tpl]').forEach(b => b.addEventListener('click', () => applyTemplate(b.dataset.tpl)));

  $('#toolRow').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.tool');
    if (!btn) return;
    state.tool = btn.dataset.tool;
    $$('.tool').forEach(b => b.classList.toggle('active', b === btn));
    $('#viewport').className = 'viewport tool-' + state.tool;
    state.selection = null;
    updateSelectionButtons();
  });
  $('#zoomIn').addEventListener('click', () => setZoom(state.zoom * 1.2, true));
  $('#zoomOut').addEventListener('click', () => setZoom(state.zoom / 1.2, true));
  $('#zoomFit').addEventListener('click', zoomFit);

  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);
  $('#btnCopy').addEventListener('click', copySelection);
  $('#btnPaste').addEventListener('click', pasteClipboard);
  $('#btnMirrorH').addEventListener('click', () => mirrorSelection('h'));
  $('#btnMirrorV').addEventListener('click', () => mirrorSelection('v'));
  $('#btnClearSel').addEventListener('click', clearSelectionCells);

  $('#lockThreading').addEventListener('change', (e) => { state.lockThreading = e.target.checked; });
  $('#lockTieup').addEventListener('change', (e) => { state.lockTieup = e.target.checked; });

  $('#btnApplyWarp').addEventListener('click', () => applyBandFill('warp'));
  $('#btnApplyWeft').addEventListener('click', () => applyBandFill('weft'));

  $('#btnPlay').addEventListener('click', startPlay);
  $('#btnStepFwd').addEventListener('click', () => stepPick(1));
  $('#btnStepBack').addEventListener('click', () => stepPick(-1));

  $('#btnSave').addEventListener('click', saveDraft);
  $('#btnOpen').addEventListener('click', openDrafts);
  $('#btnPrint').addEventListener('click', doPrint);
  $$('[data-close]').forEach(b => b.addEventListener('click', () =>
    b.closest('.modal').classList.add('hidden')));
  $('#draftModal').addEventListener('click', (e) => {
    if (e.target.id === 'draftModal') e.target.classList.add('hidden');
  });
  $('#cmpSource').addEventListener('change', runCompare);

  $('#draftName').addEventListener('input', scheduleAutosave);
  $('#maxFloat').addEventListener('change', () => {
    state.draft.maxFloat = clamp(parseInt($('#maxFloat').value, 10) || 1, 1, 200);
    afterEdit();
  });

  // Ctrl + 滚轮缩放
  $('#viewport').addEventListener('wheel', (ev) => {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      setZoom(state.zoom * (ev.deltaY < 0 ? 1.1 : 1 / 1.1), true);
    }
  }, { passive: false });

  window.addEventListener('keydown', (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key.toLowerCase() === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); }
    else if (mod && (ev.key.toLowerCase() === 'y' || (ev.key.toLowerCase() === 'z' && ev.shiftKey))) {
      ev.preventDefault(); redo();
    } else if (mod && ev.key.toLowerCase() === 's') { ev.preventDefault(); saveDraft(); }
    else if (mod && ev.key.toLowerCase() === 'p') { ev.preventDefault(); doPrint(); }
    else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (state.selection && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
        ev.preventDefault();
        clearSelectionCells();
      }
    } else if (ev.key === 'Escape') {
      state.selection = null;
      $('#draftModal').classList.add('hidden');
      updateSelectionButtons();
    } else if (ev.key === ' ' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
      // 空格按住平移由中键替代，这里不拦截
    }
  });

  window.addEventListener('resize', () => resizeCanvases());
}

/* ------------------------------- 初始化 ------------------------------- */
function init() {
  const restored = restoreAutosave();
  if (restored) setTimeout(() => toast('已恢复上次的本地草稿'), 400);
  state.analysis = Engine.analyze(state.draft);
  setupCanvas();
  bindEvents();
  syncInputs();
  buildPalette();
  refreshTreadleBrush();
  resizeCanvases();
  refreshIssues();
  refreshStats();
  refreshPreviews();
  refreshCompareOptions();
  updateSelectionButtons();
  requestAnimationFrame(frame);
  setTimeout(zoomFit, 60);
}

document.addEventListener('DOMContentLoaded', init);

// 便于自动化测试 / 控制台调试
if (typeof window !== 'undefined') {
  window.__loom = {
    state, Engine,
    pushHistory, afterEdit, afterStructural, normalizeDraft, locateCell,
  };
  // 供「目标反推」模块调用：应用候选为不覆盖原稿的新草稿
  window.loadDraft = loadDraft;
  // 供「试织缺陷回标」模块调用：在主图板定位穿综 / 联结 / 踩踏 / 组织格
  window.locateCell = locateCell;
  window.toast = toast;
}
