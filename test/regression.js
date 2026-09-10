/**
 * 回归测试：四条经复核确认的正确性路径
 *  1) 锁定穿综后镜像不得改动穿综数据
 *  2) collectRuns 跨循环边界浮线定位（[0,1,0] 的长度 2 纬浮应标出 [2,0]）
 *  3) 选择方案 B 后编辑当前方案，比较面板必须实时重算
 *  4) 相同方案的 A、B 差异采样配色必须一致
 * 另含对编辑 / 校验 / 比较主流程的非回归检查。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('/tmp/node_modules/jsdom');
const { createCanvas } = require('/tmp/node_modules/canvas');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://x/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.requestAnimationFrame = () => 0;
w.HTMLElement.prototype.scrollTo = () => {};
const origCreate = w.document.createElement.bind(w.document);
w.document.createElement = function (tag) {
  if (String(tag).toLowerCase() === 'canvas') { const c = createCanvas(10, 10); c.style = {}; return c; }
  return origCreate(tag);
};
const _add = w.document.addEventListener.bind(w.document);
w.document.addEventListener = function (type, fn, opts) {
  if (type === 'DOMContentLoaded') return;
  return _add(type, fn, opts);
};

let pass = 0, fail = 0;
const $ = (sel) => w.document.querySelector(sel);
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS -', name); }
  else { fail++; console.log('FAIL -', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/* ---------- fetch mock：模拟 /api/drafts 与 /api/drafts/<id> ---------- */
const savedDrafts = new Map();
let nextId = 100;
w.fetch = async (url, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase();
  if (method === 'POST' && url === '/api/drafts') {
    const body = JSON.parse(opts.body);
    let id = body.id;
    if (id == null || !savedDrafts.has(id)) { id = nextId++; }
    savedDrafts.set(id, { id, name: body.name, data: body.data });
    return jsonResp({ id, name: body.name, updated_at: new Date().toISOString() });
  }
  const m = String(url).match(/\/api\/drafts\/(\d+)$/);
  if (method === 'GET' && m) {
    const d = savedDrafts.get(Number(m[1]));
    return d ? jsonResp(d) : new Response('{"error":"not found"}', { status: 404 });
  }
  if (method === 'GET' && /\/api\/drafts$/.test(url)) {
    return jsonResp([...savedDrafts.values()].map(d => ({
      id: d.id, name: d.name, updated_at: new Date().toISOString(),
    })));
  }
  return new Response('{}', { status: 404 });
};
function jsonResp(obj) {
  return {
    ok: true, status: 200,
    json: async () => obj,
  };
}

const eng = fs.readFileSync(path.join(ROOT, 'static/engine.js'), 'utf8').replace(/'use strict';/, '');
const app = fs.readFileSync(path.join(ROOT, 'static/app.js'), 'utf8').replace(/'use strict';/, '');
w.eval(eng + app + `
  ;globalThis.state=state;
  ;globalThis.Engine=Engine;
  ;globalThis.afterEdit=afterEdit;
  ;globalThis.afterStructural=afterStructural;
  ;globalThis.syncInputs=syncInputs;
  ;globalThis.buildPalette=buildPalette;
  ;globalThis.refreshTreadleBrush=refreshTreadleBrush;
  ;globalThis.resizeCanvases=resizeCanvases;
  ;globalThis.refreshIssues=refreshIssues;
  ;globalThis.refreshStats=refreshStats;
  ;globalThis.refreshPreviews=refreshPreviews;
  ;globalThis.refreshCompareOptions=refreshCompareOptions;
  ;globalThis.saveDraft=saveDraft;
  ;globalThis.undo=undo;
  ;globalThis.redo=redo;
  ;globalThis.pushHistory=pushHistory;
  ;globalThis.makeTemplate=makeTemplate;
  ;globalThis.boardEl=null;
  ;globalThis.baseCvs=null; globalThis.ovCvs=null;
  ;globalThis.baseCtx=null; globalThis.ovCtx=null;
  ;globalThis.dpr=1;
  ;globalThis.__F={
    Engine, afterEdit, afterStructural, mirrorSelection, copySelection, pasteClipboard,
    runCompare, renderCompare, drawDiffCanvas, pushHistory, makeTemplate,
    initBoard() {
      boardEl = document.querySelector('#board');
      state.analysis = Engine.analyze(state.draft);
      baseCvs = createCanvas(10, 10);
      ovCvs = createCanvas(10, 10);
      baseCvs.style = {}; ovCvs.style = {};
      baseCtx = baseCvs.getContext('2d');
      ovCtx = ovCvs.getContext('2d');
      dpr = 1;
      syncInputs(); buildPalette(); refreshTreadleBrush();
      resizeCanvases(); refreshIssues(); refreshStats(); refreshPreviews();
      refreshCompareOptions();
    },
  };
`);
w.createCanvas = createCanvas;

