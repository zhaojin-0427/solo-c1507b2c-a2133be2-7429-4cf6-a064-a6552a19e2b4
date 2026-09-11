/**
 * 上机工艺单 UI 测试：
 *  顶栏入口存在 → 打开弹窗 → 计算预览（推算 + 穿筘候选）→ 冻结建立 →
 *  步骤顺序确认 / 倒序撤回 → 草稿变化后复制新版（原单失效标记）→
 *  打印不抛错 → 定位钩子 → 重新打开后进度保留（fetch mock 持久化）
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
w.cancelAnimationFrame = () => 0;
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

/* ---------------- fetch mock：/api/sheets*（内存持久化，模拟 SQLite） ---------------- */
const sheets = new Map();
let sheetSeq = 0, stepSeq = 0;

function jsonResp(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj };
}
function sheetSummary(s) {
  return {
    id: s.id, name: s.name, draftId: s.draftId, draftName: s.draftName,
    fingerprint: s.fingerprint, version: s.version, parentId: s.parentId,
    status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt,
    stepCount: s.steps.length,
    doneCount: s.steps.filter(t => t.done).length,
    staleCount: s.steps.filter(t => t.stale).length,
  };
}
function stepOut(t) {
  return { id: t.id, index: t.index, kind: t.kind, label: t.label, detail: t.detail,
           done: t.done, doneAt: t.doneAt, stale: t.stale };
}
function insertSheet(body, version, parentId) {
  const id = ++sheetSeq;
  const ts = new Date().toISOString();
  const s = {
    id, name: body.name, draftId: body.draftId ?? null, draftName: body.draftName,
    snapshot: body.snapshot, params: body.params, derived: body.derived,
    reedPlan: body.reedPlan, fingerprint: body.fingerprint,
    version, parentId, status: 'open', createdAt: ts, updatedAt: ts,
    steps: body.steps.map((st, i) => ({
      id: ++stepSeq, index: i, kind: st.kind, label: st.label, detail: st.detail,
      done: false, doneAt: null, stale: false,
    })),
  };
  sheets.set(id, s);
  return s;
}
const sig = (st) => `${st.kind}|${st.label}|${JSON.stringify(st.detail)}`;

w.fetch = async (url, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};
  let m;

  if (method === 'GET' && url === '/api/sheets') {
    return jsonResp([...sheets.values()].map(sheetSummary));
  }
  if (method === 'POST' && url === '/api/sheets') {
    const s = insertSheet(body, 1, null);
    return jsonResp(sheetSummary(s), 201);
  }
  if (method === 'GET' && (m = url.match(/^\/api\/sheets\/(\d+)$/))) {
    const s = sheets.get(Number(m[1]));
    if (!s) return jsonResp({ error: '工艺单不存在' }, 404);
    return jsonResp({ ...sheetSummary(s), snapshot: s.snapshot, params: s.params,
                      derived: s.derived, reedPlan: s.reedPlan, steps: s.steps.map(stepOut) });
  }
  if (method === 'DELETE' && (m = url.match(/^\/api\/sheets\/(\d+)$/))) {
    sheets.delete(Number(m[1]));
    return jsonResp({ ok: true });
  }
  if (method === 'POST' && (m = url.match(/^\/api\/sheets\/(\d+)\/steps\/(\d+)\/(done|undo)$/))) {
    const s = sheets.get(Number(m[1]));
    if (!s) return jsonResp({ error: '工艺单不存在' }, 404);
    const t = s.steps.find(x => x.id === Number(m[2]));
    if (!t) return jsonResp({ error: '步骤不存在' }, 404);
    if (m[3] === 'done') {
      if (t.done) return jsonResp({ error: '该步骤已确认' }, 409);
      if (t.stale) return jsonResp({ error: '该步骤已失效' }, 409);
      if (s.steps.some(x => x.index < t.index && !x.done))
        return jsonResp({ error: '请按顺序确认：前面还有未完成的步骤' }, 409);
      t.done = true; t.doneAt = new Date().toISOString();
    } else {
      if (!t.done) return jsonResp({ error: '该步骤尚未确认' }, 409);
      if (s.steps.some(x => x.index > t.index && x.done))
        return jsonResp({ error: '只能倒序撤回：请先撤回后面的步骤' }, 409);
      t.done = false; t.doneAt = null;
    }
    return jsonResp(stepOut(t));
  }
  if (method === 'POST' && (m = url.match(/^\/api\/sheets\/(\d+)\/copy$/))) {
    const old = sheets.get(Number(m[1]));
    if (!old) return jsonResp({ error: '工艺单不存在' }, 404);
    const s = insertSheet(body, old.version + 1, old.id);
    const newSigs = new Set(body.steps.map(sig));
    let staleCount = 0;
    old.steps.forEach(t => {
      if (!newSigs.has(sig(t)) && !t.stale) { t.stale = true; staleCount++; }
    });
    return jsonResp({ sheet: sheetSummary(s), parentId: old.id, staleCount }, 201);
  }
  if (method === 'GET' && url === '/api/drafts') return jsonResp([]);
  return jsonResp({ error: 'not mocked: ' + method + ' ' + url }, 404);
};

