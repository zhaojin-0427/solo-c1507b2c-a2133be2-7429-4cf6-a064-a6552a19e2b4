/**
 * 双层织物校核 UI 测试（jsdom + node-canvas，fetch mock）：
 *  弹窗挂载 / 旧草稿直接打开 / 分层 / 接结区 / 锁定格 / 问题定位 /
 *  踏板候选生成与差异叠色 / 穿综混穿阻断 /
 *  锁定穿综与主编辑区双向同步（关闭弹窗后仍生效）/
 *  采纳立即 POST 另存（草稿库新增、新稿踏板不越界、无缺失格）/
 *  越界锁格坐标直接丢弃 / 打印不抛错
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
w.confirm = () => true;
w.print = () => {};
w.createCanvas = createCanvas;

let pass = 0, fail = 0;
const $ = (s) => w.document.querySelector(s);
const $$ = (s) => Array.from(w.document.querySelectorAll(s));
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS -', name); }
  else { fail++; console.log('FAIL -', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------------- fetch mock：/api/drafts 内存持久化 ---------------- */
const savedDrafts = new Map();
let draftSeq = 100;
const postLog = [];
function jsonResp(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj };
}
w.fetch = async (url, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};
  let m;
  if (method === 'POST' && url === '/api/drafts') {
    postLog.push({ name: body.name, data: body.data });
    let id = body.id;
    if (id == null || !savedDrafts.has(id)) id = ++draftSeq;
    savedDrafts.set(id, { id, name: body.name, data: body.data });
    return jsonResp({ id, name: body.name, updated_at: '2026-09-12T00:00:00' });
  }
  if (method === 'GET' && (m = String(url).match(/\/api\/drafts\/(\d+)$/))) {
    const d = savedDrafts.get(Number(m[1]));
    return d ? jsonResp({ id: d.id, name: d.name, data: d.data }) : jsonResp({ error: '不存在' }, 404);
  }
  if (method === 'GET' && url === '/api/drafts') {
    return jsonResp([...savedDrafts.values()].map(d => ({ id: d.id, name: d.name })));
  }
  return jsonResp({ error: 'not mocked ' + method + ' ' + url }, 404);
};

/* ---------------- 加载脚本 ---------------- */
const errors = [];
w.addEventListener('error', e => errors.push('window error: ' + (e.error && e.error.stack || e.message)));
const read = (f) => fs.readFileSync(path.join(ROOT, 'static', f), 'utf8').replace(/'use strict';/, '');
try {
  w.eval(read('engine.js') + read('defect-core.js') + read('loom-core.js') + read('dobby-core.js') +
    read('double-core.js') +
    read('reverse.js') + read('reverse-ui.js') + read('shuttle-ui.js') + read('defect-ui.js') +
    read('loom-ui.js') + read('dobby-ui.js') + read('double-ui.js') + read('app.js') + `
  boardEl = document.querySelector('#board');
  baseCvs = createCanvas(10, 10); ovCvs = createCanvas(10, 10);
  baseCvs.style = {}; ovCvs.style = {};
  baseCtx = baseCvs.getContext('2d'); ovCtx = ovCvs.getContext('2d');
  dpr = 1;
  state.analysis = Engine.analyze(state.draft);
  syncInputs(); buildPalette(); refreshTreadleBrush();
  resizeCanvases(); refreshIssues(); refreshStats(); refreshPreviews();
  `);
} catch (e) { errors.push('eval: ' + e.stack); }

const API = () => w.__dlAPI;
const loom = () => w.__loom;
const draft = () => loom().state.draft;

/** 构造正确的双层平纹测试稿（与 test/double-core.js 同构） */
function doubleDraft() {
  const d = loom().Engine.blankDraft(8, 4, 8, 8);
  d.threading = [0, 1, 0, 1, 4, 5, 4, 5];
  d.tieup = [
    [1, 1, 0, 1], [0, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0],
    [0, 1, 0, 0], [0, 0, 0, 1], [0, 1, 0, 0], [0, 0, 0, 1],
  ];
  d.treadling = [0, 1, 2, 3, 0, 1, 2, 3];
  d.double = loom().Engine.normalizeDouble({
    enabled: true,
    warpLayer: [0, 0, 0, 0, 1, 1, 1, 1],
    pickLayer: [0, 1, 0, 1, 0, 1, 0, 1],
    zones: [], structure: 'tube', foldSide: 'L',
  }, 8, 8);
  return d;
}

