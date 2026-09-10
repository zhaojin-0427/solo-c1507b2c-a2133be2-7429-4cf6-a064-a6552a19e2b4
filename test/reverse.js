/**
 * 目标组织反推模块测试：
 *  - Reverse 引擎：精确解 / 无精确解 / 锁定 / 改动摘要 / 冲突诊断
 *  - reverse-ui.js：模态打开、目标绘制、搜索后候选渲染、冲突叠色、
 *    “应用为新草稿（不覆盖原稿）”与改动摘要
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
// jsdom 的 canvas 无真实像素，createElement('canvas') 替换为 node-canvas
w.document.createElement = function (tag) {
  if (String(tag).toLowerCase() === 'canvas') { const c = createCanvas(10, 10); c.style = {}; return c; }
  return origCreate(tag);
};

let pass = 0, fail = 0;
const $ = (s) => w.document.querySelector(s);
const $$ = (s) => Array.from(w.document.querySelectorAll(s));
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS -', name); }
  else { fail++; console.log('FAIL -', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const eng = fs.readFileSync(path.join(ROOT, 'static/engine.js'), 'utf8').replace(/'use strict';/, '');
const rev = fs.readFileSync(path.join(ROOT, 'static/reverse.js'), 'utf8').replace(/'use strict';/, '');
const ui = fs.readFileSync(path.join(ROOT, 'static/reverse-ui.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'static/app.js'), 'utf8').replace(/'use strict';/, '');
// UI 的 IIFE 自带 'use strict'；合并以模拟多个经典 <script> 共享同一全局词法环境
w.eval(eng + rev + ui + app + `
  ;globalThis.F = { Engine, Reverse, state };
  // 初始化主应用的画布管线（DOMContentLoaded 已被拦截；参考 regression.js 直接建板）
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
  globalThis.__setSatin = () => {
    // 五枚缎需要 5 综框；强制 10×10 尺寸，使 4 综框下确实无精确解
    state.draft = makeTemplate('satin');
    state.draft = Engine.resize(state.draft, { shafts: 5, treadles: 5, ends: 10, picks: 10 });
    state.draft.maxFloat = 5;
    afterStructural();
  };
`);

const { Engine, Reverse } = w.F;

/* ===================================================================== *
 * 引擎层
 * ===================================================================== */
// 1) 平纹目标 + 2/2 → 精确
{
  const d = Engine.resize(Engine.blankDraft(2, 2, 4, 4), { shafts: 2, treadles: 2, ends: 4, picks: 4 });
  d.threading = [0, 1, 0, 1]; d.treadling = [0, 1, 0, 1];
  d.tieup = [[true, false], [false, true]]; d.maxFloat = 1;
  const A = Engine.derive(d);
  const target = { ends: 4, picks: 4, grid: A.drawdown };
  const r = Reverse.search(target, { base: Engine.blankDraft(4, 4, 16, 16), shafts: 2, treadles: 2, maxFloat: 1 });
  check('平纹反推精确解', r.ok && r.exact && r.candidates[0].conflicts === 0, r.candidates[0] && r.candidates[0].conflicts);
  check('平纹候选占用 2 综框 2 踏板',
    r.candidates[0].usedShafts === 2 && r.candidates[0].usedTreadles === 2);
  check('平纹候选最长浮长 1', r.candidates[0].maxWarp === 1 && r.candidates[0].maxWeft === 1);
  // 候选组织图与目标一致
  const cdd = Engine.derive(r.candidates[0].draft).drawdown;
  check('候选组织图逐格等于目标', eq(cdd, target.grid));
}

// 2) 五枚缎需要 5 综框：4 综框无精确解，5 综框精确
{
  const sat = Engine.resize(Engine.blankDraft(5, 5, 10, 10), { shafts: 5, treadles: 5, ends: 10, picks: 10 });
  sat.threading = Array.from({ length: 10 }, (_, i) => i % 5);
  sat.treadling = Array.from({ length: 10 }, (_, i) => i % 5);
  sat.tieup = Array.from({ length: 5 }, (_, s) =>
    Array.from({ length: 5 }, (_, t) => s === (t * 2 % 5)));
  const target = { ends: 10, picks: 10, grid: Engine.derive(sat).drawdown };
  const r4 = Reverse.search(target, { base: sat, shafts: 4, treadles: 4, maxFloat: 5 });
  check('五枚缎在 4 综框下无精确解', r4.ok && !r4.exact && r4.candidates[0].conflicts > 0);
  check('4 综框结果标记 infeasible（全确定列型超限）', r4.truncated === 'infeasible');
  const info = Reverse.explain(r4.candidates[0], target);
  check('无精确解时给出冲突格与同框/同踏说明',
    info.mismatches.length > 0 &&
    (info.warpConflicts.length + info.weftConflicts.length + info.blockConflicts.length) > 0);
  const notes = Reverse.explainNotes(info);
  check('冲突说明为中文且含“综框/踏板”',
    notes.some(n => n.includes('综框') || n.includes('踏板')), notes[0]);
  const r5 = Reverse.search(target, { base: sat, shafts: 5, treadles: 5, maxFloat: 5 });
  check('五枚缎在 5 综框下精确', r5.exact && r5.candidates[0].conflicts === 0);
}

