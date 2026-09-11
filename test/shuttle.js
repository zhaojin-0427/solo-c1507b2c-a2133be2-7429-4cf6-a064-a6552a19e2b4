/**
 * 多梭布边路径校验测试：
 *  - 引擎：路径推演（入梭边不一致 / 换梭未交接 / 停放浮线超限）、
 *    建议引擎（顺边 / 剪断重接 / 包绕·交锁，锁定纬跳过）、
 *    clone / resize / normalize 兼容（旧草稿无多梭数据）
 *  - UI：模态打开、梭子配置、区间分配、循环复制、拖动换序、锁定、
 *    应用建议（仅未锁定纬 + 可撤销）、梭道点击、打印梭次
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
w.createCanvas = createCanvas;

let pass = 0, fail = 0;
const $ = (sel) => w.document.querySelector(sel);
const $$ = (sel) => Array.from(w.document.querySelectorAll(sel));
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS -', name); }
  else { fail++; console.log('FAIL -', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const eng = fs.readFileSync(path.join(ROOT, 'static/engine.js'), 'utf8').replace(/'use strict';/, '');
const shui = fs.readFileSync(path.join(ROOT, 'static/shuttle-ui.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'static/app.js'), 'utf8').replace(/'use strict';/, '');

w.eval(eng + shui + app + `
  ;globalThis.F = {
    Engine, state, makeTemplate, handleShuttleTrackClick,
    pushHistory, afterEdit, afterStructural, undo, normalizeDraft, doPrint,
  };
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
`);
const F = w.F;
const E = F.Engine;
const state = F.state;

/* ===================================================================== *
 * 引擎：路径推演
 * ===================================================================== */
{
  // 未启用（全部未指定）→ 无布边校验
  const d = E.defaultDraft();
  let A = E.analyze(d);
  check('[引擎] 默认草稿多梭未启用', A.shuttle && A.shuttle.active === false);
  check('[引擎] 未启用时无布边问题', !A.validation.issues.some(i => i.code.startsWith('shuttle-')));

  // 正确 2 梭交替（每梭入梭边 = 上次离场边）：零布边问题
  // 梭0: L R R L L R R L ...（每两纬一对）；梭1 与之交错
  const seq = ['L', 'R', 'R', 'L'];
  d.shuttles.picks = d.shuttles.picks.map((_, p) => ({
    s: p % 2,
    enter: seq[Math.floor(p / 2) % 4],
    join: p > 0 ? 'wrap' : null,
  }));
  A = E.analyze(d);
  check('[引擎] 正确 2 梭交替零布边问题',
    !A.validation.issues.some(i => i.code.startsWith('shuttle-')),
    A.validation.issues.filter(i => i.code.startsWith('shuttle-')).map(i => i.msg));

  // 入梭边不一致：第 3 纬（idx2）梭1 应 R 入，改为 L
  d.shuttles.picks[2].enter = 'L';
  A = E.analyze(d);
  const entry = A.validation.issues.filter(i => i.code === 'shuttle-entry');
  check('[引擎] 入梭边不一致被检出', entry.length > 0 && entry[0].level === 'error');
  check('[引擎] 入梭边问题定位到对应纬与入梭侧布边',
    entry.some(i => i.loc.some(l => l.grid === 'drawdown' && l.r === 2 && l.c === 0)),
    entry.map(i => i.loc));

  // 换梭未交接：全部去掉 join
  const d2 = E.defaultDraft();
  d2.shuttles.picks = d2.shuttles.picks.map((_, p) => ({
    s: p % 2, enter: seq[Math.floor(p / 2) % 4], join: null,
  }));
  A = E.analyze(d2);
  const joins = A.validation.issues.filter(i => i.code === 'shuttle-join');
  check('[引擎] 换梭未交接逐纬报警（15 纬）', joins.length === 15 && joins.every(i => i.level === 'warn'),
    joins.length);
  check('[引擎] 未交接定位含本纬入梭边与上纬离场边（左右布边）',
    joins[0].loc.length === 2 &&
    joins[0].loc.some(l => l.r === 1 && l.c === d2.ends - 1) &&
    joins[0].loc.some(l => l.r === 0 && l.c === d2.ends - 1),
    joins[0] && joins[0].loc);
  // 同梭连织不需要交接
  const d3 = E.blankDraft(2, 2, 8, 4);
  d3.shuttles.picks = [
    { s: 0, enter: 'L', join: null },
    { s: 0, enter: 'R', join: null },
    { s: 0, enter: 'L', join: null },
    { s: 0, enter: 'R', join: null },
  ];
  A = E.analyze(d3);
  check('[引擎] 同梭连织不报未交接', !A.validation.issues.some(i => i.code === 'shuttle-join'));

  // 停放浮线超限 + 剪断重接豁免
  const d4 = E.blankDraft(2, 2, 8, 16);
  d4.shuttles.parkLimit = 4;
  d4.shuttles.picks = d4.shuttles.picks.map((_, p) => {
    if (p === 0) return { s: 0, enter: 'L', join: null };
    if (p === 10) return { s: 0, enter: 'R', join: null };
    return { s: 1, enter: seq[Math.floor((p - 1) / 2) % 4] === 'L' ? 'R' : 'L', join: p === 1 ? 'wrap' : null };
  });
  // 修正梭2的入梭边使其合法：梭2 home R，p1 R→L，p2 L→R ... 即奇偶交替
  d4.shuttles.picks = d4.shuttles.picks.map((a, p) => {
    if (!a || a.s === 0) return a;
    return { s: 1, enter: p % 2 === 1 ? 'R' : 'L', join: a.join };
  });
  A = E.analyze(d4);
  const floats = A.validation.issues.filter(i => i.code === 'shuttle-float');
  check('[引擎] 停放浮线超限被检出（10 纬 > 4）',
    floats.length === 1 && floats[0].msg.includes('10 纬'), floats.map(i => i.msg));
  check('[引擎] 停放浮线定位沿布边纵向跨越',
    floats.length === 1 && floats[0].loc.length === 11 &&
    floats[0].loc.every(l => l.c === d4.ends - 1),
    floats[0] && floats[0].loc.slice(0, 3));
  // 剪断重接后浮线不再超限
  d4.shuttles.picks[10].join = 'cut';
  A = E.analyze(d4);
  check('[引擎] 剪断重接豁免停放浮线', !A.validation.issues.some(i => i.code === 'shuttle-float'));

  // 部分指定 → 未指定纬警告
  const d5 = E.blankDraft(2, 2, 8, 6);
  d5.shuttles.picks[0] = { s: 0, enter: 'L', join: null };
  d5.shuttles.picks[1] = { s: 0, enter: 'R', join: null };
  A = E.analyze(d5);
  check('[引擎] 部分指定时报未指定纬', A.validation.issues.some(i => i.code === 'shuttle-unassigned'));
}