// 初始化画布管线
w.__F.initBoard();
const F = w.__F;
const state = F.Engine ? w.eval('state') : null;

/* ===================================================================== *
 * 缺陷 2（引擎层，无需 DOM）：collectRuns 跨循环边界定位
 * [0,1,0]：纬浮（v===0）在环上是一段长度 2、覆盖位置 [2,0] 的浮线
 * ===================================================================== */
{
  const d = F.Engine.blankDraft(2, 2, 3, 3);
  // 构造 drawdown 仅在中间经为「经在上」：每行 [0,1,0]
  // 踏板 0：不升综框（全部纬在上）；踏板 1：升起综框 1（中间经）
  d.threading = [0, 1, 0];
  d.treadling = [1, 1, 1];
  d.tieup = [[false, false], [false, true]];
  // 期望 drawdown 每行 [0,1,0]
  const derived = F.Engine.derive(d);
  check('[0,1,0] 组织推导正确', eq(derived.drawdown, [[0, 1, 0], [0, 1, 0], [0, 1, 0]]),
        derived.drawdown);

  const fl = F.Engine.floats(d, derived);
  // 每一纬都有一段长度 2 的纬浮
  check('纬浮长度为 2', fl.weftRuns.length === 3 * 2 && fl.weftRuns.every(r => r.length === 2),
        fl.weftRuns);
  // 关键断言：起点必须是 2，覆盖位置 [2,0]，而不是错误的起点 1（[1,2]）
  const p0 = fl.weftRuns.filter(r => r.pick === 0).map(r => ({ end: r.end, length: r.length }));
  check('跨边界纬浮定位为 [end=2 起] 覆盖 [2,0]',
    p0.some(r => r.end === 2 && r.length === 2) && !p0.some(r => r.end === 1),
    p0);
  const locsForPick0 = fl.weftRuns.filter(r => r.pick === 0 && r.start === 2)
    .map(r => r.end).sort((a, b) => a - b);
  check('浮线问题定位格子序列为 [2,0]', eq(locsForPick0, [0, 2]), locsForPick0);

  // 对照组：非循环情形 [0,1,0,1] 长度 1，不应错误合并
  const d2 = F.Engine.blankDraft(2, 1, 4, 1);
  d2.threading = [0, 1, 0, 1];
  d2.treadling = [0];
  d2.tieup = [[false], [true]];
  const dd2 = F.Engine.derive(d2);
  check('[0,1,0,1] 推导', eq(dd2.drawdown, [[0, 1, 0, 1]]), dd2.drawdown);
  const fl2 = F.Engine.floats(d2, dd2);
  check('非跨边界纬浮长度均为 1', fl2.weftRuns.every(r => r.length === 1), fl2.weftRuns);

  // [0,1,0,1,0]：纬浮位置 0/2/4，环上仅 4 与 0 相邻 -> 一段长度 2（起点 4）+ 一段长度 1（起点 2）
  const d3 = F.Engine.blankDraft(2, 2, 5, 1);
  d3.threading = [0, 1, 0, 1, 0];
  d3.treadling = [1];
  d3.tieup = [[true, false], [false, true]];
  const dd3 = F.Engine.derive(d3);
  check('[0,1,0,1,0] 推导', eq(dd3.drawdown, [[0, 1, 0, 1, 0]]), dd3.drawdown);
  const fl3 = F.Engine.floats(d3, dd3);
  const merged = fl3.weftRuns.filter(r => r.length === 2);
  check('[0,1,0,1,0] 仅尾首合并为长度 2、起点 4',
    merged.length === 2 && merged.every(r => r.start === 4) &&
    merged.map(r => r.end).sort((a, b) => a - b).join(',') === '0,4',
    fl3.weftRuns);
  check('[0,1,0,1,0] 中间格保持独立长度 1',
    fl3.weftRuns.some(r => r.start === 2 && r.length === 1 && r.end === 2),
    fl3.weftRuns);
}

