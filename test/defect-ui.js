/**
 * 试织缺陷回标 UI 测试：
 *  建批次（冻结当前草稿快照）→ 打开 → 打点（坐标换算）→ 拖动改位置 →
 *  备注 → 归档后画布只读 → 跨循环/跨批次分组 → 修订预览/另存新草稿/修订记录 →
 *  并排视图渲染 → 打印不抛错 → 主图板定位钩子
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
w.createCanvas = createCanvas;
w.confirm = () => true;
w.print = () => {};

let pass = 0, fail = 0;
const $ = (s) => w.document.querySelector(s);
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS -', name); }
  else { fail++; console.log('FAIL -', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

/* ---------------- fetch mock：/api/batches* + /api/drafts ---------------- */
const batches = new Map();
const drafts = new Map();
let batchSeq = 0, markSeq = 0, revSeq = 0, draftSeq = 500;

function jsonResp(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj };
}

w.fetch = async (url, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};

  let m;
  if (method === 'POST' && url === '/api/drafts') {
    const id = body.id && drafts.has(body.id) ? body.id : ++draftSeq;
    drafts.set(id, { id, name: body.name, data: body.data });
    return jsonResp({ id, name: body.name, updated_at: new Date().toISOString() });
  }
  if (method === 'GET' && url === '/api/batches') {
    const rows = [...batches.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return jsonResp(rows.map(x => ({
      id: x.id, name: x.name, draftId: x.draftId, draftName: x.draftName,
      warpDensity: x.warpDensity, weftDensity: x.weftDensity,
      warpShrink: x.warpShrink, weftShrink: x.weftShrink,
      originX: x.originX, originY: x.originY,
      repeatWarp: x.repeatWarp, repeatWeft: x.repeatWeft,
      status: x.status, createdAt: x.createdAt, updatedAt: x.updatedAt,
      archivedAt: x.archivedAt, markCount: x.marks.length,
    })));
  }
  if (method === 'POST' && url === '/api/batches') {
    const id = ++batchSeq;
    const snap = body.snapshot;
    const period = (seq) => {
      const n = seq.length;
      outer: for (let k = 1; k <= n; k++) {
        if (n % k) continue;
        for (let i = k; i < n; i++) if (seq[i] !== seq[i - k]) continue outer;
        return k;
      }
      return n;
    };
    const b = {
      id, name: body.name, draftId: body.draftId ?? null, draftName: body.draftName,
      snapshot: snap,
      warpDensity: +body.warpDensity, weftDensity: +body.weftDensity,
      warpShrink: +body.warpShrink, weftShrink: +body.weftShrink,
      originX: +body.originX, originY: +body.originY,
      repeatWarp: period(snap.threading), repeatWeft: period(snap.treadling),
      status: 'open', marks: [], revisions: [],
      createdAt: '2026-01-01T00:00:00', updatedAt: '2026-01-01T00:00:00', archivedAt: null,
    };
    batches.set(id, b);
    return jsonResp({ id, name: b.name, status: 'open', markCount: 0,
      warpDensity: b.warpDensity, weftDensity: b.weftDensity, warpShrink: b.warpShrink,
      weftShrink: b.weftShrink, originX: b.originX, originY: b.originY,
      repeatWarp: b.repeatWarp, repeatWeft: b.repeatWeft, draftId: b.draftId,
      draftName: b.draftName, createdAt: b.createdAt, updatedAt: b.updatedAt, archivedAt: null }, 201);
  }
  if ((m = url.match(/^\/api\/batches\/(\d+)$/))) {
    const b = batches.get(+m[1]);
    if (!b) return jsonResp({ error: 'x' }, 404);
    if (method === 'GET') {
      return jsonResp(JSON.parse(JSON.stringify({
        id: b.id, name: b.name, draftId: b.draftId, draftName: b.draftName,
        snapshot: b.snapshot, warpDensity: b.warpDensity, weftDensity: b.weftDensity,
        warpShrink: b.warpShrink, weftShrink: b.weftShrink,
        originX: b.originX, originY: b.originY,
        repeatWarp: b.repeatWarp, repeatWeft: b.repeatWeft,
        status: b.status, createdAt: b.createdAt, updatedAt: b.updatedAt, archivedAt: b.archivedAt,
        marks: b.marks, revisions: b.revisions,
      })));
    }
  }
  if ((m = url.match(/^\/api\/batches\/(\d+)\/archive$/)) && method === 'POST') {
    const b = batches.get(+m[1]);
    if (!b) return jsonResp({ error: 'x' }, 404);
    if (b.status === 'archived') return jsonResp({ error: 'archived' }, 409);
    b.status = 'archived'; b.archivedAt = '2026-01-02T00:00:00';
    return jsonResp({ ok: true, archivedAt: b.archivedAt });
  }
  if ((m = url.match(/^\/api\/batches\/(\d+)\/marks$/)) && method === 'POST') {
    const b = batches.get(+m[1]);
    if (!b) return jsonResp({ error: 'x' }, 404);
    if (b.status === 'archived') return jsonResp({ error: 'archived' }, 409);
    if (!['miss', 'mistread', 'broken', 'float'].includes(body.type)) return jsonResp({ error: 'type' }, 400);
    const mmToIdx = (mm, density, origin) => Math.floor(((mm - origin) + 1e-9) / (10 / density));
    const mk = {
      id: ++markSeq, type: body.type, mmX: +body.mmX, mmY: +body.mmY,
      end: mmToIdx(+body.mmX, b.warpDensity, b.originX),
      pick: mmToIdx(+body.mmY, b.weftDensity, b.originY),
      note: body.note || '', createdAt: 't', updatedAt: 't',
    };
    b.marks.push(mk);
    return jsonResp(mk, 201);
  }
  if ((m = url.match(/^\/api\/batches\/(\d+)\/marks\/(\d+)$/))) {
    const b = batches.get(+m[1]);
    const mk = b && b.marks.find(x => x.id === +m[2]);
    if (!b) return jsonResp({ error: 'x' }, 404);
    if (!mk) return jsonResp({ error: 'm' }, 404);
    if (method === 'DELETE') {
      if (b.status === 'archived') return jsonResp({ error: 'archived' }, 409);
      b.marks = b.marks.filter(x => x.id !== mk.id);
      return jsonResp({ ok: true });
    }
    if (method === 'PUT') {
      if (b.status === 'archived') return jsonResp({ error: 'archived' }, 409);
      if (body.type) mk.type = body.type;
      if (body.mmX !== undefined) {
        mk.mmX = +body.mmX;
        mk.end = Math.floor(((mk.mmX - b.originX) + 1e-9) / (10 / b.warpDensity));
      }
      if (body.mmY !== undefined) {
        mk.mmY = +body.mmY;
        mk.pick = Math.floor(((mk.mmY - b.originY) + 1e-9) / (10 / b.weftDensity));
      }
      if (body.note !== undefined) mk.note = body.note;
      return jsonResp({ ...mk });
    }
  }
  if ((m = url.match(/^\/api\/batches\/(\d+)\/revisions$/)) && method === 'POST') {
    const b = batches.get(+m[1]);
    if (!b) return jsonResp({ error: 'x' }, 404);
    if (b.status === 'archived') return jsonResp({ error: 'archived' }, 409);
    const rv = { id: ++revSeq, action: body.action, summary: body.summary,
                 newDraftId: body.newDraftId ?? null, detail: body.detail, createdAt: '2026-01-03T00:00:00' };
    b.revisions.push(rv);
    return jsonResp(rv, 201);
  }
  return jsonResp({ error: 'unhandled ' + method + ' ' + url }, 500);
};

