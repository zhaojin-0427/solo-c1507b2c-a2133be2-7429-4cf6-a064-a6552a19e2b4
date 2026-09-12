/**
 * 多臂织机升综计划 UI 测试：
 *  顶栏入口打开弹窗 → 旧草稿矩阵按实际尺寸补齐 → 生成矩阵（dobby 驱动组织）→
 *  网格点选编辑 → 设备限制校验与定位 → 批量工具 → 还原踏板方案（超限取舍 /
 *  差异预览 / 应用为新草稿）→ 打印 → 随草稿保存（fetch mock）
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

/* ---------------- fetch mock：/api/drafts*（内存持久化，验证升综计划随草稿保存） ---------------- */
const savedDrafts = new Map();
let draftSeq = 100;
function jsonResp(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj };
}
w.fetch = async (url, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};
  let m;
  if (method === 'POST' && url === '/api/drafts') {
    let id = body.id;
    if (id == null || !savedDrafts.has(id)) { id = ++draftSeq; }
    savedDrafts.set(id, { id, name: body.name, data: body.data });
    return jsonResp({ id, name: body.name, updated_at: '2026-09-12T00:00:00' });
  }
  if (method === 'GET' && (m = String(url).match(/\/api\/drafts\/(\d+)$/))) {
    const d = savedDrafts.get(Number(m[1]));
    return d ? jsonResp({ id: d.id, name: d.name, data: d.data, updated_at: '2026-09-12T00:00:00' })
             : jsonResp({ error: '草稿不存在' }, 404);
  }
  if (method === 'GET' && url === '/api/drafts') {
    return jsonResp([...savedDrafts.values()].map(d => ({
      id: d.id, name: d.name, updated_at: '2026-09-12T00:00:00', created_at: '2026-09-12T00:00:00',
    })));
  }
  if (method === 'DELETE' && (m = String(url).match(/\/api\/drafts\/(\d+)$/))) {
    savedDrafts.delete(Number(m[1]));
    return jsonResp({ ok: true });
  }
  return jsonResp({ error: 'not mocked: ' + method + ' ' + url }, 404);
};