(async () => {
  await new Promise(r => setTimeout(r, 50));

  /* ① 挂载 */
  check('顶栏存在“双层校核”入口', !!$('#btnDouble'));
  check('双层弹窗已挂载', !!$('#doubleModal'));
  check('双层打印区已挂载', !!$('#dlPrintSheet'));
  check('测试钩子可用', typeof w.__dlAPI === 'object');
  check('加载无 window 错误', errors.length === 0, errors);

  /* ② 旧草稿（无 double 字段）直接打开 */
  const old = loom().Engine.defaultDraft();
  delete old.double;
  w.loadDraft(old, '旧草稿', null);
  check('旧草稿自动补齐 double（停用）', !!draft().double && draft().double.enabled === false);
  $('#btnDouble').click();
  await new Promise(r => setTimeout(r, 30));
  check('旧草稿可直接打开工作区', API().isOpen() && !$('#doubleModal').classList.contains('hidden'));
  check('旧稿分层带按尺寸补齐（16/16）',
    draft().double.warpLayer.length === 16 && draft().double.pickLayer.length === 16);
  check('合并表面画布已布局', $('#dlMergedBase').width > 0);
  API().close();

  /* ③ 载入双层稿：启用 / 分层 / 结构 / 问题列表 */
  w.loadDraft(doubleDraft(), '双层测试', null);
  API().open();
  await new Promise(r => setTimeout(r, 20));
  check('启用勾选与配置一致', $('#dlEnabled').checked === true);
  check('正确双层稿无 error', API().model().errors === 0, API().model().issues.map(i => i.code));
  // 筒织无接结区会有 1 条“无接结”警告；错误徽章应为绿色（无错无警需敞开无接结结构）
  check('问题数徽章反映仅 1 条警告',
    API().model().errors === 0 && API().model().warns === 1);

  // 纬奇偶交替（重复应用幂等）
  API().pickAlternate();
  check('纬奇偶交替', eq(draft().double.pickLayer, [0, 1, 0, 1, 0, 1, 0, 1]));
  API().warpSplit();
  check('经前后半分层', eq(draft().double.warpLayer, [0, 0, 0, 0, 1, 1, 1, 1]));
  API().setStruct('open');
  check('结构切换为敞开', draft().double.structure === 'open');
  API().setFoldSide('R');
  check('折边方向可改（敞开不报错）', draft().double.foldSide === 'R');

  /* ④ 接结区 / 锁定格（圈选 API） */
  API().addZone(0, 4, 0, 6);
  check('接结区已写入草稿', draft().double.zones.some(z => eq(z, [0, 4, 0, 6])));
  API().toggleLockCell(2, 3);
  check('组织格已锁定', draft().double.lockedCells.some(q => eq(q, [2, 3])));
  API().toggleLockCell(2, 3);
  check('再次切换为解锁', !draft().double.lockedCells.some(q => eq(q, [2, 3])));

  /* ⑤ 制造错误 → 问题定位 */
  draft().treadling[1] = 0;
  loom().afterEdit();
  await new Promise(r => setTimeout(r, 20));
  check('破坏后问题列表非空', API().model().errors >= 1);
  const firstIssueBtn = $('#dlIssueList .dl-issue .btn');
  check('问题项带“定位”按钮', !!firstIssueBtn);
  firstIssueBtn && firstIssueBtn.click();
  check('定位产生追溯信息（含主图板定位按钮）', !!$('#dlTraceMain'));
  check('追溯文本含综框 / 升落信息',
    /综框|升起|落下/.test($('#dlHoverInfo').textContent));

  /* ⑥ 搜索踏板候选：重复穿综的可修复错误必须能产生候选 */
  API().runSearch();
  await new Promise(r => setTimeout(r, 20));
  const candRows = $$('#dlCandList .dl-cand');
  check('候选行已渲染（基线 + 修复）', candRows.length >= 2, candRows.length);
  const radios = $$('#dlCandList input[type=radio]');
  // 选第一个非基线候选
  const labels = $$('#dlCandList label.dl-cand');
  const fixLabel = labels.find(l => !l.classList.contains('base'));
  check('存在可采纳的修复候选', !!fixLabel);
  fixLabel && fixLabel.querySelector('input').click();
  await new Promise(r => setTimeout(r, 20));
  check('选中后采纳按钮可用', !$('#dlAdopt').disabled);
  check('选中后差异叠色已计算', !!API().state.diff && API().state.diff.count > 0);
  const selected = API().state.candidates[API().state.selected];
  check('候选为联结/踩踏 patch', selected && selected.patch.mode === 'treadle');
  check('候选错误数低于基线', selected.errors < API().state.candidates.find(c => c.key === 'base').errors);

  /* ⑦ 采纳立即另存：POST 落库 + loadDraft 新 id + 踏板不越界 */
  const savedBefore = savedDrafts.size;
  await API().adoptCandidate();
  await new Promise(r => setTimeout(r, 30));
  check('采纳触发 POST /api/drafts', postLog.length >= 1);
  check('草稿库新增记录', savedDrafts.size === savedBefore + 1);
  check('采纳后弹窗关闭', !API().isOpen());
  check('当前稿 savedId 指向新记录', loom().state.savedId != null && savedDrafts.has(loom().state.savedId));
  check('草稿名带“双层修复”', /双层修复/.test($('#draftName').value));
  const nd = draft();
  check('新稿踩踏值均不越界', nd.treadling.every(t => t >= 0 && t < nd.treadles));
  const dv = loom().Engine.derive(nd);
  check('新稿组织图无缺失格', dv.drawdown.every(row => row.every(v => v !== null)));
  check('新稿双层配置保留', nd.double.enabled === true);

  /* ⑧ 穿综混穿 → 阻断候选（不可采纳） */
  const d2 = doubleDraft();
  d2.threading[4] = 0;   // 下层经穿入上层综框 1
  w.loadDraft(d2, '混穿', null);
  API().open();
  await new Promise(r => setTimeout(r, 20));
  API().runSearch();
  check('混穿显示阻断说明', !!$('.dl-cand.dl-blocked'));
  check('阻断时采纳按钮禁用', $('#dlAdopt').disabled);
  API().close();

  /* ⑨ 锁定穿综与主编辑区双向同步，关闭弹窗后仍生效 */
  w.loadDraft(doubleDraft(), '锁测试', null);
  API().open();
  await new Promise(r => setTimeout(r, 20));
  check('打开时勾选状态跟随主状态（初始 false）', $('#dlLockThreading').checked === false);
  $('#dlLockThreading').checked = true;
  $('#dlLockThreading').dispatchEvent(new w.Event('change'));
  check('勾选同步到 state.lockThreading', loom().state.lockThreading === true);
  check('勾选同步到主编辑区复选框', $('#lockThreading').checked === true);
  API().close();
  check('关闭工作区后穿综仍锁定', loom().state.lockThreading === true);
  // 反向：主编辑区解锁后再开弹窗
  $('#lockThreading').checked = false;
  $('#lockThreading').dispatchEvent(new w.Event('change'));
  API().open();
  check('主编辑区解锁同步到工作区勾选', $('#dlLockThreading').checked === false);
  API().close();

  /* ⑩ 越界锁格坐标直接丢弃（不钳制到右下角末格） */
  const norm = loom().Engine.normalizeDouble({
    enabled: true, lockedCells: [[99, 99], [-1, 0], [0, 99], [2, 2]],
  }, 4, 4);
  check('越界锁格丢弃、合法保留', eq(norm.lockedCells, [[2, 2]]), norm.lockedCells);
  const norm2 = loom().Engine.normalizeDouble({ enabled: true, lockedCells: [[3, 3], [99, 99]] }, 4, 4);
  check('越界不误锁右下角末格', norm2.lockedCells.length === 1 && eq(norm2.lockedCells[0], [3, 3]));

  /* ⑪ 播放 / 打印不抛错 */
  API().open();
  API().stepPick(1);
  check('截面单步到第 2 纬', API().state.pick === 1);
  API().stopPlay();
  let printErr = null;
  try { API().doPrint(); } catch (e) { printErr = e.stack; }
  check('打印不抛错', printErr === null, printErr);
  await new Promise(r => setTimeout(r, 200));
  API().close();

  /* ⑫ 配置随草稿保存：保存体含完整 double 结构 */
  const lastSave = postLog[postLog.length - 1];
  check('保存体含 double 配置', lastSave && lastSave.data &&
    Array.isArray(lastSave.data.double.warpLayer) &&
    Array.isArray(lastSave.data.double.zones));

  check('无 window 错误（收尾）', errors.length === 0, errors);

  console.log(`\n${fail ? 'RESULT: FAIL (' + fail + ')' : 'RESULT: ALL PASS'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e.stack); process.exit(1); });