/* ===================================================================== *
 * 引擎：建议（顺边 / 剪断 / 包绕·交锁 / 锁定跳过）
 * ===================================================================== */
{
  const d = E.defaultDraft();
  // 全部入梭边故意写 L（梭0/梭1 交替），交接缺失
  d.shuttles.picks = d.shuttles.picks.map((_, p) => ({ s: p % 2, enter: 'L', join: null }));
  let sug = E.shuttleSuggest(d, 'wrap');
  check('[建议] 顺边与包绕建议成对出现',
    sug.changes.length > 0 && sug.changes.every(c => c.enter || c.join));
  check('[建议] 换梭建议为包绕', sug.changes.some(c => c.join === 'wrap'));
  // 应用全部建议 → 零布边问题
  sug.changes.forEach(c => {
    if (c.enter) d.shuttles.picks[c.pick].enter = c.enter;
    if (c.join) d.shuttles.picks[c.pick].join = c.join;
  });
  let A = E.analyze(d);
  check('[建议] 应用全部建议后零布边问题',
    !A.validation.issues.some(i => i.code.startsWith('shuttle-')),
    A.validation.issues.filter(i => i.code.startsWith('shuttle-')).map(i => i.msg));

  // 交锁偏好
  const d2 = E.defaultDraft();
  d2.shuttles.picks = d2.shuttles.picks.map((_, p) => ({ s: p % 2, enter: 'L', join: null }));
  sug = E.shuttleSuggest(d2, 'lock');
  check('[建议] 交锁偏好生效', sug.changes.some(c => c.join === 'lock'));

  // 停放浮线 → 剪断重接建议
  const d3 = E.blankDraft(2, 2, 8, 16);
  d3.shuttles.parkLimit = 3;
  d3.shuttles.picks = d3.shuttles.picks.map(() => null);
  d3.shuttles.picks[0] = { s: 0, enter: 'L', join: null };
  d3.shuttles.picks[12] = { s: 0, enter: 'R', join: null };
  sug = E.shuttleSuggest(d3, 'wrap');
  const cut = sug.changes.find(c => c.pick === 12);
  check('[建议] 超限停放浮线建议剪断重接', !!cut && cut.join === 'cut', cut);

  // 锁定纬只进 skipped，不进 changes
  const d4 = E.defaultDraft();
  d4.shuttles.picks = d4.shuttles.picks.map((_, p) => ({ s: p % 2, enter: 'L', join: null }));
  d4.shuttles.locked[5] = true;
  sug = E.shuttleSuggest(d4, 'wrap');
  check('[建议] 锁定纬不进 changes', !sug.changes.some(c => c.pick === 5));
  check('[建议] 锁定纬列入 skipped', sug.skipped.some(c => c.pick === 5));

  // 顺序顺边：修第 3 纬后，后续纬的停放边推演随之更新（不重复误修）
  const d5 = E.blankDraft(2, 2, 8, 8);
  // 梭0 连续 4 纬：L L L L（第 2 纬起应交替 R L R）
  d5.shuttles.picks = [0, 1, 2, 3].map(() => ({ s: 0, enter: 'L', join: null }));
  sug = E.shuttleSuggest(d5, 'wrap');
  const enters = sug.changes.filter(c => c.enter).map(c => ({ p: c.pick, e: c.enter }));
  check('[建议] 连织顺边推演为交替序列',
    eq(enters, [{ p: 1, e: 'R' }, { p: 2, e: 'L' }, { p: 3, e: 'R' }]), enters);
}