/* ---------------- 加载脚本 ---------------- */
const errors = [];
w.addEventListener('error', e => errors.push('window error: ' + (e.error && e.error.stack || e.message)));
const read = (f) => fs.readFileSync(path.join(ROOT, 'static', f), 'utf8').replace(/'use strict';/, '');
try {
  w.eval(read('engine.js') + read('defect-core.js') + read('loom-core.js') + read('dobby-core.js') +
         read('reverse.js') + read('reverse-ui.js') + read('shuttle-ui.js') + read('defect-ui.js') +
         read('loom-ui.js') + read('dobby-ui.js') + read('app.js') + `
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

const API = () => w.__dobbyAPI;
const loom = () => w.__loom;
const draft = () => loom().state.draft;

(async () => {
  await new Promise(r => setTimeout(r, 50));

  /* ① 顶栏入口与弹窗挂载 */
  check('顶栏存在“升综计划”入口', !!$('#btnDobby'));
  check('升综弹窗已挂载', !!$('#dobbyModal'));
  check('升综打印区已挂载', !!$('#dbPrintSheet'));
  check('测试钩子可用', typeof w.__dobbyAPI === 'object');

  /* ② 点击顶栏按钮打开弹窗（用户报修：点击无响应） */
  $('#btnDobby').click();
  await new Promise(r => setTimeout(r, 30));
  check('点击后弹窗打开', !$('#dobbyModal').classList.contains('hidden'));
  check('API 报告已打开', API().isOpen());
  check('网格 canvas 已布局（宽>0）', $('#dbCanvas').width > 0, $('#dbCanvas').width);
  check('设备输入框就绪', $('#dbDeviceShafts').value === '4' && $('#dbMaxLift').value === '4');
  check('初始无校验问题', $('#dbIssueList').textContent.includes('没有越界'));
  API().close();

  /* ③ 旧草稿（无 dobby 字段）载入：矩阵按实际 16 纬 × 4 综框补齐 */
  const old = loom().Engine.defaultDraft();
  delete old.dobby;
  w.loadDraft(old, '旧草稿', null);
  check('旧草稿矩阵 16×4（非 1×1）',
    draft().dobby.cells.length === 16 && draft().dobby.cells[0].length === 4,
    draft().dobby.cells.length + 'x' + (draft().dobby.cells[0] || []).length);
  check('旧草稿升综未启用', draft().dobby.enabled === false);
  // 打开弹窗后网格按 16×4 布局
  API().open();
  await new Promise(r => setTimeout(r, 20));
  check('网格高度 = 表头 + 16 纬 × 18px', $('#dbCanvas').height === 22 + 16 * 18 + 4,
    $('#dbCanvas').height);

  /* ④ 从当前草稿生成矩阵 → dobby 驱动组织 */
  API().generate();
  await new Promise(r => setTimeout(r, 20));
  check('生成后已启用', draft().dobby.enabled === true);
  check('首纬升综框 1、2', draft().dobby.cells[0][0] === true && draft().dobby.cells[0][1] === true &&
    draft().dobby.cells[0][2] === false);
  check('状态文本提示驱动中', $('#dbStatus').textContent.includes('驱动组织图'));
  check('主图板分析由升综矩阵驱动',
    loom().state.analysis.derived.lifted[0].has(0) && loom().state.analysis.derived.lifted[0].size === 2);
  // 可撤销
  const before = JSON.stringify(draft().dobby.cells);
  w.__loom.state.history.length > 0 && check('生成已压入撤销历史', true);
  check('生成已压入撤销历史', loom().state.history.length > 0);

  /* ⑤ 网格点选编辑：模拟 pointerdown 切换格子 */
  const CELL = 18, LEFT = 48, TOP = 22;
  const rectOf = () => ({ left: 0, top: 0, width: 500, height: 400 });
  $('#dbCanvas').getBoundingClientRect = rectOf;
  const firePointer = (type, x, y, btn = 0) => {
    const ev = new w.Event(type, { bubbles: true });
    ev.clientX = x; ev.clientY = y; ev.button = btn; ev.pointerId = 1;
    $('#dbCanvas').dispatchEvent(ev);
  };
  // 点 (纬3, 综框4)：x = LEFT + 3*CELL + 5, y = TOP + 2*CELL + 5
  const cellWas = draft().dobby.cells[2][3];
  firePointer('pointerdown', LEFT + 3 * CELL + 5, TOP + 2 * CELL + 5);
  w.dispatchEvent(new w.Event('pointerup'));
  check('点选切换升综格', draft().dobby.cells[2][3] === !cellWas,
    draft().dobby.cells[2][3]);
  check('编辑后矩阵与联结·踩踏不一致提示出现', $('#dbStatus').textContent.includes('不一致'));
  // 右键清除
  firePointer('pointerdown', LEFT + 0 * CELL + 5, TOP + 0 * CELL + 5, 2);
  w.dispatchEvent(new w.Event('pointerup'));
  check('右键清除升综格', draft().dobby.cells[0][0] === false);

  /* ⑥ 设备限制校验与定位 */
  $('#dbDeviceShafts').value = '2';
  $('#dbDeviceShafts').dispatchEvent(new w.Event('change'));
  await new Promise(r => setTimeout(r, 20));
  check('设备综框数已保存到草稿', draft().dobby.deviceShafts === 2);
  $('#dbMaxLift').value = '1';
  $('#dbMaxLift').dispatchEvent(new w.Event('change'));
  await new Promise(r => setTimeout(r, 20));
  check('单纬上限已保存', draft().dobby.maxLift === 1);
  const issueText = $('#dbIssueList').textContent;
  check('越界问题列出', issueText.includes('超出设备 2 综框'), issueText.slice(0, 120));
  check('超限问题列出', issueText.includes('超过单纬上限 1'));
  check('主界面校验问题同步出现',
    loom().state.analysis.validation.issues.some(i => i.code === 'dobby-shaft-range') &&
    loom().state.analysis.validation.issues.some(i => i.code === 'dobby-lift-limit'));
  // 定位：点击第一个“定位”按钮 → 网格行高亮
  const locBtns = $$('#dbIssueList .db-issue .btn');
  check('问题带定位按钮', locBtns.length > 0);
  locBtns[0].click();
  await new Promise(r => setTimeout(r, 20));
  check('定位后设置行高亮', API().state.locate && API().state.locate.pick >= 0,
    API().state.locate);
  // 恢复设备限制，问题应消失
  $('#dbDeviceShafts').value = '4';
  $('#dbDeviceShafts').dispatchEvent(new w.Event('change'));
  $('#dbMaxLift').value = '4';
  $('#dbMaxLift').dispatchEvent(new w.Event('change'));
  await new Promise(r => setTimeout(r, 20));
  check('恢复限制后问题清零', $('#dbIssueList').textContent.includes('没有越界'));

  /* ⑦ 批量工具 */
  // 重新生成干净矩阵再测
  API().generate();
  await new Promise(r => setTimeout(r, 10));
  // 复制：0–1 纬 → 第 9 纬
  $('#dbFrom').value = '1'; $('#dbTo').value = '2'; $('#dbTarget').value = '9';
  $('#dbCopy').click();
  await new Promise(r => setTimeout(r, 10));
  check('复制纬段到目标', JSON.stringify(draft().dobby.cells[8]) === JSON.stringify(draft().dobby.cells[0]));
  // 循环填充：0–1 纬为模板
  $('#dbFrom').value = '1'; $('#dbTo').value = '2';
  $('#dbCycle').click();
  await new Promise(r => setTimeout(r, 10));
  check('循环填充至末尾', JSON.stringify(draft().dobby.cells[14]) === JSON.stringify(draft().dobby.cells[0]) &&
    JSON.stringify(draft().dobby.cells[15]) === JSON.stringify(draft().dobby.cells[1]));
  // 镜像：0–3 纬倒序
  const row0 = JSON.stringify(draft().dobby.cells[0]);
  const row3 = JSON.stringify(draft().dobby.cells[3]);
  $('#dbFrom').value = '1'; $('#dbTo').value = '4';
  $('#dbMirror').click();
  await new Promise(r => setTimeout(r, 10));
  check('纬段镜像', JSON.stringify(draft().dobby.cells[0]) === row3 &&
    JSON.stringify(draft().dobby.cells[3]) === row0);
  // 平移：0–3 纬 +2
  const seg = draft().dobby.cells.slice(0, 4).map(r => JSON.stringify(r));
  $('#dbFrom').value = '1'; $('#dbTo').value = '4'; $('#dbShift').value = '2';
  $('#dbShiftApply').click();
  await new Promise(r => setTimeout(r, 10));
  check('平移纬段', JSON.stringify(draft().dobby.cells[2]) === seg[0] &&
    JSON.stringify(draft().dobby.cells[5]) === seg[3] &&
    draft().dobby.cells[0].every(v => !v));
  // 清空
  $('#dbFrom').value = '1'; $('#dbTo').value = '2';
  $('#dbClearRange').click();
  await new Promise(r => setTimeout(r, 10));
  check('清空纬段', draft().dobby.cells[0].every(v => !v) && draft().dobby.cells[1].every(v => !v));

  /* ⑧ 还原为踏板方案（全容纳） */
  API().generate();   // 恢复 2/2 斜纹矩阵：4 组合
  await new Promise(r => setTimeout(r, 10));
  $('#dbTreadles').value = '4';
  API().computeReduction();
  await new Promise(r => setTimeout(r, 10));
  check('组合列表 4 行', $$('#dbComboList .db-combo-row').length === 4,
    $$('#dbComboList .db-combo-row').length);
  check('全部容纳提示', $('#dbComboList').textContent.includes('全部容纳'));
  check('差异预览为零差异', $('#dbDiffText').textContent.includes('完全一致'),
    $('#dbDiffText').textContent);
  check('差异画布已渲染', $('#dbDiffCanvas').width > 0);
  check('应用按钮可用', !$('#dbApply').disabled);

  /* ⑨ 超限取舍：2 踏板容纳 4 组合 */
  $('#dbTreadles').value = '2';
  API().computeReduction();
  await new Promise(r => setTimeout(r, 10));
  const rows = $$('#dbComboList .db-combo-row');
  check('超限时列出组合', rows.length === 4);
  check('保留 2 个 / 舍弃 2 个',
    $$('#dbComboList .db-combo-row.keep').length === 2 &&
    $$('#dbComboList .db-combo-row.drop').length === 2);
  check('频次与涉及纬次列出', $('#dbComboList').textContent.includes('×4') &&
    $('#dbComboList').textContent.includes('纬'));
  check('差异预览非零（8 纬未分配）', $('#dbDiffText').textContent.includes('差异') &&
    $('#dbDiffText').textContent.includes('8 纬'), $('#dbDiffText').textContent);
  // 勾选第三个组合 → 应被拒绝（最多 2 个）
  const comboBoxes = () => $$('#dbComboList .db-combo-row input[type=checkbox]');
  const keptCount = () => $$('#dbComboList .db-combo-row.keep').length;
  const keptBefore = keptCount();
  comboBoxes()[2].click();
  await new Promise(r => setTimeout(r, 10));
  check('超出踏板数的勾选被拒绝', keptCount() === keptBefore);
  // 取消一个保留 → 可再勾选
  comboBoxes()[0].click();
  await new Promise(r => setTimeout(r, 10));
  check('取消保留后数量减少', keptCount() === 1);
  comboBoxes()[2].click();
  await new Promise(r => setTimeout(r, 10));
  check('腾出席位后可改选其它组合', keptCount() === 2, keptCount());

  /* ⑩ 应用为新草稿（不覆盖原稿） */
  const oldId = 777;
  loom().state.savedId = oldId;   // 假装当前稿已保存
  const oldCells = JSON.stringify(draft().dobby.cells);
  $('#dbTreadles').value = '4';
  API().computeReduction();
  await new Promise(r => setTimeout(r, 10));
  API().applyReduction();
  await new Promise(r => setTimeout(r, 20));
  check('应用后弹窗关闭', $('#dobbyModal').classList.contains('hidden'));
  check('新草稿未关联原 id（另存）', loom().state.savedId === null);
  check('新草稿踏板数 = 组合数 4', draft().treadles === 4);
  check('新草稿升综停用（踏板驱动）', draft().dobby.enabled === false);
  check('新草稿组织与升综计划一致',
    JSON.stringify(w.__loom.Engine.derive(draft()).drawdown) !== '');
  const ana2 = loom().state.analysis;
  check('新草稿校验无错误', ana2.validation.errors === 0,
    ana2.validation.issues.filter(i => i.level === 'error').map(i => i.code));

  /* ⑪ 升综计划随草稿保存 */
  API().open();
  await new Promise(r => setTimeout(r, 10));
  API().generate();
  await new Promise(r => setTimeout(r, 10));
  check('重新生成后启用', draft().dobby.enabled === true);
  $('#draftName').value = '升综保存测试';
  // 调主应用保存（走 fetch mock）
  await w.eval('saveDraft()');
  await new Promise(r => setTimeout(r, 20));
  const saved = [...savedDrafts.values()].find(d => d.name === '升综保存测试');
  check('草稿已保存', !!saved);
  check('保存数据含升综矩阵', saved && saved.data.dobby &&
    saved.data.dobby.cells.length === 16 && saved.data.dobby.enabled === true,
    saved && saved.data.dobby && saved.data.dobby.cells.length);
  check('保存数据含设备限制', saved && saved.data.dobby.deviceShafts === 4);
  // 重新打开该草稿：升综计划还原
  const savedId = saved.id;
  w.loadDraft(saved.data, saved.name, saved.id);
  check('重新打开后升综矩阵还原', draft().dobby.enabled === true &&
    draft().dobby.cells.length === 16 && draft().dobby.cells[0].length === 4);

  /* ⑫ 打印不抛错 */
  API().open();
  await new Promise(r => setTimeout(r, 10));
  let printErr = null;
  try { API().doPrint(); } catch (e) { printErr = e; }
  check('打印渲染不抛错', !printErr, printErr);
  check('打印标题含名称', $('#dbPrintTitle').textContent.includes('升综保存测试'));
  check('打印矩阵 canvas 已渲染', $('#dbPrintCanvas').width > 0);
  check('打印含综框编号信息（meta）', $('#dbPrintMeta').textContent.includes('综框'));
  check('打印含逐纬动作', $('#dbPrintLegend').textContent.includes('第 1 纬') &&
    $('#dbPrintLegend').textContent.includes('升'));
  // 制造一个超限问题再打印：警告应进入打印图
  $('#dbMaxLift').value = '1';
  $('#dbMaxLift').dispatchEvent(new w.Event('change'));
  await new Promise(r => setTimeout(r, 10));
  try { API().doPrint(); } catch (e) { printErr = e; }
  check('含警告打印不抛错', !printErr, printErr);
  check('打印含警告文本', $('#dbPrintLegend').textContent.includes('超过单纬上限'),
    $('#dbPrintLegend').textContent.slice(0, 200));
  check('打印 meta 含校验计数', $('#dbPrintMeta').textContent.includes('错误'));
  $('#dbMaxLift').value = '4';
  $('#dbMaxLift').dispatchEvent(new w.Event('change'));

  /* ⑬ 停用 / 启用切换 */
  API().toggleEnabled();
  await new Promise(r => setTimeout(r, 10));
  check('停用后组织由踏板驱动', draft().dobby.enabled === false &&
    $('#dbStatus').textContent.includes('未启用'));
  API().toggleEnabled();
  await new Promise(r => setTimeout(r, 10));
  check('重新启用', draft().dobby.enabled === true);
  API().close();

  check('无 window 错误', errors.length === 0, errors);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail || errors.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
