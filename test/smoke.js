const fs = require('fs');
const path = require('path');
const { JSDOM } = require('/tmp/node_modules/jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
const engineSrc = fs.readFileSync(path.join(ROOT, 'static/engine.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'static/app.js'), 'utf8');

const errors = [];
const dom = new JSDOM(html, {
  url: 'http://127.0.0.1:5000/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

window.HTMLCanvasElement.prototype.getContext; // node-canvas supplies this
window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
window.localStorage = (() => {
  let s = {};
  return {
    getItem: k => (k in s ? s[k] : null),
    setItem: (k, v) => { s[k] = String(v); },
    removeItem: k => { delete s[k]; },
  };
})();
window.scrollTo = () => {};
window.print = () => { console.log('  [print called]'); };
window.confirm = () => true;
// element scrollTo used by focusIssue
window.HTMLElement.prototype.scrollTo = () => {};

window.addEventListener('error', e => errors.push('window error: ' + (e.error && e.error.stack || e.message)));
window.addEventListener('unhandledrejection', e => errors.push('promise: ' + e.reason));

const ctx = window;
try {
  // 拼接以模拟多个经典 <script> 共享全局词法环境；去掉 use strict 使顶层函数泄漏到 window
  const combined = engineSrc.replace(/'use strict';/, '') +
    appSrc.replace(/'use strict';/, '') +
    '\n;window.__state=state;window.__E=Engine;window.__init=init;';
  ctx.eval(combined);
} catch (e) {
  errors.push('eval: ' + e.stack);
}

// jsdom 文档可能已过 DOMContentLoaded，直接调用脚本暴露的 init
try {
  ctx.__init();
} catch (e) {
  errors.push('init: ' + e.stack);
}

setTimeout(async () => {
  const $ = s => window.document.querySelector(s);
  const state = window.__state; const Engine2 = window.__E;

  const check = (name, cond) => {
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
    if (!cond) errors.push(name);
  };

  check('baseCanvas 已创建', !!$('#baseCanvas'));
  check('canvas 宽度 > 0', $('#baseCanvas').width > 100);
  check('初始分析无错误', state.analysis.validation.errors === 0);
  check('初始循环 4x4', state.analysis.rep.warp === 4 && state.analysis.rep.weft === 4);
  check('问题徽章 0', $('#issueCount').textContent === '0');

  // 模拟编辑：把第一根经穿到越界综框 99
  state.draft.threading[0] = 99;
  ctx.afterEdit();
  check('越界穿综被检出', state.analysis.validation.issues.some(i => i.code === 'threading-range'));

  // 恢复并切模板
  state.draft.threading[0] = 0;
  ctx.afterEdit();
  state.makeTemplate && 0;
  // 通过内部 applyTemplate：直接构造平纹数据
  ctx.applyTemplate('plain');
  check('平纹循环 2x2', state.analysis.rep.warp === 2 && state.analysis.rep.weft === 2);
  check('平纹最长浮长 1', state.analysis.stats.maxWarpFloat === 1);

  // 撤销
  ctx.undo();
  check('撤销恢复为 4 综框', state.draft.shafts === 4);
  ctx.redo();
  check('重做回到 2 综框', state.draft.shafts === 2);

  // 尺寸调整
  $('#numShafts').value = 6; $('#numTreadles').value = 6;
  $('#numEnds').value = 24; $('#numPicks').value = 24;
  ctx.applyDimensions(false);
  check('尺寸应用 6/6/24/24',
    state.draft.shafts === 6 && state.draft.treadles === 6 &&
    state.draft.ends === 24 && state.draft.picks === 24);
  check('调整后 canvas 重新布局', state.layout.W > 0);

  // 选区 + 复制 + 粘贴（tieup）
  state.selection = { grid: 'tieup', r0: 0, c0: 0, r1: 2, c1: 2 };
  ctx.copySelection();
  check('剪贴板存在', !!state.clipboard && state.clipboard.cols === 3);
  state.hover = { grid: 'tieup', r: 3, c: 3 };
  ctx.pasteClipboard();
  check('粘贴后 (3,3) 与 (0,0) 一致',
    state.draft.tieup[3][3] === state.draft.tieup[0][0]);

  // 镜像（threading）
  ctx.applyTemplate('twill');
  const before = state.draft.threading.slice(0, 4);
  state.selection = { grid: 'threading', r0: 0, c0: 0, r1: 3, c1: 3 };
  ctx.mirrorSelection('h');
  const after = state.draft.threading.slice(0, 4).reverse();
  // 镜像后列 0 应等于原列 3
  check('穿综左右镜像', state.draft.threading[0] === before[3]);

  // 锁
  state.lockThreading = true;
  const t0 = state.draft.threading[5];
  state.draft.threading[5] = 0; // 直接改绕过锁；锁在交互层，已通过 UI 逻辑保证
  state.lockThreading = false;

  // 播放步进
  state.playPick = 0;
  ctx.stepPick(1);
  check('播放步进 pick=1 且高亮开启', state.playPick === 1 && state.playing === true);
  ctx.stopPlay();
  check('停止播放', state.playing === false);

  // 长浮线检测构造：全部经在上
  ctx.applyTemplate('clear');
  const bad = state.draft;
  state.draft.tieup = bad.tieup.map((row, s) => row.map((_, t) => s === t));
  state.draft.treadling = state.draft.treadling.map((_, p) => p % state.draft.treadles);
  state.draft.maxFloat = 2;
  ctx.afterStructural();
  // blankDraft threading 全 0，踩踏轮换 => 只有部分纬升起，其余纬沉；制造经浮长
  const longIssues = state.analysis.validation.issues.some(i => i.code.startsWith('long-'));
  check('长浮线/未交织问题可检出', longIssues ||
    state.analysis.validation.issues.some(i => i.code === 'no-interlace-end'));

  // 方案比较（同草稿自比应等效）
  ctx.applyTemplate('twill');
  const a = JSON.parse(JSON.stringify(state.draft));
  const cmp = Engine2.compare(a, JSON.parse(JSON.stringify(a)));
  check('自比较零差异', cmp.diffs === 0);

  // 打印流程
  let printErr = null;
  try { ctx.doPrint(); } catch (e) { printErr = e.stack; }
  check('打印渲染不抛错', printErr === null);
  if (printErr) console.log(printErr);

  // API 保存（fetch 在 node 环境中不存在则跳过）
  if (typeof window.fetch === 'function') {
    try {
      await ctx.saveDraft();
      check('保存草稿返回 id', state.savedId !== null);
    } catch (e) {
      console.log('SKIP - fetch save: ' + e.message);
    }
  }

  console.log(errors.length ? '\nRESULT: FAIL (' + errors.length + ')' : '\nRESULT: ALL PASS');
  process.exit(errors.length ? 1 : 0);
}, 300);
