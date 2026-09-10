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
  // node-canvas 2D context
  return this._nodeCanvas ? this._nodeCanvas.getContext(type, attr)
       : (this._nodeCanvas = createCanvas(this.width || 300, this.height || 150)).getContext(type, attr);
};
// jsdom canvas 无真实像素，createElement('canvas') 替换为 node-canvas
const origCreate = w.document.createElement.bind(w.document);
w.document.createElement = function (tag) {
  if (String(tag).toLowerCase() === 'canvas') return createCanvas(10, 10);
  return origCreate(tag);
};
w.HTMLElement.prototype.scrollTo = () => {};
w.HTMLElement.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, width: 0, height: 0 };
};

const eng = fs.readFileSync(path.join(ROOT, 'static/engine.js'), 'utf8').replace(/'use strict';/, '');
const app = fs.readFileSync(path.join(ROOT, 'static/app.js'), 'utf8').replace(/'use strict';/, '');
w.eval(eng + app + '\n;window.__state=state;');
const state = w.__state;

// 手动搭建板：setupCanvas 依赖 appendChild/DOM，这里模拟
state.analysis = require_engine(state.draft);
function require_engine() { return w.Engine.analyze(state.draft); }

// 用 node-canvas 替换 setupCanvas 中的元素
const board = w.document.querySelector('#board');
const baseCvs = createCanvas(10, 10);
const ovCvs = createCanvas(10, 10);
baseCvs.style = {}; ovCvs.style = {};
baseCvs.id = 'baseCanvas'; ovCvs.id = 'overlayCanvas';
board.appendChild(baseCvs); board.appendChild(ovCvs);
// 让 app.js 内部变量指向我们的 canvas：通过重新调用 setupCanvas
w.eval('setupCanvas(); dpr=1;');

// resizeCanvases 使用内部 canvas；重新赋值
function exportShot(file, mutate) {
  if (mutate) mutate();
  w.eval('state.analysis=Engine.analyze(state.draft); resizeCanvases(); drawBase();');
  const L = state.layout;
  // baseCvs 已按 layout 重设；drawOverlay(now)
  w.eval(`drawOverlay(1000);`);
  // 叠加层需合成到一张图
  const out = createCanvas(L.W, L.H);
  const o = out.getContext('2d');
  o.drawImage(baseCvs, 0, 0, L.W, L.H);
  o.drawImage(ovCvs, 0, 0, L.W, L.H);
  fs.writeFileSync(file, out.toBuffer('image/png'));
  console.log('wrote', file, L.W + 'x' + L.H);
}

exportShot('/tmp/render_default.png');

exportShot('/tmp/render_issues.png', () => {
  const d = state.draft;
  d.threading[2] = 99;
  for (let i = 0; i < 8; i++) d.threading[i] = 0;
  for (let i = 0; i < 6; i++) d.treadling[i] = 0;
  d.tieup = d.tieup.map((row, s) => row.map((v, t) => t === 0 ? s === 0 : false));
  d.treadling[3] = -1;
  d.maxFloat = 3;
  // 选一个 issue 高亮
  w.eval('afterEdit(); state.activeIssue=0; drawOverlay(1000);');
});

// 播放帧
exportShot('/tmp/render_playback.png', () => {
  w.eval("state.draft=makeTemplate('twill'); afterStructural(); state.playing=true; state.playPick=5; drawOverlay(1000);");
});

// 选区
exportShot('/tmp/render_selection.png', () => {
  w.eval("state.selection={grid:'tieup',r0:0,c0:0,r1:2,c1:2}; drawOverlay(1000);");
});

// 五枚缎彩色 + 自定义色带
exportShot('/tmp/render_satin.png', () => {
  w.eval(`
    state.draft = makeTemplate('satin');
    for(let i=0;i<state.draft.ends;i++) state.draft.warpColor[i]=[0,1,2,3][i%4];
    for(let i=0;i<state.draft.picks;i++) state.draft.weftColor[i]=[7,4,5,6][i%4];
    afterStructural();
  `);
});

// 正反面预览导出
w.eval(`
  drawRepeatPreview(document.querySelector('#frontPreview'),'front');
  drawRepeatPreview(document.querySelector('#backPreview'),'back');
`);
['frontPreview', 'backPreview'].forEach(id => {
  const cvs = w.document.querySelector('#' + id);
  fs.writeFileSync('/tmp/render_' + id + '.png', cvs.toBuffer('image/png'));
  console.log('wrote /tmp/render_' + id + '.png');
});