/* ===================================================================== *
 * 引擎：clone / resize / normalize 兼容
 * ===================================================================== */
{
  const d = E.defaultDraft();
  d.shuttles.picks[3] = { s: 1, enter: 'R', join: 'lock' };
  d.shuttles.locked[3] = true;
  const c = E.cloneDraft(d);
  check('[兼容] clone 深拷贝多梭数据',
    c.shuttles.picks[3].join === 'lock' && c.shuttles.locked[3] === true &&
    c.shuttles.picks[3] !== d.shuttles.picks[3]);

  const r = E.resize(d, { shafts: 4, treadles: 4, ends: 16, picks: 20 });
  check('[兼容] resize 扩展多梭数组',
    r.shuttles.picks.length === 20 && r.shuttles.locked.length === 20 &&
    r.shuttles.picks[3].join === 'lock' && r.shuttles.picks[19] === null);

  // 旧草稿（无 shuttles 字段）→ normalize 补默认；analyze 不炸
  const old = E.blankDraft(4, 4, 8, 8);
  delete old.shuttles;
  const n = E.normalizeShuttles(old.shuttles, old.picks);
  check('[兼容] 缺失多梭数据规整为默认', n.count === 2 && n.picks.length === 8 &&
    n.picks.every(x => x === null) && n.locked.every(x => x === false));
  const A = E.analyze(old);
  check('[兼容] 无多梭数据草稿 analyze 安全', A.shuttle === null &&
    !A.validation.issues.some(i => i.code.startsWith('shuttle-')));

  // 残缺数据：梭子号越界 / 非法交接 → 规整剔除
  const bad = E.normalizeShuttles({
    count: 2, colors: [1], home: ['X'],
    picks: [{ s: 9, enter: 'Z', join: 'glue' }, { s: 0, enter: 'R', join: 'cut' }],
    locked: [1],
  }, 2);
  check('[兼容] 残缺多梭数据被规整',
    bad.picks[0] === null && eq(bad.picks[1], { s: 0, enter: 'R', join: 'cut' }) &&
    bad.home[0] === 'L' && bad.locked[0] === true, bad);
}