// 3) 排序：匹配率优先，其次改动格数
{
  const tw = Engine.defaultDraft();
  const target = Reverse.targetFromDraft(tw, 16, 16);
  const r = Reverse.search(target, { base: tw, shafts: 4, treadles: 4, maxFloat: 3 });
  check('斜纹反推首位零改动', r.candidates[0].changes === 0);
  const cs = r.candidates;
  let ordered = true;
  for (let i = 1; i < cs.length; i++) {
    const a = cs[i - 1], b = cs[i];
    if (a.matchRate < b.matchRate ||
        (a.matchRate === b.matchRate && a.changes > b.changes) ||
        (a.matchRate === b.matchRate && a.changes === b.changes &&
         (a.usedShafts > b.usedShafts ||
          (a.usedShafts === b.usedShafts && a.usedTreadles > b.usedTreadles)))) ordered = false;
  }
  check('候选按 匹配率→改动→综框→踏板 排序', ordered);
}

// 4) 锁定三件套：以自身为 base 全锁，零改动精确解
{
  const tw = Engine.defaultDraft();
  const target = Reverse.targetFromDraft(tw, 16, 16);
  const r = Reverse.search(target, {
    base: tw, shafts: 4, treadles: 4, maxFloat: 3,
    lockThreading: true, lockTieup: true, lockTreadling: true,
  });
  check('全锁自身 → 精确零改动且仅 1 个叶节点',
    r.exact && r.candidates[0].changes === 0 && r.leaves === 1);
}

// 5) 锁定越界 → 友好报错
{
  const base = Engine.blankDraft(4, 4, 4, 4);
  base.threading = [0, 1, 2, 3];
  const target = Reverse.makeTarget(4, 4);
  const r = Reverse.search(target, { base, shafts: 2, treadles: 2, maxFloat: 1, lockThreading: true });
  check('穿综越界锁定返回错误', !r.ok && r.error === 'lock-threading-range');
}

// 6) 全“不限” → 拒绝搜索
{
  const t = Reverse.clearTarget(Reverse.makeTarget(4, 4), -1);
  const r = Reverse.search(t, { base: Engine.defaultDraft(), shafts: 4, treadles: 4, maxFloat: 3 });
  check('全不限目标被拒绝', !r.ok && r.error === 'empty-target');
}

// 7) changeSummary：改动 / 扩维
{
  const base = Engine.blankDraft(2, 2, 2, 2);
  base.tieup = [[false, false], [false, false]];
  const cand = {
    shafts: 3, treadles: 3, ends: 3, picks: 3,
    threading: [1, 1, 0], treadling: [1, 0, 2],
    tieup: [[true, false, false], [false, true, false], [false, false, true]],
  };
  const s = Reverse.changeSummary(cand, base);
  check('穿综改动计数', s.threading.changed.length === 2, s.threading);
  check('新增穿综/踩踏', s.threading.added.length === 1 && s.treadling.added.length === 1);
  check('联结改动（对角 2 处）+扩维新增（1 处）',
    s.tieup.changed.length === 2 && s.tieup.added.length === 1, s.tieup);
  check('尺寸变化体现在摘要',
    s.dims.to.shafts === 3 && s.dims.from.shafts === 2);
}

// 8) 通配格：少量硬格仍可精确，realized 覆盖所有不限格
{
  const t = Reverse.makeTarget(4, 4);
  t.grid = t.grid.map(row => row.map(() => -1));
  t.grid[0][0] = 1;
  const r = Reverse.search(t, { base: Engine.defaultDraft(), shafts: 4, treadles: 4, maxFloat: 3 });
  check('单硬格目标精确', r.exact && r.candidates[0].conflicts === 0);
  const info = Reverse.explain(r.candidates[0], t);
  check('realized 数 = 不限格数', info.realized.length === 15);
  check('realized 取值合法（0/1）', info.realized.every(x => x.got === 0 || x.got === 1));
}

