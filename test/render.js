/** 用 node-canvas 直接驱动绘制管线，导出 PNG 做视觉检查（不依赖浏览器） */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('/tmp/node_modules/jsdom');
const { createCanvas, Image } = require('/tmp/node_modules/canvas');
const ROOT = path.join(__dirname, '..');

const html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://x/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.requestAnimationFrame = () => 0;
w.HTMLCanvasElement.prototype.getContext = function (type, attr) {
  // 持久复用同一个 node-canvas：reverse-ui 会缓存 ctx，重建实例会让绘制落到旧画布。
  // 尺寸变化时由 node-canvas 自身的 width 赋值清屏，ctx 仍指向同一 2d context。
  if (!this._nodeCanvas) this._nodeCanvas = createCanvas(this.width || 300, this.height || 150);
  if (this._nodeCanvas.width !== this.width) this._nodeCanvas.width = this.width;
  if (this._nodeCanvas.height !== this.height) this._nodeCanvas.height = this.height;
  return this._nodeCanvas.getContext(type, attr);
};
const origCreate = w.document.createElement.bind(w.document);
w.document.createElement = function (tag) {
  if (String(tag).toLowerCase() === 'canvas') { const c = createCanvas(10, 10); c.style = {}; return c; }
  return origCreate(tag);
};
w.HTMLElement.prototype.scrollTo = () => {};
w.HTMLElement.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, width: 0, height: 0 };
};
w.createCanvas = createCanvas;
// 拦截 DOMContentLoaded：app.js 的 init 会自动 setupCanvas（appendChild node-canvas 会失败）
const _addListener = w.document.addEventListener.bind(w.document);
w.document.addEventListener = function (type, fn, opts) {
  if (type === 'DOMContentLoaded') return;
  return _addListener(type, fn, opts);
};
w.__fs = fs;

const R = (p) => fs.readFileSync(p, 'utf8');
const eng = R(path.join(ROOT, 'static/engine.js')).replace(/'use strict';/, '');
const rev = R(path.join(ROOT, 'static/reverse.js')).replace(/'use strict';/, '');
const revui = R(path.join(ROOT, 'static/reverse-ui.js'));
const app = R(path.join(ROOT, 'static/app.js')).replace(/'use strict';/, '');