/* ===================================================================== *
 * UI：模态 / 配置 / 批量工具
 * ===================================================================== */
{
  state.draft = F.makeTemplate('twill');
  F.afterStructural();

  $('#btnShuttle').click();
  check('[UI] 多梭模态打开', !$('#shuttleModal').classList.contains('hidden'));
  check('[UI] 梭子配置行数 = 2', $$('#shConfigList .sh-config-row').length === 2);
  check('[UI] 逐纬表行数 = 纬数', $$('#shPickRows tr').length === state.draft.picks);

  // 梭子数 2 → 4
  $('#shCount').value = 4;
  $('#shCount').dispatchEvent(new w.Event('change'));
  check('[UI] 梭子数改为 4', state.draft.shuttles.count === 4 &&
    $$('#shConfigList .sh-config-row').length === 4);
  check('[UI] 新梭子给默认纱色与停放边',
    state.draft.shuttles.colors.length === 4 && state.draft.shuttles.home.length === 4);

  // 区间分配：1–8 纬 → 梭1，左入，包绕
  $('#shRangeFrom').value = 1;
  $('#shRangeTo').value = 8;
  $('#shRangeShuttle').value = 0;
  $('#shRangeEnter').value = 'L';
  $('#shRangeJoin').value = 'wrap';
  $('#shRangeApply').click();
  const p = state.draft.shuttles.picks;
  check('[UI] 区间分配 8 纬为梭1', p.slice(0, 8).every(a => a && a.s === 0));
  check('[UI] 区间分配入梭边自动交替', eq(p.slice(0, 4).map(a => a.enter), ['L', 'R', 'L', 'R']),
    p.slice(0, 4).map(a => a.enter));
  check('[UI] 交接只落在区间首纬', p[0].join === 'wrap' && p[1].join === null);

  // 循环复制：前 8 纬为模板铺满 16 纬，入梭边顺推
  $('#shCycleLen').value = 8;
  $('#shCycleApply').click();
  check('[UI] 循环复制铺满', state.draft.shuttles.picks.every(a => a && a.s === 0));
  check('[UI] 循环复制入梭边顺推一致',
    !state.analysis.validation.issues.some(i => i.code === 'shuttle-entry'),
    state.analysis.validation.issues.filter(i => i.code === 'shuttle-entry').map(i => i.msg));

  // 锁定第 1–2 纬后批量清空：锁定纬保留
  state.draft.shuttles.locked[0] = true;
  state.draft.shuttles.locked[1] = true;
  F.afterEdit();
  $('#shClearAll').click();
  check('[UI] 清空跳过锁定纬',
    state.draft.shuttles.picks[0] && state.draft.shuttles.picks[1] &&
    state.draft.shuttles.picks.slice(2).every(a => a === null));

  // 撤销恢复
  F.undo();
  check('[UI] 撤销恢复批量清空', state.draft.shuttles.picks.every(a => a && a.s === 0));
}

/* ===================================================================== *
 * UI：换梭校验联动 / 建议应用（仅未锁定）/ 拖动换序
 * ===================================================================== */
{
  state.draft = F.makeTemplate('twill');
  F.afterStructural();
  if (!$('#shuttleModal').classList.contains('hidden')) $('#btnShuttle').click();
  $('#btnShuttle').click();   // 确保打开
  const s = state.draft.shuttles;

  // 构造：全部 2 梭交替但入梭边全 L、无交接 → 生成建议并应用
  s.picks = s.picks.map((_, i) => ({ s: i % 2, enter: 'L', join: null }));
  F.afterEdit();
  check('[UI] 布边问题进入主校验列表',
    state.analysis.validation.issues.some(i => i.code === 'shuttle-entry') &&
    state.analysis.validation.issues.some(i => i.code === 'shuttle-join'));

  // 锁定第 4 纬（idx 3）
  s.locked[3] = true;
  F.afterEdit();
  $('#shSuggest').click();
  const sug = w.__shuttleAPI.suggest();
  check('[UI] 建议生成且锁定纬被跳过',
    sug && sug.skipped.some(c => c.pick === 3) && !sug.changes.some(c => c.pick === 3));
  const before3 = { ...s.picks[3] };
  $('#shApplySuggest').click();
  check('[UI] 应用建议只调整未锁定纬',
    eq(s.picks[3], before3) && s.picks[3].enter === 'L');
  const remain = state.analysis.validation.issues.filter(i =>
    i.code === 'shuttle-entry' || i.code === 'shuttle-join');
  check('[UI] 应用后仅剩锁定纬相关布边问题', remain.length > 0 &&
    remain.every(i => i.loc.every(l => l.r === 3 || l.r === 2 || l.r === 4)),
    remain.map(i => i.msg));
  F.undo();
  check('[UI] 建议可撤销', s.picks[1].enter === 'L' && s.picks[1].join === null);

  // 拖动换序（交换第 1、3 纬的梭次）
  s.picks = s.picks.map(() => null);
  s.locked = s.locked.map(() => false);
  s.picks[0] = { s: 0, enter: 'L', join: null };
  s.picks[2] = { s: 1, enter: 'R', join: 'cut' };
  F.afterEdit();
  const rows = $$('#shPickRows tr');
  const dt = {
    effectAllowed: '', setData() {}, getData() { return ''; },
  };
  rows[0].dispatchEvent(new w.Event('dragstart', { bubbles: true }));
  Object.defineProperty(rows[2], 'dataset', { value: rows[2].dataset });
  const dropEv = new w.Event('drop', { bubbles: true, cancelable: true });
  dropEv.dataTransfer = dt;
  rows[2].dispatchEvent(dropEv);
  check('[UI] 拖动换序交换梭次',
    s.picks[0] && s.picks[0].s === 1 && s.picks[2] && s.picks[2].s === 0,
    [s.picks[0], s.picks[2]]);
  check('[UI] 换序保留交接方式', s.picks[0].join === 'cut');

  // 锁定行不可交换
  s.locked[0] = true;
  F.afterEdit();
  const rows2 = $$('#shPickRows tr');
  rows2[2].dispatchEvent(new w.Event('dragstart', { bubbles: true }));
  const dropEv2 = new w.Event('drop', { bubbles: true, cancelable: true });
  dropEv2.dataTransfer = dt;
  rows2[0].dispatchEvent(dropEv2);
  check('[UI] 锁定纬不参与换序', s.picks[0].s === 1 && s.picks[2].s === 0);
}