/* ===================================================================== *
 * 缺陷 1：锁定穿综后镜像不得改动穿综
 * ===================================================================== */
{
  // 干净斜纹
  state.draft = F.makeTemplate('twill');
  F.afterStructural();
  const before = state.draft.threading.slice();

  state.selection = { grid: 'threading', r0: 0, c0: 0, r1: 3, c1: 7 };
  state.lockThreading = true;
  F.mirrorSelection('h');
  check('穿综锁定 + 左右镜像：threading 不变', eq(state.draft.threading, before),
        state.draft.threading);
  F.mirrorSelection('v');
  check('穿综锁定 + 上下镜像：threading 不变', eq(state.draft.threading, before));

  // 解锁后镜像应确实改动（验证测试本身有效）
  state.lockThreading = false;
  F.mirrorSelection('h');
  check('解锁后镜像生效（列 0 取原列 7 的综框）',
        state.draft.threading[0] === before[7], [state.draft.threading[0], before[7]]);

  // 锁定穿综不应影响色带镜像
  state.lockThreading = true;
  state.selection = { grid: 'warpband', r0: 0, c0: 0, r1: 0, c1: 7 };
  const bandBefore = state.draft.warpColor.slice();
  F.mirrorSelection('h');
  const expectBand = bandBefore.slice(0, 8).reverse()
    .concat(bandBefore.slice(8));
  check('穿综锁定不影响经色带镜像', eq(state.draft.warpColor, expectBand),
        state.draft.warpColor);
  state.lockThreading = false;

  // 联结锁同理
  state.selection = { grid: 'tieup', r0: 0, c0: 0, r1: 2, c1: 2 };
  const tieBefore = state.draft.tieup.map(r => r.slice());
  state.lockTieup = true;
  F.mirrorSelection('h');
  check('联结锁定后镜像：tieup 不变', eq(state.draft.tieup, tieBefore));
  state.lockTieup = false;
}

/* ===================================================================== *
 * 缺陷 3 + 4：保存当前为 B → 编辑 A → 比较实时重算；采样配色一致
 * ===================================================================== */