// 所有场景都在同一 eval 词法作用域内定义与执行
w.eval(eng + rev + revui + app + `
  boardEl = document.querySelector('#board');
  state.analysis = Engine.analyze(state.draft);
  baseCvs = createCanvas(10, 10);
  ovCvs = createCanvas(10, 10);
  baseCvs.style = {}; ovCvs.style = {};
  baseCtx = baseCvs.getContext('2d');
  ovCtx = ovCvs.getContext('2d');
  dpr = 1;

  function exportShot(file, fn) {
    if (fn) fn();
    state.analysis = Engine.analyze(state.draft);
    resizeCanvases(); drawBase(); drawOverlay(1000);
    const L = state.layout;
    const out = createCanvas(L.W, L.H);
    const o = out.getContext('2d');
    o.drawImage(baseCvs, 0, 0, L.W, L.H);
    o.drawImage(ovCvs, 0, 0, L.W, L.H);
    globalThis.__fs.writeFileSync(file, out.toBuffer('image/png'));
    console.log('wrote', file, L.W + 'x' + L.H);
  }
  globalThis.__exportShot = exportShot;

  exportShot('/tmp/render_default.png');

  exportShot('/tmp/render_issues.png', () => {
    const d = state.draft;
    d.threading[2] = 99;
    for (let i = 0; i < 8; i++) d.threading[i] = 0;
    for (let i = 0; i < 6; i++) d.treadling[i] = 0;
    d.tieup = d.tieup.map((row, s) => row.map((v, t) => t === 0 ? s === 0 : false));
    d.treadling[3] = -1;
    d.maxFloat = 3;
    afterEdit(); state.activeIssue = 0;
  });

  exportShot('/tmp/render_playback.png', () => {
    state.draft = makeTemplate('twill');
    afterStructural(); state.playing = true; state.playPick = 5;
  });

  exportShot('/tmp/render_selection.png', () => {
    state.selection = { grid: 'tieup', r0: 0, c0: 0, r1: 2, c1: 2 };
  });

  exportShot('/tmp/render_satin.png', () => {
    state.draft = makeTemplate('satin');
    for (let i = 0; i < state.draft.ends; i++) state.draft.warpColor[i] = [0,1,2,3][i%4];
    for (let i = 0; i < state.draft.picks; i++) state.draft.weftColor[i] = [7,4,5,6][i%4];
    afterStructural();
  });

  drawRepeatPreview(document.querySelector('#frontPreview'), 'front');
  drawRepeatPreview(document.querySelector('#backPreview'), 'back');
  globalThis.__savePreview = (id, file) => {
    const el = document.querySelector('#' + id);
    const nc = el._nodeCanvas || el;
    globalThis.__fs.writeFileSync(file, nc.toBuffer('image/png'));
    console.log('wrote', file);
  };
  __savePreview('frontPreview', '/tmp/render_frontPreview.png');
  __savePreview('backPreview', '/tmp/render_backPreview.png');

  // 目标反推：16×16 斜纹目标、maxFloat=1（超浮线场景）
  document.getElementById('btnReverse').click();
  document.getElementById('revEnds').value = 16;
  document.getElementById('revPicks').value = 16;
  document.getElementById('revResize').click();
  document.getElementById('revFromDraft').click();
  document.getElementById('revMaxFloat').value = 1;
  globalThis.__exportReverse = () => {
    const c = document.getElementById('revCanvas');
    const o = document.getElementById('revOverlay');
    const cc = c._nodeCanvas || c, oo = o._nodeCanvas || o;
    const out = createCanvas(cc.width, cc.height);
    out.getContext('2d').drawImage(cc, 0, 0);
    out.getContext('2d').drawImage(oo, 0, 0);
    globalThis.__fs.writeFileSync('/tmp/render_reverse_float.png', out.toBuffer('image/png'));
    console.log('wrote /tmp/render_reverse_float.png', cc.width + 'x' + cc.height);
    const sizer = document.getElementById('revBoardSizer');
    console.log('revBoardSizer', sizer.style.width, sizer.style.height);
  };
  globalThis.__exportConflictShot = () => {
    const c = document.getElementById('revCanvas');
    const o = document.getElementById('revOverlay');
    const cc = c._nodeCanvas || c, oo = o._nodeCanvas || o;
    const out = createCanvas(cc.width, cc.height);
    out.getContext('2d').drawImage(cc, 0, 0);
    out.getContext('2d').drawImage(oo, 0, 0);
    globalThis.__fs.writeFileSync('/tmp/render_reverse_conflict.png', out.toBuffer('image/png'));
    console.log('wrote /tmp/render_reverse_conflict.png', cc.width + 'x' + cc.height);
  };
  globalThis.__runConflictScenario = () => {
    document.getElementById('btnReverse').click();
    document.getElementById('revEnds').value = 10;
    document.getElementById('revPicks').value = 10;
    document.getElementById('revResize').click();
    state.draft = makeTemplate('satin');
    state.draft = Engine.resize(state.draft, { shafts: 5, treadles: 5, ends: 10, picks: 10 });
    state.draft.maxFloat = 5;
    afterStructural();
    document.getElementById('revFromDraft').click();
    document.getElementById('revShafts').value = 4;
    document.getElementById('revTreadles').value = 4;
    document.getElementById('revMaxFloat').value = 5;
    document.getElementById('revSearch').click();
  };
  document.getElementById('revSearch').click();
`);

setTimeout(() => {
  w.eval(`__exportReverse();`);
}, 300);

// 额外：目标冲突场景（4 综框做 5 综缎纹），验证红叉叠色
setTimeout(() => {
  w.eval(`__runConflictScenario();`);
  setTimeout(() => {
    w.eval(`__exportConflictShot();`);
  }, 300);
}, 600);