/* ---------------- 加载脚本 ---------------- */
const errors = [];
w.addEventListener('error', e => errors.push('window error: ' + (e.error && e.error.stack || e.message)));
const read = (f) => fs.readFileSync(path.join(ROOT, 'static', f), 'utf8').replace(/'use strict';/, '');
try {
  w.eval(read('engine.js') + read('defect-core.js') + read('loom-core.js') +
         read('loom-ui.js') + read('app.js') + `
  boardEl = document.querySelector('#board');
  baseCvs = createCanvas(10,10); ovCvs = createCanvas(10,10);
  baseCvs.style = {}; ovCvs.style = {};
  baseCtx = baseCvs.getContext('2d'); ovCtx = ovCvs.getContext('2d');
  dpr = 1;
  state.analysis = Engine.analyze(state.draft);
  syncInputs(); buildPalette(); refreshTreadleBrush();
  resizeCanvases(); refreshIssues(); refreshStats(); refreshPreviews();
  `);
} catch (e) { errors.push('eval: ' + e.stack); }

(async () => {
  await new Promise(r => setTimeout(r, 50));

  /* ① 顶栏入口存在 */
  check('顶栏存在“上机工艺单”入口', !!$('#btnLoom'));
  check('工艺单弹窗已挂载', !!$('#loomModal'));
  check('工艺单打印区已挂载', !!$('#loPrintSheet'));
  check('测试钩子可用', typeof w.__loomSheetAPI === 'object');

  const API = w.__loomSheetAPI;

  /* ② 打开弹窗：列表为空 + 参数表单就绪 */
  API.open();
  await new Promise(r => setTimeout(r, 30));
  check('弹窗打开', API.isOpen());
  check('纱重表按调色板生成 8 行', $$('#loYarnGrid input').length === 8);
  check('空列表提示', $('#loSheetList').textContent.includes('还没有工艺单'));

  /* ③ 计算预览 */
  $('#loFinishW').value = '40';
  $('#loWarpDensity').value = '10';
  $('#loReedDents').value = '5';
  API.calcPreview();
  await new Promise(r => setTimeout(r, 10));
  const pv = API.state.preview;
  check('预览已生成', !!pv);
  check('整经根数 40×10=400（循环 4 整数倍）', pv.plan.totalEnds === 400, pv.plan.totalEnds);
  check('上机经密 9.2 根/cm（纬缩 8%）', Math.abs(pv.plan.loomDensity - 9.2) < 1e-9, pv.plan.loomDensity);
  check('穿筘目标 1.84 根/筘', Math.abs(pv.reedSearch.target - 1.84) < 1e-9, pv.reedSearch.target);
  check('穿筘候选按误差排序且有推荐', pv.reedSearch.plans.length > 1 && pv.reedSearch.plans[0].err <= pv.reedSearch.plans[1].err);
  check('推算结果已渲染', $('#loDerived').textContent.includes('400'));
  check('分色用量表已渲染', $('#loUsage').textContent.includes('合计'));
  check('穿筘候选区已渲染', $$('#loReedBox .lo-reed-cand').length >= 2);
  check('冻结按钮可见', !$('#loFreezeBar').classList.contains('hidden'));
  const candCount = $$('#loReedBox .lo-reed-cand').length;
  $$('#loReedBox .lo-reed-cand')[1].click();
  check('候选可切换', API.state.preview.reedSel === 1);
  $$('#loReedBox .lo-reed-cand')[0].click();

  /* ④ 冻结建立 */
  $('#loSheetName').value = '围巾工艺单';
  await API.freeze();
  await new Promise(r => setTimeout(r, 30));
  check('冻结后列表有 1 单', API.state.list.length === 1);
  check('冻结后自动打开新单', API.state.current && API.state.current.name === '围巾工艺单');
  check('步骤渲染（整经+穿综+穿筘 ≥3 步）', $$('#loStepList .lo-step').length >= 3, $$('#loStepList .lo-step').length);
  check('步骤含穿筘', $('#loStepList').textContent.includes('穿筘'));
  check('预览已清空', API.state.preview === null);

  const sheetId = API.state.current.id;
  const steps = API.state.current.steps;

  /* ⑤ 顺序确认：跳步被拒（mock 409 → checkbox 回退）；确认即定位画布 */
  const boxes = $$('#loStepList .lo-step input[type=checkbox]');
  check('第 2 步复选框被禁用（前序未完成）', boxes[1].disabled === true);
  check('第 1 步可确认', boxes[0].disabled === false);
  boxes[0].click();
  await new Promise(r => setTimeout(r, 30));
  check('确认第 1 步后进度 1', API.state.current.steps[0].done === true);
  check('勾选确认触发画布定位（弹窗关闭）', $('#loomModal').classList.contains('hidden'));
  check('定位闪烁指向穿综区首列', (() => {
    const f = w.__loom.state.locateFlash;
    return !!f && f.grid === 'threading' && f.c === 0;
  })(), w.__loom.state.locateFlash);

  API.open();   // 重新打开继续操作
  await new Promise(r => setTimeout(r, 30));
  const boxes2 = $$('#loStepList .lo-step input[type=checkbox]');
  check('确认后第 2 步解锁', boxes2[1].disabled === false);
  check('已确认步骤可撤回（是最后已确认项）', boxes2[0].disabled === false);
  boxes2[1].click();
  await new Promise(r => setTimeout(r, 30));
  check('确认第 2 步后进度 2', API.state.current.steps.filter(s => s.done).length === 2);
  check('第 2 步确认同样触发定位', $('#loomModal').classList.contains('hidden') &&
    !!w.__loom.state.locateFlash);

  API.open();
  await new Promise(r => setTimeout(r, 30));
  const boxes3 = $$('#loStepList .lo-step input[type=checkbox]');
  check('第 1 步不可撤回（须先撤后面）', boxes3[0].disabled === true);
  check('第 2 步可撤回', boxes3[1].disabled === false);
  boxes3[1].click();   // 倒序撤回第 2 步（撤回不触发定位）
  await new Promise(r => setTimeout(r, 30));
  check('撤回后进度回到 1', API.state.current.steps.filter(s => s.done).length === 1);
  check('撤回不关闭弹窗', !$('#loomModal').classList.contains('hidden'));

  /* ⑥ 展开到每根经线（400 根区段完整显示） */
  $$('#loStepList .lo-step-acts .btn')[0].click();   // 第 1 步“展开”
  await new Promise(r => setTimeout(r, 10));
  check('展开显示每根经线', $('#loStepList .lo-expand').textContent.includes('第 1 根'));
  check('400 根区段完整展开（不再截断到 400）', $$('#loStepList .lo-expand tr').length === 400,
    $$('#loStepList .lo-expand tr').length);
  check('展开末行为第 400 根', $('#loStepList .lo-expand').textContent.includes('第 400 根'));

  /* ⑦ 定位到主图板 */
  API.locateStep(API.state.current.steps[0]);
  check('定位后模态关闭', $('#loomModal').classList.contains('hidden'));
  const flash = w.__loom.state.locateFlash;
  check('主图板定位闪烁已设置', !!flash && flash.grid === 'threading');
  check('定位列为循环首列', flash && flash.c === 0, flash);

  /* ⑧ 草稿变化 → 复制新版，原单失效 */
  API.open();
  await new Promise(r => setTimeout(r, 30));
  check('重新打开后进度保留（1 步已确认）',
    API.state.current.steps.filter(s => s.done).length === 1);
  // 修改当前草稿穿综 → 指纹应不同
  w.__loom.state.draft.threading[0] = 3;
  API.state.current && $('#loFinishW').value === '40';
  API.calcPreview();   // 基于变化后的草稿生成新版预览
  await new Promise(r => setTimeout(r, 10));
  check('新版预览生成', !!API.state.preview);
  check('冻结按钮文案为新版', $('#loFreeze').textContent.includes('新版'));
  await API.freeze();
  await new Promise(r => setTimeout(r, 30));
  check('新版 v2 已建立', API.state.current && API.state.current.version === 2);
  check('列表有 2 单', API.state.list.length === 2);
  const oldSheet = [...sheets.values()].find(s => s.version === 1);
  check('原单未被改写（参数仍 40cm）', oldSheet.params.finishWidth === 40);
  check('原单有失效步骤', oldSheet.steps.some(t => t.stale));
  check('原单进度保留', oldSheet.steps.filter(t => t.done).length === 1);

  /* ⑨ 打开原单查看失效步骤 */
  await API.openSheet(oldSheet.id);
  await new Promise(r => setTimeout(r, 30));
  check('原单失效提示条显示', !$('#loStaleBar').classList.contains('hidden'));
  check('失效步骤带标记', $$('#loStepList .lo-step.stale').length >= 1);
  check('失效未确认步骤复选框禁用', (() => {
    const staleUndone = API.state.current.steps.find(s => s.stale && !s.done);
    if (!staleUndone) return true;   // 全部失效步都已确认也算通过
    const idx = API.state.current.steps.indexOf(staleUndone);
    return $$('#loStepList .lo-step input[type=checkbox]')[idx].disabled === true;
  })());

  /* ⑩ 打印不抛错 */
  let printErr = null;
  try { API.doPrint(); } catch (e) { printErr = e; }
  check('打印渲染不抛错', !printErr, printErr);
  check('打印区含参数与操作顺序',
    $('#loPrintMeta').textContent.includes('整经根数') &&
    $('#loPrintSteps').textContent.includes('穿筘'));
  check('打印分色用量表', $('#loPrintUsage').textContent.includes('合计'));

  /* ⑪ 删除 */
  await API.deleteSheet();
  await new Promise(r => setTimeout(r, 30));
  check('删除后回到列表', API.state.current === null);

  /* ⑫ 用户场景：201cm × 10 根/cm + 交替色经 → 2012 根正常冻结 */
  w.loadDraft(w.__loom.Engine.defaultDraft(), '交替测试', null);   // 恢复干净草稿（⑧ 曾改穿综）
  w.__loom.state.draft.warpColor = w.__loom.state.draft.warpColor.map((_, i) => i % 2);
  w.__loom.afterEdit();
  $('#loNewSheet').click();
  await new Promise(r => setTimeout(r, 20));
  $('#loFinishW').value = '201';
  $('#loWarpDensity').value = '10';
  API.calcPreview();
  await new Promise(r => setTimeout(r, 10));
  check('交替色经预览整经 2012 根', API.state.preview.plan.totalEnds === 2012,
    API.state.preview.plan.totalEnds);
  check('步骤压缩为 3 步（不触发“步骤数量过多”）', API.previewSteps().length === 3,
    API.previewSteps().length);
  check('整经步骤为色序循环段', API.previewSteps()[0].label.includes('色序循环'),
    API.previewSteps()[0].label);
  $('#loSheetName').value = '交替色经 201';
  await API.freeze();
  await new Promise(r => setTimeout(r, 30));
  check('2012 根工艺单冻结成功', !!API.state.current && API.state.current.name === '交替色经 201');
  check('冻结后步骤为 3 步', API.state.current.steps.length === 3, API.state.current.steps.length);
  // 展开色序循环段：2012 根逐根完整显示
  $$('#loStepList .lo-step-acts .btn')[0].click();
  await new Promise(r => setTimeout(r, 20));
  check('2012 根区段完整展开', $$('#loStepList .lo-expand tr').length === 2012,
    $$('#loStepList .lo-expand tr').length);
  check('展开末行为第 2012 根', $('#loStepList .lo-expand').textContent.includes('第 2012 根'));
  check('展开行色号交替', (() => {
    const tds = $$('#loStepList .lo-expand tr td:last-child');
    return tds[0].textContent.includes('色号1') && tds[1].textContent.includes('色号2');
  })());
  // 清理
  await API.deleteSheet();
  await new Promise(r => setTimeout(r, 20));

  check('无 window 错误', errors.length === 0, errors);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail || errors.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