/* ===================================================================== *
 * UI：梭道点击 / 旧草稿打开 / 打印
 * ===================================================================== */
{
  state.draft = F.makeTemplate('plain');
  F.afterStructural();

  // 梭道点击：循环分配，入梭边自动顺推
  F.handleShuttleTrackClick({ r: 0 }, false);
  F.handleShuttleTrackClick({ r: 1 }, false);
  F.handleShuttleTrackClick({ r: 2 }, false);
  F.handleShuttleTrackClick({ r: 2 }, false);   // 第 3 纬再点 → 梭2
  const sp = state.draft.shuttles.picks;
  check('[UI] 梭道点击循环分配梭子',
    sp[0].s === 0 && sp[1].s === 0 && sp[2].s === 1, sp.slice(0, 3));
  check('[UI] 梭道点击入梭边自动顺推',
    sp[0].enter === 'L' && sp[1].enter === 'R' && sp[2].enter === state.draft.shuttles.home[1],
    sp.slice(0, 3).map(a => a.enter));
  F.handleShuttleTrackClick({ r: 2 }, true);    // 右键清除
  check('[UI] 梭道右键清除', state.draft.shuttles.picks[2] === null);

  // 锁定纬点击无效
  state.draft.shuttles.locked[0] = true;
  const keep = { ...state.draft.shuttles.picks[0] };
  F.handleShuttleTrackClick({ r: 0 }, false);
  check('[UI] 锁定纬梭道点击被拒', eq(state.draft.shuttles.picks[0], keep));

  // 旧草稿（无 shuttles）经 loadDraft 路径打开
  const oldDraft = F.Engine.blankDraft(4, 4, 8, 8);
  delete oldDraft.shuttles;
  const norm = F.normalizeDraft(oldDraft);
  check('[UI] 旧草稿打开自动补多梭数据',
    norm.shuttles && norm.shuttles.count === 2 && norm.shuttles.picks.length === 8);
  const A = F.Engine.analyze(norm);
  check('[UI] 旧草稿无布边问题',
    !A.validation.issues.some(i => i.code.startsWith('shuttle-')));

  // 打印：含按纬梭次与布边警告
  state.draft = F.makeTemplate('twill');
  F.afterStructural();
  state.draft.shuttles.picks = state.draft.shuttles.picks.map((_, i) =>
    ({ s: i % 2, enter: 'L', join: null }));
  F.afterEdit();
  w.print = () => {};
  let printErr = null;
  try { F.doPrint(); } catch (e) { printErr = e.stack; }
  check('[UI] 打印渲染不抛错', printErr === null, printErr);
  const legend = $('#printLegend').innerHTML;
  check('[UI] 打印图附按纬梭次', legend.includes('按纬梭次') && legend.includes('1:1→'));
  check('[UI] 打印图附布边警告', legend.includes('布边警告') && legend.includes('入梭'));
}

console.log(`\nRESULT: ${fail ? 'FAIL' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