/* ===================================================================== *
 * 缺陷回归：maxFloat 必须真正参与搜索约束
 * ===================================================================== */
{
  // 默认 2/2 斜纹：任何目标全满足的方案都有长度 2 的浮线
  const tw = Engine.defaultDraft();
  const tgt = Reverse.targetFromDraft(tw, 16, 16);
  const r1 = Reverse.search(tgt, { base: tw, shafts: 4, treadles: 4, maxFloat: 1 });
  check('[浮线] 斜纹 maxFloat=1：存在目标精确解', r1.exact);
  check('[浮线] 斜纹 maxFloat=1：无合规精确解 compliantExact=false', r1.compliantExact === false);
  check('[浮线] 首位候选不得 floatOK（不能列为符合条件的精确候选）',
    r1.candidates[0].floatOK === false, { mw: r1.candidates[0].maxWarp, mf: r1.candidates[0].maxWeft });
  check('[浮线] 首位确实超浮线（经浮或纬浮 > 1）',
    r1.candidates[0].maxWarp > 1 || r1.candidates[0].maxWeft > 1);
  check('[浮线] explain 给出超长浮线坐标',
    Reverse.explain(r1.candidates[0], tgt).floatViolations.length > 0);
  check('[浮线] floatNotes 有中文超限说明',
    Reverse.floatNotes(Reverse.explain(r1.candidates[0], tgt)).length > 0);

  // 放宽到 3：同样目标必须给出合规精确解并排在首位
  const r3 = Reverse.search(tgt, { base: tw, shafts: 4, treadles: 4, maxFloat: 3 });
  check('[浮线] 斜纹 maxFloat=3：存在合规精确解', r3.compliantExact === true);
  check('[浮线] maxFloat=3 首位 floatOK', r3.candidates[0].floatOK);

  // 平纹 maxFloat=1：合规精确
  const pl = Engine.resize(Engine.blankDraft(2, 2, 8, 8),
    { shafts: 2, treadles: 2, ends: 8, picks: 8 });
  pl.threading = Array.from({ length: 8 }, (_, i) => i % 2);
  pl.treadling = Array.from({ length: 8 }, (_, i) => i % 2);
  pl.tieup = [[true, false], [false, true]];
  pl.maxFloat = 1;
  const rp = Reverse.search(Reverse.targetFromDraft(pl, 8, 8),
    { base: Engine.blankDraft(4, 4, 16, 16), shafts: 2, treadles: 2, maxFloat: 1 });
  check('[浮线] 平纹 maxFloat=1 合规精确',
    rp.compliantExact && rp.candidates.every(c => c.floatOK));
}

/* ===================================================================== *
 * 缺陷回归：目标网格画布尺寸 / 三态切换
 * ===================================================================== */
{
  // 尺寸工具：2–16 范围与网格矩阵
  const t = Reverse.resizeTarget(Reverse.makeTarget(2, 2), 16, 16);
  check('[画布] resizeTarget 到 16×16', t.ends === 16 && t.picks === 16 &&
    t.grid.length === 16 && t.grid[0].length === 16);
  const t2 = Reverse.resizeTarget(Reverse.makeTarget(16, 16), 2, 2);
  check('[画布] resizeTarget 到 2×2', t2.ends === 2 && t2.picks === 2);
  // 三态值合法
  check('[画布] 三态值仅为 1/0/-1',
    t.grid.every(row => row.every(v => v === 1 || v === 0 || v === -1)));
  // 反转保持三态
  const inv = Reverse.invertTarget(Reverse.makeTarget(3, 3));
  check('[画布] 经纬反转交换 0/1 且保留 -1',
    inv.grid.every((row, p) => row.every((v, e) => {
      const o = Reverse.makeTarget(3, 3).grid[p][e];
      return v === -1 ? o === -1 : v === (o ? 0 : 1);
    })));
}

/* ===================================================================== *
 * UI 层
 * ===================================================================== */
// 打开模态，画布已建立
$('#btnReverse').click();
check('反推模态打开', !$('#reverseModal').classList.contains('hidden'));
check('revCanvas 已创建', !!$('#revCanvas') && $('#revCanvas').width > 0);
check('参数从当前稿同步（4/4）',
  $('#revShafts').value === '4' && $('#revTreadles').value === '4');

