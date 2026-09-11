/**
 * 试织缺陷回标 — 纯逻辑核心测试（defect-core.js）
 *  实物坐标换算 / 缩率上机坐标 / 循环位与循环砖 /
 *  关联（穿综·联结·踩踏·梭次）/ 浮线核查 / 跨循环·跨批次分组 /
 *  修订应用（单点 + 循环位）/ 组织差异
 */
const fs = require('fs');
const path = require('path');
const { Engine } = require(path.join(__dirname, '..', 'static', 'engine.js'));
const { DefectCore: DC } = require(path.join(__dirname, '..', 'static', 'defect-core.js'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS -', name); }
  else { fail++; console.log('FAIL -', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ---------------- 坐标换算 ---------------- */
{
  const d = Engine.defaultDraft(); // 16×16，斜纹
  const q = DC.normalizeParams({ warpDensity: 10, weftDensity: 8, originX: 20, originY: 10 });
  check('间距：10 根/cm → 1mm', approx(DC.pitch(q).x, 1));
  check('间距：8 根/cm → 1.25mm', approx(DC.pitch(q).y, 1.25));

  // (21.5, 11.0)：距原点 1.5mm（x）→ end 1；1mm（y）→ pick 0
  let loc = DC.locate(21.5, 11.0, q, d);
  check('x=21.5 → 第 2 根经 (end=1)', loc.end === 1, loc);
  check('y=11.0 → 第 1 根纬 (pick=0)', loc.pick === 0, loc);
  check('在设计幅内', loc.inCloth === true);

  // 边界：原点自身 → 0
  loc = DC.locate(20, 10, q, d);
  check('原点 → end=0/pick=0', loc.end === 0 && loc.pick === 0, loc);

  // 幅外：x=200 → end=180（保留幅外推算序号，inWarp=false）
  loc = DC.locate(200, 10, q, d);
  check('幅外 end=180 且 inWarp=false', loc.end === 180 && loc.inWarp === false, loc);
  loc = DC.locate(20, 0, q, d);
  check('布首前 pick=-8（保留负值）', loc.pick === -8 && loc.inWeft === false, loc);

  // 缩率 10%：成品超出原点 9mm → 上机 10mm
  const q2 = DC.normalizeParams({ warpDensity: 10, weftDensity: 10, warpShrink: 10, weftShrink: 10, originX: 20, originY: 20 });
  loc = DC.locate(29, 29, q2, d);
  check('缩率 10%：成品 9mm → 上机 10mm', approx(loc.loomX, 30) && approx(loc.loomY, 30), [loc.loomX, loc.loomY]);
  check('序号按成品密度换算 end=9', loc.end === 9, loc.end);

  // indexToMm 互为反算（格子中心）
  const mm = DC.indexToMm(0, 0, q);
  check('序号 0 的格子中心在原点后半格', approx(mm.x, 20.5) && approx(mm.y, 10.625), mm);
}

/* ---------------- 循环位 / 循环砖 ---------------- */
{
  const cp0 = DC.cyclePosition({ end: 0, pick: 0 }, 4, 4);
  check('循环位 (0,0) 砖 (0,0)', cp0.cx === 0 && cp0.cy === 0 && cp0.tileX === 0 && cp0.tileY === 0, cp0);
  const cp1 = DC.cyclePosition({ end: 5, pick: 6 }, 4, 4);
  check('end5/pick6 → 循环位 (1,2) 砖 (1,1)', cp1.cx === 1 && cp1.cy === 2 && cp1.tileX === 1 && cp1.tileY === 1, cp1);
  // 越界负序号也取模
  const cp2 = DC.cyclePosition({ end: -1, pick: -1 }, 4, 4);
  check('负序号循环位取模 (-1 → 3)', cp2.cx === 3 && cp2.cy === 3 && cp2.tileX === -1 && cp2.tileY === -1, cp2);

  const d = Engine.defaultDraft();
  const rep = DC.snapshotRepeats(Engine, d);
  check('默认斜纹快照循环 4×4', rep.warp === 4 && rep.weft === 4, rep);
}

/* ---------------- 标记关联 ---------------- */
{
  const d = Engine.defaultDraft();
  const A = Engine.analyze(d);
  const m = { end: 2, pick: 3 };
  const rel = DC.relate(m, d, A.derived);
  check('end2 → 综框 3', rel.shaft === 2, rel.shaft);
  check('pick3 → 踏板 4', rel.treadle === 3, rel.treadle);
  // 斜纹联结：踏 t 升起 t、t+1（模 4）；踏 3 升起 3、0
  check('联结升起源 = 综框 1、4', rel.tiePoints.sort().join(',') === '0,3', rel.tiePoints);
  check('lifted 同口径', rel.lifted.sort().join(',') === '0,3', rel.lifted);
  check('组织格值 0/1', rel.drawdown === 0 || rel.drawdown === 1);

  // 多梭关联
  d.shuttles.picks[3] = { s: 1, enter: 'L', join: 'wrap' };
  const rel2 = DC.relate(m, d, Engine.derive(d));
  check('梭次关联到梭 2', rel2.shuttle && rel2.shuttle.s === 1 && rel2.shuttle.enter === 'L', rel2.shuttle);

  // 幅外标记
  const rel3 = DC.relate({ end: -1, pick: -1 }, d, A.derived);
  check('幅外无关联', rel3.shaft === null && rel3.treadle === null);
}

/* ---------------- 浮线核查 ---------------- */
{
  const d = Engine.blankDraft(4, 4, 8, 8);
  // 构造：所有经穿综框 0，综框 0 与全部踏板联结 → end 0 全程经在上（经浮长 8）
  for (let p = 0; p < 8; p++) d.treadling[p] = p % 4;
  d.tieup = d.tieup.map((row, s) => row.map(() => s === 0));
  d.threading = d.threading.map(() => 0);
  d.threading[1] = 1;  // 第 2 根经穿综框 1，不会全程升起
  const A = Engine.analyze(d);
  check('构造出经浮长 8', A.fl.maxWarp === 8, A.fl.maxWarp);
  const fr = DC.floatRunAt(A.fl, 0, 3);
  check('经浮长覆盖 (0,3)：长度 8', fr.warpRun && fr.warpRun.length === 8, fr.warpRun);
  const fr2 = DC.floatRunAt(A.fl, 1, 3);
  check('他列无经浮', fr2.warpRun === null, fr2.warpRun);
}

/* ---------------- 反复出现：跨循环 / 跨批次 ---------------- */
{
  const snap = Engine.defaultDraft();
  const mk = (id, type, end, pick, mmX, mmY) =>
    ({ id, type, end, pick, mmX: mmX ?? 0, mmY: mmY ?? 0, note: '' });
  // 同批次：循环位 (1,3)，砖 (0,0) 与 (1,1)
  const b1 = {
    id: 1, draftId: 7, snapshot: snap, repeatWarp: 4, repeatWeft: 4,
    marks: [mk(11, 'mistread', 1, 3, 21.5, 23.5), mk(12, 'mistread', 5, 7, 25.5, 27.5)],
  };
  // 另一批次（同源 draftId 7）同样循环位
  const b2 = {
    id: 2, draftId: 7, snapshot: snap, repeatWarp: 4, repeatWeft: 4,
    marks: [mk(21, 'mistread', 1, 3, 21.5, 23.5)],
  };
  // 另一设计（不同 draftId + 不同快照指纹），不应跨批次
  const other = Engine.blankDraft(2, 2, 8, 8);
  const b3 = {
    id: 3, draftId: 9, snapshot: other, repeatWarp: 2, repeatWeft: 2,
    marks: [mk(31, 'mistread', 1, 1, 0, 0)],
  };
  const R = DC.analyzeRecurrence([b1, b2, b3]);
  const g11 = R.markGroup.get('1:11');
  check('同组：标记 11 与 12', g11 && R.markGroup.get('1:12') === g11);
  check('跨循环（不同循环砖）', g11.crossCycle === true, { perBatch: g11.perBatch.map(p => [...p.tiles]) });
  check('跨批次（批次 1、2）', g11.crossBatch === true, g11.batches);
  check('组成员 3 处', g11.count === 3, g11.count);
  check('核查综框去重（end1→2 综, end5→2 综）= 综框 2', g11.shafts.join(',') === '1', g11.shafts);
  check('核查踏板 = 踏板 4', g11.treadles.join(',') === '3', g11.treadles);
  check('联结点非空', g11.tiePoints.length > 0, g11.tiePoints);
  const g31 = R.markGroup.get('3:31');
  check('不同设计不跨批次', g31.crossBatch === false && g31.count === 1);

  // 单次缺陷不成组（count==1 且无幅外）
  const R2 = DC.analyzeRecurrence([{
    id: 1, draftId: 1, snapshot: snap, repeatWarp: 4, repeatWeft: 4,
    marks: [mk(1, 'miss', 0, 0)],
  }]);
  const g = R2.groups[0];
  check('单次缺陷非反复', g.crossCycle === false && g.crossBatch === false && g.count === 1);

  // 同循环位但同砖（重复标记）不算跨循环
  const R3 = DC.analyzeRecurrence([{
    id: 1, draftId: 1, snapshot: snap, repeatWarp: 4, repeatWeft: 4,
    marks: [mk(1, 'broken', 1, 1), mk(2, 'broken', 1, 1)],
  }]);
  check('同砖重复打点不算跨循环', R3.groups[0].crossCycle === false);

  // 无 draftId 时按快照指纹归源
  const b4 = { id: 4, draftId: null, snapshot: JSON.parse(JSON.stringify(snap)), repeatWarp: 4, repeatWeft: 4, marks: [mk(41, 'float', 0, 0)] };
  const b5 = { id: 5, draftId: null, snapshot: JSON.parse(JSON.stringify(snap)), repeatWarp: 4, repeatWeft: 4, marks: [mk(51, 'float', 0, 0)] };
  const R4 = DC.analyzeRecurrence([b4, b5]);
  check('无 draftId 同指纹仍判跨批次', R4.groups[0].crossBatch === true);

  // 回归①：两批次各仅 1 处、循环砖不同 → 跨批次成立，但不构成跨循环
  const c1 = {
    id: 11, draftId: 21, snapshot: snap, repeatWarp: 4, repeatWeft: 4,
    marks: [mk(111, 'miss', 1, 3)],                         // 循环位 (1,3)，砖 (0,0)
  };
  const c2 = {
    id: 12, draftId: 21, snapshot: snap, repeatWarp: 4, repeatWeft: 4,
    marks: [mk(121, 'miss', 5, 7)],                         // 同循环位 (1,3)，砖 (1,1)
  };
  const RC = DC.analyzeRecurrence([c1, c2]);
  check('[回归] 两批次各单点不同砖：跨批次=true', RC.groups[0].crossBatch === true);
  check('[回归] 两批次各单点不同砖：跨循环=false', RC.groups[0].crossCycle === false, RC.groups[0].perBatch);

  // 对照：同批次两处不同砖 → 跨循环成立
  const d1 = {
    id: 13, draftId: 22, snapshot: snap, repeatWarp: 4, repeatWeft: 4,
    marks: [mk(131, 'miss', 1, 3), mk(132, 'miss', 5, 7)],  // 砖 (0,0) 与 (1,1)
  };
  const RD = DC.analyzeRecurrence([d1]);
  check('同批次两处不同砖：跨循环=true', RD.groups[0].crossCycle === true);
  check('单批次：跨批次=false', RD.groups[0].crossBatch === false);

  // 对照：两批次各单点且同砖（同循环位重复出现于两批）→ 仅跨批次
  const e1 = { id: 14, draftId: 23, snapshot: snap, repeatWarp: 4, repeatWeft: 4, marks: [mk(141, 'broken', 2, 2)] };
  const e2 = { id: 15, draftId: 23, snapshot: snap, repeatWarp: 4, repeatWeft: 4, marks: [mk(151, 'broken', 2, 2)] };
  const RE = DC.analyzeRecurrence([e1, e2]);
  check('两批次同砖单点：跨批次=true 且 跨循环=false',
    RE.groups[0].crossBatch === true && RE.groups[0].crossCycle === false);

  // 混合：批次1两处（不同砖）+ 批次2一处 → crossBatch 与 crossCycle 同时成立
  const f1 = {
    id: 16, draftId: 24, snapshot: snap, repeatWarp: 4, repeatWeft: 4,
    marks: [mk(161, 'float', 1, 3), mk(162, 'float', 5, 7)],
  };
  const f2 = { id: 17, draftId: 24, snapshot: snap, repeatWarp: 4, repeatWeft: 4, marks: [mk(171, 'float', 1, 3)] };
  const RF = DC.analyzeRecurrence([f1, f2]);
  check('混合重复：跨批次与同批跨循环同时成立',
    RF.groups[0].crossBatch === true && RF.groups[0].crossCycle === true);
  check('perBatch 逐批次计数（2、1）',
    RF.groups[0].perBatch.map(p => p.count).sort().join(',') === '1,2',
    RF.groups[0].perBatch.map(p => p.count));
}

/* ---------------- 修订：穿综 / 联结 / 踩踏 + 差异 ---------------- */
{
  const d = Engine.defaultDraft();
  // 穿综：单点 end0 → 综框 2
  let r = DC.applyRevision(d, { action: 'threading', end: 0, shaft: 1, applyCycle: false, rw: 4 });
  check('单点穿综只改 1 根', r.meta.ends.length === 1 && r.draft.threading[0] === 1 && r.draft.threading[4] === 0);
  check('原快照未被改写', d.threading[0] === 0);
  let diff = DC.diffDraft(Engine, d, r.draft, r.meta);
  check('差异格数 > 0', diff.changed > 0, diff.changed);
  check('差异标记修订列', diff.revEnds.join(',') === '0');
  check('摘要含改动格数', DC.revisionSummary('threading', { end: 0, shaft: 1 }, diff).includes(String(diff.changed)));

  // 穿综：循环位应用（end 0 → 0,4,8,12）
  r = DC.applyRevision(d, { action: 'threading', end: 0, shaft: 1, applyCycle: true, rw: 4 });
  check('循环位穿综改 4 根', r.meta.ends.join(',') === '0,4,8,12', r.meta.ends);

  // 踩踏：循环位应用（pick 1 → 1,5,9,13）
  r = DC.applyRevision(d, { action: 'treadling', pick: 1, treadle: 0, applyCycle: true, rh: 4 });
  check('循环位踩踏改 4 纬', r.meta.picks.join(',') === '1,5,9,13', r.meta.picks);

  // 联结翻转：斜纹 tieup[0][0]=true → false
  const before = d.tieup[0][0];
  r = DC.applyRevision(d, { action: 'tieup', shaft: 0, treadle: 0, value: !before });
  check('联结翻转', r.draft.tieup[0][0] === !before);
  diff = DC.diffDraft(Engine, d, r.draft, r.meta);
  check('联结修订影响多纬组织', diff.changed > 0);
  check('浮线统计字段存在', typeof diff.maxWarpAfter === 'number' && typeof diff.maxWeftAfter === 'number');

  // 无效动作
  let threw = false;
  try { DC.applyRevision(d, { action: 'bogus' }); } catch (e) { threw = true; }
  check('未知修订类型抛错', threw);
}

/* ---------------- 参数规整 ---------------- */
{
  const q = DC.normalizeParams({ warpDensity: -5, weftDensity: 'x', originX: 999999999 });
  check('密度下限 0.1', q.warpDensity === 0.1 && q.weftDensity === 10);
  check('原点夹取范围', q.originX === 100000);
  const q2 = DC.normalizeParams(null);
  check('空参数回退默认 10/10/0/0', q2.warpDensity === 10 && q2.weftDensity === 10 &&
    q2.warpShrink === 0 && q2.originX === 0);
}

console.log(`\nRESULT: ${fail ? 'FAIL' : 'ALL PASS'} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