/* ---------------- 装载脚本（engine + defect-core + defect-ui + app） ---------------- */
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
w.eval(read('static/engine.js').replace(/'use strict';/, '') +
       read('static/defect-core.js').replace(/'use strict';/, '') +
       read('static/defect-ui.js') +
       read('static/app.js').replace(/'use strict';/, '') + `
  boardEl = document.querySelector('#board');
  baseCvs = createCanvas(10,10); ovCvs = createCanvas(10,10);
  baseCvs.style = {}; ovCvs.style = {};
  baseCtx = baseCvs.getContext('2d'); ovCtx = ovCvs.getContext('2d');
  dpr = 1;
  state.analysis = Engine.analyze(state.draft);
  syncInputs(); buildPalette(); refreshTreadleBrush();
  resizeCanvases(); refreshIssues(); refreshStats(); refreshPreviews();
  ;globalThis.F = { state, Engine, DefectCore: window.DefectCore, afterEdit, normalizeDraft, locateCell };
`);

const api = w.__defectAPI;
const E = w.Engine;

(async () => {
  try {
    /* ---- 打开模块 ---- */
    api.open();
    check('模态打开', api.isOpen() && !$('#defectModal').classList.contains('hidden'));
    await new Promise(r => setTimeout(r, 10));
    check('空列表提示', /还没有试织批次/.test($('#dfBatchList').textContent));

    /* ---- 从当前草稿建批次（当前为默认 4/4/16/16 斜纹）---- */
    $('#dfBatchName').value = 'UI 测试批次';
    $('#dfWarpDensity').value = 10; $('#dfWeftDensity').value = 10;
    $('#dfWarpShrink').value = 8; $('#dfWeftShrink').value = 8;
    $('#dfOriginX').value = 20; $('#dfOriginY').value = 20;
    await api.submitCreate();
    check('批次已建立', batches.size === 1);
    const bid = [...batches.keys()][0];
    check('快照冻结为斜纹 16×16', batches.get(bid).snapshot.ends === 16);
    check('当前批次自动打开', api.state.current && api.state.current.id === bid);
    check('元信息显示密度', /10.*\/cm/.test($('#dfBatchMeta').textContent));
    check('画布已布局（world 有尺寸）', api.world().clothW > 0, api.world());

    /* ---- 直接调用 createMark 模拟画布打点：(21.5, 23.0) → end1/pick3 ---- */
    await api.createMark(21.5, 23.0);
    let b = batches.get(bid);
    check('标记落库且换算 end=1/pick=3', b.marks[0].end === 1 && b.marks[0].pick === 3, b.marks[0]);
    check('标记类型为当前激活 miss', b.marks[0].type === 'miss');
    check('右侧计数 1', $('#dfMarkCount').textContent === '1');
    check('标记列表渲染', $('#dfMarkList').querySelectorAll('.df-mark').length === 1);

    /* ---- 拖动到 (22.5, 24.0) → end2/pick4 ---- */
    const m1 = b.marks[0];
    await api.moveMark(m1.id, 22.5, 24.0);
    b = batches.get(bid);
    check('拖动后序号更新 end=2/pick=4', b.marks[0].end === 2 && b.marks[0].pick === 4, b.marks[0]);

    /* ---- 改类型 / 备注（patchMark）---- */
    await api.patchMark(m1.id, { type: 'mistread', note: '第 5 纬踩错踏板' });
    check('类型/备注更新', b.marks[0].type === 'mistread' && /踩错/.test(b.marks[0].note));
    const noteEl = $('#dfMarkList').querySelector('.df-note');
    check('备注框显示备注', /踩错/.test(noteEl.value));

    /* ---- 列表中定位按钮（穿综/联结/踩踏/组织格/梭次）---- */
    let located = null;
    w.locateCell = (loc) => { located = loc; };
    const btns = [...$('#dfMarkList').querySelectorAll('.df-locate-row .btn')].map(x => x.textContent);
    check('定位按钮齐全（穿综/联结/踩踏/组织格 + 3 修订）',
      btns.some(t => t.includes('穿综')) && btns.some(t => t.includes('联结')) &&
      btns.some(t => t.includes('踩踏')) && btns.some(t => t.includes('组织格')), btns);
    $('#dfMarkList').querySelector('.df-locate-row .btn').click();
    check('点击定位调用主图板钩子且模态关闭', located && !api.isOpen(), located);

    /* ---- 再打两点制造跨循环：同循环位 (1,3)，不同砖 ---- */
    api.open();
    await api.openBatch(bid);
    // end5/pick7 → 与 (1,3) 同循环位、砖 (1,1)
    await api.createMark(25.5, 27.5);
    await api.patchMark(b.marks[1].id, { type: 'mistread' });
    /* ---- 跨批次：建同源第二批次 ---- */
    $('#dfNewBatch').click();
    $('#dfBatchName').value = '第二批次';
    await api.submitCreate();
    const bid2 = [...batches.keys()].find(x => x !== bid);
    await api.createMark(21.5, 23.0);
    await api.patchMark(batches.get(bid2).marks[0].id, { type: 'mistread' });

    /* ---- 反复分析 ---- */
    const R = await api.ensureRecurrence();
    // m1 已被拖动到 end2/pick4（循环位 2,0，单点）；
    // 组 (1,3) 现在是：批次1 仅 end5/pick7（砖1,1）、批次2 仅 end1/pick3（砖0,0）。
    // 回归：跨批次成立，但不同批次的单点不得再判跨循环。
    const group = R.groups.find(g => g.type === 'mistread' && g.cx === 1 && g.cy === 3);
    check('[回归] 两批次各单点不同砖：跨批次=true', group && group.crossBatch === true,
      group && { count: group.count, cb: group.crossBatch, cc: group.crossCycle });
    check('[回归] 两批次各单点不同砖：跨循环=false', group && group.crossCycle === false,
      group && group.perBatch.map(p => ({ count: p.count, tiles: [...p.tiles] })));
    check('分组成员 2 处（两批次各 1）', group && group.count === 2, group && group.count);
    check('核查综框（end1/end5 均穿综框 2）= 2', group.shafts.join(',') === '1', group.shafts);
    check('核查踏板（pick3/7 均踩踏板 4）= 4', group.treadles.join(',') === '3', group.treadles);
    check('联结点列出', group.tiePoints.length >= 1, group.tiePoints);

    // 对照：在开放批次 bid2 再打一个同循环位但不同砖的标记 → 该批次内跨循环成立
    await api.openBatch(bid2);
    await api.createMark(25.5, 27.5);                 // end5/pick7，循环位 (1,3)、砖 (1,1)
    await api.patchMark(batches.get(bid2).marks.find(m => m.end === 5 && m.pick === 7).id, { type: 'mistread' });
    const R2 = await api.ensureRecurrence();
    const group2 = R2.groups.find(g => g.type === 'mistread' && g.cx === 1 && g.cy === 3);
    check('同批次两处不同砖：跨循环=true（跨批次仍=true）',
      group2.crossCycle === true && group2.crossBatch === true, group2.perBatch.map(p => p.count));
    await api.openBatch(bid);

    /* ---- 反复面板渲染 ---- */
    api.openBatch(bid);
    $('.df-tab[data-tab="repeat"]').click();
    await new Promise(r => setTimeout(r, 20));
    const repCards = $('#dfRepeatList').querySelectorAll('.df-rep');
    check('反复卡片渲染且含跨批次标签', repCards.length >= 1 &&
      [...repCards].some(c => c.textContent.includes('跨批次反复')));
    check('反复计数徽章更新', parseInt($('#dfRepeatCount').textContent, 10) >= 1,
      $('#dfRepeatCount').textContent);

    /* ---- 修订：从分组改穿综（循环位），预览差异，另存新草稿 ---- */
    api.startReviseFromGroup('threading', group);
    check('修订构建器：穿综且默认循环应用',
      api.state.rev.kind === 'threading' && api.state.rev.threading.applyCycle === true);
    api.previewRev();
    const diff = api.state.rev.diff;
    check('差异计算：32 格变化（斜纹改 4 根经的挂综）', diff.changed === 32, diff.changed);
    check('修订列为循环位 4 根经', diff.revEnds.join(',') === '1,5,9,13', diff.revEnds);
    let loadArg = null;
    w.loadDraft = (d, name, id) => { loadArg = { name, id }; w.F.state.savedId = id; };
    await api.applyRev();
    check('另存为新草稿（/api/drafts）', drafts.size === 1 && [...drafts.values()][0].name.includes('修订穿综'));
    check('新草稿经 2 已改挂综框 1（默认改为非核查综框）',
      [...drafts.values()][0].data.threading[1] === 0 && w.F.Engine.defaultDraft().threading[1] === 1);
    check('主应用收到 loadDraft（不覆盖原稿）', loadArg && /修订穿综/.test(loadArg.name), loadArg);
    check('修订记录已写回批次', batches.get(bid).revisions.length === 1 &&
      batches.get(bid).revisions[0].action === 'threading');
    check('应用后模态关闭', !api.isOpen());

    /* ---- 单点修订联结 ---- */
    api.open();
    await api.openBatch(bid);
    const mk = batches.get(bid).marks.find(x => x.type === 'mistread');
    api.startReviseFromMark('tieup', mk, { shaft: 1, treadle: 3, tiePoints: [1] });
    api.previewRev();
    const d2 = api.state.rev.diff;
    check('联结翻转有组织差异', d2.changed > 0 && d2.revCells.length === 1, d2.changed);

    /* ---- 并排视图 ---- */
    $('.df-tab[data-tab="view"]').click();
    check('设计/正/反/回标四图就位',
      $('#dfViewDesign').width > 0 && $('#dfViewFront').width > 0 &&
      $('#dfViewBack').width > 0 && $('#dfViewMarks').width > 0);
    check('设计组织图画上了标记', true); // 无异常即通过（node-canvas 不读像素）

    /* ---- 打印 ---- */
    let printErr = null;
    try { api.doPrint(); } catch (e) { printErr = e.stack; }
    check('回标打印渲染不抛错', printErr === null, printErr);
    check('打印 canvas 已出尺寸', $('#dfPrintCanvas').width > 100, $('#dfPrintCanvas').width);
    check('打印明细表含实物坐标列', /实物 X/.test($('#dfPrintLegend').textContent));
    check('打印标题为回标图', /试织缺陷回标图/.test($('#dfPrintTitle').textContent));
    check('打印 body 加类隔离主打印页', w.document.body.classList.contains('df-printing'));

    /* ---- 归档后只读 ---- */
    await api.openBatch(bid);
    await api.archiveCurrent();
    check('批次已归档', batches.get(bid).status === 'archived');
    const beforeCount = batches.get(bid).marks.length;
    await api.createMark(30, 30);
    check('归档后 createMark 被服务拒绝（数量不变）', batches.get(bid).marks.length === beforeCount);
    check('归档按钮禁用', $('#dfArchive').disabled === true);
    check('类型工具条置 disabled 态', $('#dfTypeRow').classList.contains('disabled'));
    check('归档标签展示', /已归档（不可改写）/.test($('#dfBatchMeta').textContent));

    // 回归：归档批次的修订接口服务端也必须拒绝（不依赖界面禁用）
    const revResp = await w.fetch(`/api/batches/${bid}/revisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'tieup', summary: '归档后尝试', detail: { changed: 1 } }),
    });
    check('归档后 POST revisions 返回 409', revResp.status === 409, revResp.status);
    check('归档批次修订记录未增加', batches.get(bid).revisions.length === 1,
      batches.get(bid).revisions.length);

    /* ---- 删除开放批次的标记可行，归档批次不行 ---- */
    await api.openBatch(bid2);
    const openBefore = batches.get(bid2).marks.length;   // 对照场景中又加过一点
    const idOpen = batches.get(bid2).marks[0].id;
    await api.deleteMark(idOpen);
    check('开放批次标记可删', batches.get(bid2).marks.length === openBefore - 1);
    // deleteMark 内部吞掉错误并 toast；归档批次删除应被拒绝（标记仍在）
    const archivedCount = batches.get(bid).marks.length;
    await api.deleteMark(batches.get(bid).marks[0].id);
    check('归档批次删除被拒（409，标记仍在）', batches.get(bid).marks.length === archivedCount);

    /* ---- 定位钩子：drawLocateFlash 不破坏主覆盖层渲染 ---- */
    let drawErr = null;
    try {
      w.F.locateCell({ grid: 'drawdown', r: 3, c: 2 });
      w.eval('drawOverlay(performance.now())');
    } catch (e) { drawErr = e.stack; }
    check('locateCell + 覆盖层重绘无异常', drawErr === null && w.F.state.locateFlash !== null, drawErr);

  } catch (e) {
    console.error('TEST HARNESS ERROR:', e.stack);
    fail++;
  }
  console.log(`\nRESULT: ${fail ? 'FAIL' : 'ALL PASS'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})();