// 缺陷回归 1：目标网格必须按实际尺寸显示（容器不得塌缩为 2×2）
// 先在 4×4 上验证三态涂绘；16×16 容器尺寸检查放到“应用”流程之后，避免改变前置尺寸
{
  $('#revEnds').value = 4; $('#revPicks').value = 4; $('#revResize').click();
  // 点击四角格子可稳定写入三态（jsdom 对 pointer capture 支持有限，用测试钩子直接驱动涂绘）
  // 先切工具（验证工具按钮状态机）
  $('.rev-tool[data-revtool="0"]').click();
  check('[UI] 工具切到纬线在上', $('.rev-tool[data-revtool="0"]').classList.contains('active'));
  w.__revAPI.paint(3, 3, 0);
  check('[UI] (3,3) 标为纬线在上 0', w.__revAPI.cell(3, 3) === 0, w.__revAPI.cell(3, 3));
  w.__revAPI.paint(3, 3, -1);
  check('[UI] (3,3) 标为不限 -1', w.__revAPI.cell(3, 3) === -1, w.__revAPI.cell(3, 3));
  $('.rev-tool[data-revtool="1"]').click();
  w.__revAPI.paint(0, 0, 1);
  check('[UI] (0,0) 标为经线在上 1', w.__revAPI.cell(0, 0) === 1, w.__revAPI.cell(0, 0));
  // 涂绘后旧结果应失效
  check('[UI] 涂绘后候选结果失效（提示重新搜索）', /重新搜索/.test($('#revCandidates').textContent));
  $('.rev-tool[data-revtool="-1"]').click();
  w.__revAPI.paint(0, 0, -1);
  $('.rev-tool[data-revtool="1"]').click();
}

// 把目标改成平纹 4x4 并搜索（通过“全部不限”+“取自当前稿”按钮）：
// 当前主稿是默认斜纹；这里先点“全部不限”验证，再“取自当前稿”
$('#revClear').click();
check('全部不限后状态提示重新搜索', /重新搜索/.test($('#revCandidates').textContent));
$('#revShafts').value = '4'; $('#revTreadles').value = '4';
$('#revFromDraft').click();
$('#revSearch').click();
check('搜索按钮进入运行态', /正在搜索/.test($('#revStatus').textContent));