(async () => {
  state.draft = F.makeTemplate('twill');
  F.afterStructural();
  // 给经/纬赋予可区分的颜色，使「经纬反相」在像素上可被检出
  for (let i = 0; i < state.draft.ends; i++) state.draft.warpColor[i] = 1; // 靛蓝
  for (let i = 0; i < state.draft.picks; i++) state.draft.weftColor[i] = 2; // 朱红
  F.afterStructural();

  // 保存当前状态为方案 B（走 UI 的 saveDraft，经由 fetch mock 落库）
  $('#draftName').value = 'B快照';
  await w.eval('saveDraft()');
  const bId = state.savedId;
  check('已保存方案 B', bId != null, bId);

  // 等初始化时异步填充比较选择器完成
  await new Promise(r => setTimeout(r, 50));
  // 在比较面板选择 B
  $('#cmpSource').value = String(bId);
  await F.runCompare();
  let txt = $('#cmpResult').textContent.replace(/\s+/g, ' ');
  check('相同方案初始零差异', /交织点差异\s*0\s*\/\s*\d+/.test(txt) && txt.includes('两方案等效'),
        txt);

  /* ---- 缺陷 4：相同方案时 A、B 采样像素必须完全一致 ---- */
  {
    const cmp = F.Engine.compare(state.draft, JSON.parse(JSON.stringify(state.draft)));
    const cA = createCanvas(120, 80), cB = createCanvas(120, 80);
    F.drawDiffCanvas(cA, cmp, 'A');
    F.drawDiffCanvas(cB, cmp, 'B');
    const pxA = cA.getContext('2d').getImageData(0, 0, cmp.sampleW, cmp.sampleH).data;
    const pxB = cB.getContext('2d').getImageData(0, 0, cmp.sampleW, cmp.sampleH).data;
    let mismatch = 0;
    for (let i = 0; i < pxA.length; i += 4) {
      if (pxA[i] !== pxB[i] || pxA[i + 1] !== pxB[i + 1] || pxA[i + 2] !== pxB[i + 2]) mismatch++;
    }
    check('相同方案 A/B 采样像素 100% 一致（无经纬反相）', mismatch === 0,
          { mismatch, samples: pxA.length / 4 });

    // 语义校验：经浮点应为经色（靛蓝 #274060），纬浮点应为纬色（朱红 #b3352a）
    const offA = cA.getContext('2d').getImageData(0, 0, 1, 1).data;
    const offB = cB.getContext('2d').getImageData(0, 0, 1, 1).data;
    // 抽样 drawdown[0][0]：斜纹首纬首格值
    const v00 = cmp.gridA[0][0];
    const expectRGB = v00 === 1 ? [0x27, 0x40, 0x60] : [0xb3, 0x35, 0x2a];
    const gotA = [pxA[0], pxA[1], pxA[2]], gotB = [pxB[0], pxB[1], pxB[2]];
    check('A 采样 (0,0) 经纬配色正确',
      gotA[0] === expectRGB[0] && gotA[1] === expectRGB[1] && gotA[2] === expectRGB[2],
      { v00, gotA, expectRGB });
    check('B 采样 (0,0) 经纬配色正确',
      gotB[0] === expectRGB[0] && gotB[1] === expectRGB[1] && gotB[2] === expectRGB[2],
      { v00, gotB, expectRGB });
  }

  /* ---- 缺陷 3：编辑当前方案后比较必须重算，不再停留零差异 ---- */
  // 直接涂改穿综：第 0 根经换到不同综框
  F.pushHistory();
  state.draft.threading[0] = (state.draft.threading[0] + 1) % state.draft.shafts;
  F.afterEdit();
  // refreshCompareIfActive 有 150ms 防抖
  await new Promise(r => setTimeout(r, 300));
  txt = $('#cmpResult').textContent.replace(/\s+/g, ' ');
  const m = txt.match(/交织点差异\s*(\d+)\s*\/\s*(\d+)/);
  check('编辑后比较面板已重算（差异 > 0）', !!m && Number(m[1]) > 0, txt);
  check('编辑后不再显示“两方案等效”', !txt.includes('两方案等效'), txt);
  // 统计行 A 侧仍反映当前草稿
  check('编辑后 A 侧循环仍正确显示', /循环（经×纬）/.test(txt), txt);

  // 切回空选项应清缓存，再编辑不应报错 / 复活面板
  $('#cmpSource').value = '';
  await F.runCompare();
  check('清空比较后 compareB 为 null', state.compareB === null);
  state.draft.threading[1] = (state.draft.threading[1] + 2) % state.draft.shafts;
  F.afterEdit();
  await new Promise(r => setTimeout(r, 250));
  check('无方案 B 时编辑不复活比较结果',
    $('#cmpResult').textContent.includes('将当前草稿与已保存方案并排比较'),
    $('#cmpResult').textContent);

  /* =================================================================== *
   * 非回归：既有编辑 / 校验主流程
   * =================================================================== */
  state.draft = F.makeTemplate('plain');
  F.afterStructural();
  const a = state.analysis;
  check('[非回归] 平纹循环 2×2', a.rep.warp === 2 && a.rep.weft === 2,
        [a.rep.warp, a.rep.weft]);
  check('[非回归] 平纹最长浮长 1', a.stats.maxWarpFloat === 1 && a.stats.maxWeftFloat === 1);
  check('[非回归] 平纹无校验错误', a.validation.errors === 0,
        a.validation.issues.map(i => i.code));

  state.draft.threading[0] = 99;
  state.draft.maxFloat = 1;
  F.afterEdit();
  check('[非回归] 越界穿综仍被检出',
        state.analysis.validation.issues.some(i => i.code === 'threading-range'));

  // 撤销/重做仍可用
  F.afterStructural();
  w.eval('undo()');
  check('[非回归] 撤销恢复综框范围', state.draft.threading[0] !== 99,
        state.draft.threading[0]);
  w.eval('redo()');
  check('[非回归] 重做回到越界值', state.draft.threading[0] === 99);

  // 比较两不同模板应产生差异
  const twill = F.makeTemplate('twill');
  const plain = F.makeTemplate('plain');
  const cmp2 = F.Engine.compare(twill, plain);
  check('[非回归] 斜纹 vs 平纹存在差异', cmp2.diffs > 0, { diffs: cmp2.diffs });
  check('[非回归] 斜纹循环 4×4',
        cmp2.repeatA.warp === 4 && cmp2.repeatA.weft === 4, cmp2.repeatA);

  console.log(`\nRESULT: ${fail ? 'FAIL' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