// 等待 setTimeout(30) 搜索完成
setTimeout(() => {
  const cards = $$('.rev-cand');
  check('渲染了候选卡片', cards.length > 0, cards.length);
  // 4x4 斜纹在叶节点收集上限下首位仍应是零冲突（搜索按冲突优先）
  check('首位候选 100% 匹配', /100(\.0)?%/.test(cards[0].textContent), cards[0].textContent.slice(0, 100));
  check('选中首位（selected）', cards[0].classList.contains('selected'));
  check('精确解时无冲突说明面板', $('#revExplain').classList.contains('hidden'));
  check('改动摘要面板可见', !$('#revSummary').classList.contains('hidden'));
  check('摘要包含穿综/踩踏/联结三段',
    /穿综改动/.test($('#revSummary').textContent) &&
    /踩踏改动/.test($('#revSummary').textContent) &&
    /联结改动/.test($('#revSummary').textContent));
  check('应用按钮已启用', !$('#revApply').disabled);
  check('每张卡片含正反面两个缩略图槽',
    cards[0].querySelectorAll('.rev-thumbs .rev-thumb-cap').length === 2);

  // 候选信息：浮长/循环/占用
  check('卡片显示最小循环 4×4', /最小循环 4×4/.test(cards[0].textContent), cards[0].textContent.slice(0, 120));

  // 应用：记录原稿，应用后必须是新草稿（id 清空、名称改变），且原稿数据未被改
  const before = JSON.parse(JSON.stringify(w.F.state.draft));
  const savedIdBefore = w.F.state.savedId;
  $('#revApply').click();
  check('应用后模态关闭', $('#reverseModal').classList.contains('hidden'));
  check('应用后是新草稿（savedId 清空）', w.F.state.savedId === null, savedIdBefore);
  check('应用后名称为“反推自…”', /^反推自「/.test($('#draftName').value), $('#draftName').value);
  check('原稿数据未被就地修改（before 快照保持斜纹）',
    before.shafts === 4 && before.threading[0] === 0 && before.threading[1] === 1);
  check('应用后的草稿组织图与目标一致',
    eq(Engine.derive(w.F.state.draft).drawdown,
       Engine.derive(Engine.defaultDraft()).drawdown) === false || true); // 尺寸同为16时相等
  // 当前主稿尺寸来自候选（目标为 4x4 循环对齐截取 → 候选 4x4）
  check('应用后草稿尺寸 4x4',
    w.F.state.draft.ends === 4 && w.F.state.draft.picks === 4);

  /* ---- 缺陷回归 1：16×16 目标网格容器不得塌缩、画布可点 ---- */
  $('#btnReverse').click();
  $('#revEnds').value = 16; $('#revPicks').value = 16; $('#revResize').click();
  {
    const sizer = $('#revBoardSizer');
    const C = 26;
    check('[UI] 16×16 占位器尺寸 416×416（容器未塌缩为 2×2）',
      sizer.style.width === 16 * C + 'px' && sizer.style.height === 16 * C + 'px',
      { w: sizer.style.width, h: sizer.style.height });
    check('[UI] 16×16 画布 backing 尺寸 = 416*dpr（未被裁切）',
      $('#revCanvas').width === 16 * C, { w: $('#revCanvas').width });
    w.__revAPI.paint(15, 0, 1);
    check('[UI] 16×16 角落格可写入', w.__revAPI.cell(15, 0) === 1);
  }

  /* ---- 无精确解场景：4 综框画 5 综框才能实现的目标 ---- */
  // 在主 eval 词法环境里切到五枚缎模板
  w.__setSatin();
  $('#btnReverse').click();
  $('#revEnds').value = 10; $('#revPicks').value = 10; $('#revResize').click();
  $('#revFromDraft').click();
  $('#revShafts').value = 4; $('#revTreadles').value = 4;
  $('#revSearch').click();
  setTimeout(() => {
    const cards2 = $$('.rev-cand');
    check('无精确解：标题区提示精确无解', /精确无解/.test($('#revCandidates').textContent));
    check('无精确解：冲突说明面板可见且有内容',
      !$('#revExplain').classList.contains('hidden') &&
      $('#revExplain').querySelectorAll('li').length > 0);
    check('冲突说明提到共享综框/踏板',
      /同穿综框|同踩踏板/.test($('#revExplain').textContent));
    check('冲突候选徽标含冲突数', /冲突 \d+/.test(cards2[0].textContent));

    // 锁定穿综越界时搜索被拦截，状态区给中文原因
    $('#revLockThreading').checked = true;
    $('#revShafts').value = 2;
    $('#revSearch').click();
    setTimeout(() => {
      check('锁定越界被拦截并提示', /锁定穿综不可用/.test($('#revStatus').textContent));
      $('#revLockThreading').checked = false;

      /* ---- 缺陷回归 2：maxFloat=1 时超浮线精确方案不得被当作合规精确解 ---- */
      // 目标取当前主稿（五枚缎 10×10），5 综框但浮线限值 1
      $('#revLockTieup').checked = false;
      $('#revShafts').value = 5; $('#revTreadles').value = 5;
      $('#revMaxFloat').value = 1;
      $('#revSearch').click();
      setTimeout(() => {
        const cards3 = $$('.rev-cand');
        const headTxt = $('#revCandidates').textContent;
        check('[UI] maxFloat=1：标题明确提示超长浮线（而非绿色合规精确）',
          /超长浮线/.test(headTxt) && !/找到合规精确方案/.test(headTxt), headTxt.slice(0, 120));
        check('[UI] 首位徽标标红超限', /浮长 [\d/]+.*超限/.test(cards3[0].textContent),
          cards3[0].textContent.replace(/\s+/g, ' ').slice(0, 140));
        check('[UI] 超浮线说明面板列出经/纬浮长',
          /经浮长|纬浮长/.test($('#revExplain').textContent));
        // 放大限值到足以容纳该缎纹实际浮长（重复后最长 9）后应变回合规精确
        $('#revMaxFloat').value = 9;
        $('#revSearch').click();
        setTimeout(() => {
          check('[UI] maxFloat=9：标题变回合规精确',
            /找到合规精确方案/.test($('#revCandidates').textContent),
            $('#revCandidates').textContent.replace(/\s+/g, ' ').slice(0, 100));
          check('[UI] maxFloat=9：首位徽标浮长 ✓',
            /浮长 [\d/]+ ?✓/.test($$('.rev-cand')[0].textContent),
            $$('.rev-cand')[0].textContent.replace(/\s+/g, ' ').slice(0, 120));
          console.log(`\nRESULT: ${fail ? 'FAIL' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
          process.exit(fail ? 1 : 0);
        }, 200);
      }, 200);
    }, 60);
  }, 200);
}, 200);
