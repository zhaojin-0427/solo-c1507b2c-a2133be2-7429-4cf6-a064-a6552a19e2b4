/**
 * 上机工艺单 — 纯逻辑核心测试（loom-core.js）
 *  参数规整 / 整经根数循环取整 / 筘幅 / 经长 / 纬数 / 分色用纱量 /
 *  穿筘序列搜索（精确 + 偏差说明 + 均匀度）/ 步骤压缩 / 指纹
 */
const path = require('path');
const { Engine } = require(path.join(__dirname, '..', 'static', 'engine.js'));
const { LoomCore: LC } = require(path.join(__dirname, '..', 'static', 'loom-core.js'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS -', name); }
  else { fail++; console.log('FAIL -', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ---------------- 参数规整 ---------------- */
{
  const q = LC.normalizeParams({});
  check('缺省参数：成品 40×200cm', q.finishWidth === 40 && q.finishLength === 200);
  check('缺省缩率 8%', q.warpShrink === 8 && q.weftShrink === 8);
  check('缺省筘 5 筘/cm', q.reedDents === 5);
  const q2 = LC.normalizeParams({ finishWidth: -5, warpShrink: 200, reedDents: 0 });
  check('越界参数被钳制', q2.finishWidth === 1 && q2.warpShrink === 90 && q2.reedDents === 0.5, q2);
  const gpm = LC.normalizeYarnGpm([0.08, 'x', -1], 4);
  check('纱重规整：非法值回退 0.05，越界钳制', approx(gpm[0], 0.08) && approx(gpm[1], 0.05) && approx(gpm[2], 0.001) && approx(gpm[3], 0.05), gpm);
}

/* ---------------- 主推算 ---------------- */
{
  const d = Engine.defaultDraft();   // 16×16 斜纹，经循环 4
  const plan = LC.derivePlan(Engine, d, {
    finishWidth: 40, finishLength: 200,
    warpShrink: 10, weftShrink: 10,
    warpDensity: 10, weftDensity: 12,
    reedDents: 5, wasteFront: 30, wasteBack: 40,
    yarnGpm: [0.06, 0.04],
  });
  check('经向循环 4', plan.repeatWarp === 4, plan.repeatWarp);
  check('整经根数 40cm×10 = 400（恰为循环整数倍）', plan.totalEnds === 400, plan.totalEnds);
  check('上机经密 = 10×0.9 = 9 根/cm', approx(plan.loomDensity, 9), plan.loomDensity);
  check('上机筘幅 = 400/9 cm', approx(plan.reedWidthCm, 400 / 9), plan.reedWidthCm);
  check('经纱长度 = 200/0.9 + 30 + 40 cm', approx(plan.warpLengthCm, 200 / 0.9 + 70), plan.warpLengthCm);
  check('预计纬数 = 200×12 = 2400', plan.estPicks === 2400, plan.estPicks);

  // 单色经（全色号0）：400 根 × 长度 × 0.06 g/m
  const w0 = plan.warpColors.find(x => x.color === 0);
  check('经纱分色只有色号 1', plan.warpColors.length === 1 && w0 && w0.ends === 400, plan.warpColors);
  check('经用量 = 400 × 经长(m) × 0.06', approx(w0.grams, 400 * plan.warpLengthM * 0.06), w0.grams);
  // 单色纬（全色号1）：2400 纬 × 筘幅(m) × 0.04
  const f0 = plan.weftColors.find(x => x.color === 1);
  check('纬纱分色只有色号 2', plan.weftColors.length === 1 && f0 && f0.picks === 2400, plan.weftColors);
  check('纬用量 = 2400 × 筘幅(m) × 0.04', approx(f0.grams, 2400 * plan.reedWidthM * 0.04), f0.grams);
  check('总量 = 经 + 纬', approx(plan.totalGrams, plan.totalWarpGrams + plan.totalWeftGrams));
}

/* ---------------- 整经根数按循环取整 + 分色 ---------------- */
{
  const d = Engine.defaultDraft();
  // 色经循环：4 根一循环 [0,0,1,1]
  d.warpColor = Array.from({ length: 16 }, (_, i) => Math.floor(i / 2) % 2);
  const plan = LC.derivePlan(Engine, d, {
    finishWidth: 40.5, warpDensity: 10, weftDensity: 10,
    warpShrink: 0, weftShrink: 0, wasteFront: 0, wasteBack: 0,
    yarnGpm: [0.05, 0.05],
  });
  check('原算 405 根 → 取整到循环 4 的倍数 408', plan.rawEnds === 405 && plan.totalEnds === 408, [plan.rawEnds, plan.totalEnds]);
  check('取整差 3 根', plan.endsAdjusted === 3, plan.endsAdjusted);
  const sum = plan.warpColors.reduce((s, x) => s + x.ends, 0);
  check('分色根数合计 = 整经根数', sum === 408, sum);
  const c0 = plan.warpColors.find(x => x.color === 0);
  const c1 = plan.warpColors.find(x => x.color === 1);
  check('两色各半（204/204）', c0.ends === 204 && c1.ends === 204, [c0.ends, c1.ends]);
}

/* ---------------- 穿筘序列搜索 ---------------- */
{
  // 目标平均 2 根/筘：精确 [2]
  let rs = LC.searchReedPlans(2);
  check('目标 2：精确匹配 [2]', rs.exact && rs.plans[0].seq.join(',') === '2', rs.plans[0]);
  check('精确时无偏差说明', LC.reedNote(rs, 5) === null);

  // 目标 2.5：精确 [2 3]（Bresenham 均布）
  rs = LC.searchReedPlans(2.5);
  check('目标 2.5：精确 [2 3]', rs.exact && rs.plans[0].seq.join(',') === '2,3', rs.plans[0]);

  // 目标 7/3 ≈ 2.333：精确 [2 2 3]
  rs = LC.searchReedPlans(7 / 3);
  check('目标 7/3：精确 [2 2 3]', rs.exact && rs.plans[0].seq.join(',') === '2,2,3', rs.plans[0]);

  // 目标 2.37：≤8 筘循环无法精确 → 有偏差说明
  rs = LC.searchReedPlans(2.37);
  check('目标 2.37：无法精确', !rs.exact);
  check('候选按误差排序', rs.plans[0].err <= rs.plans[1].err, rs.plans.map(p => p.err));
  const note = LC.reedNote(rs, 5);
  check('偏差说明包含“无法”与“根/cm”', !!note && note.includes('无法') && note.includes('根/cm'), note);

  // 目标 5（>4）：最佳为全 4，说明存在
  rs = LC.searchReedPlans(5);
  check('目标 5：最佳 [4] 且有偏差说明', rs.plans[0].seq.join(',') === '4' && !!LC.reedNote(rs, 5), rs.plans[0]);

  // 均匀度：[2 3] 比 [2 2 3 3] 类序列更均匀；非本原序列被剔除
  rs = LC.searchReedPlans(2.5);
  const keys = rs.plans.map(p => p.seq.join(','));
  check('候选不含非本原序列 [2,3,2,3]', !keys.includes('2,3,2,3'), keys);
  check('均匀度单调（误差相同时）', LC.discrepancy([2, 3]) < LC.discrepancy([3, 3, 2, 2]));
}

/* ---------------- 穿筘逐筘展开 ---------------- */
{
  const walk = LC.dentWalk(10, [2, 3]);
  check('10 根按 [2,3] 分 4 筘', walk.length === 4, walk);
  check('逐筘区段衔接', walk[0].from === 1 && walk[0].to === 2 && walk[1].from === 3 && walk[1].to === 5, walk.slice(0, 2));
  check('10 = 2+3+2+3 恰满', walk[3].take === 3 && walk[3].full === true, walk[3]);
  const walkP = LC.dentWalk(9, [2, 3]);
  check('9 根末筘不满（2+3+2+2）', walkP.length === 4 && walkP[3].take === 2 && walkP[3].full === false, walkP[3]);
  const walk2 = LC.dentWalk(5, [2, 3]);
  check('5 根恰满 2 筘', walk2.length === 2 && walk2.every(w => w.full), walk2);
}

/* ---------------- 步骤生成 ---------------- */
{
  const d = Engine.defaultDraft();
  const plan = LC.derivePlan(Engine, d, {
    finishWidth: 3.2, warpDensity: 10, weftDensity: 10,
    warpShrink: 0, weftShrink: 0, wasteFront: 0, wasteBack: 0,
  });
  check('整经 32 根（循环 4）', plan.totalEnds === 32, plan.totalEnds);
  const steps = LC.buildSteps(d, plan, [2]);
  check('步骤数 = 1 整经 + 1 穿综 + 1 穿筘', steps.length === 3, steps.map(s => s.kind));
  check('步骤顺序：整经→穿综→穿筘', steps[0].kind === 'warp' && steps[1].kind === 'thread' && steps[2].kind === 'dent');
  check('整经段覆盖 1–32', steps[0].detail.from === 1 && steps[0].detail.to === 32 && steps[0].detail.count === 32, steps[0].detail);
  check('穿综循环 [1,2,3,4] ×8', steps[1].detail.cycle.join(',') === '0,1,2,3' && steps[1].detail.times === 8, steps[1].detail);
  check('穿筘 32 根 ÷ 每筘 2 = 16 筘', steps[2].detail.dents === 16 && steps[2].detail.lastPartial === null, steps[2].detail);
  check('步骤带序号', steps.every((s, i) => s.index === i));

  // 条纹色经 → 多段整经
  const d2 = Engine.defaultDraft();
  d2.warpColor = Array.from({ length: 16 }, (_, i) => Math.floor(i / 4) % 2);   // [0×4, 1×4] 循环 8
  const plan2 = LC.derivePlan(Engine, d2, {
    finishWidth: 3.2, warpDensity: 10, weftDensity: 10,
    warpShrink: 0, weftShrink: 0, wasteFront: 0, wasteBack: 0,
  });
  const steps2 = LC.buildSteps(d2, plan2, [2]);
  const warpSteps = steps2.filter(s => s.kind === 'warp');
  check('条纹色经 → 8 段整经（32 根 ÷ 4 根/段）', warpSteps.length === 8, warpSteps.length);
  check('整经段连续覆盖', warpSteps.every((s, i) => s.detail.from === i * 4 + 1 && s.detail.to === (i + 1) * 4));
  check('跨段色号交替', warpSteps[0].detail.color === 0 && warpSteps[1].detail.color === 1);

  // 交替色经（用户场景：201cm × 10 根/cm → 2012 根）→ 退化为一段色序循环
  const dAlt = Engine.defaultDraft();
  dAlt.warpColor = Array.from({ length: 16 }, (_, i) => i % 2);   // [0,1] 交替，周期 2
  const planAlt = LC.derivePlan(Engine, dAlt, {
    finishWidth: 201, warpDensity: 10, weftDensity: 10,
    warpShrink: 8, weftShrink: 8, wasteFront: 30, wasteBack: 30,
  });
  check('交替色经：201cm×10 → 整经 2012 根', planAlt.totalEnds === 2012, planAlt.totalEnds);
  const stepsAlt = LC.buildSteps(dAlt, planAlt, [2]);
  const warpAlt = stepsAlt.filter(s => s.kind === 'warp');
  check('交替色经 → 仅 1 段色序循环（而非 2012 段）', warpAlt.length === 1, warpAlt.length);
  check('色序循环段带 cycle 明细', Array.isArray(warpAlt[0].detail.cycle) &&
    warpAlt[0].detail.cycle.join(',') === '0,1' && warpAlt[0].detail.times === 1006, warpAlt[0].detail);
  check('色序循环覆盖整幅', warpAlt[0].detail.from === 1 && warpAlt[0].detail.to === 2012);
  check('总步骤 3 步（可正常冻结）', stepsAlt.length === 3, stepsAlt.length);
  check('步骤文本为“色序循环”', warpAlt[0].label.includes('色序循环'), warpAlt[0].label);

  // 段数阈值：每周期 100 个单根色段（周期 100）→ 超过 64 段也退化为循环段
  const dMany = Engine.defaultDraft();
  const manyColors = Array.from({ length: 100 }, (_, i) => (i * 7) % 8);
  dMany.warpColor = manyColors.concat(manyColors).slice(0, 16);  // 草稿 16 根内无重复周期
  // 直接构造 plan（整经 1000 根、色经周期 16）
  const planMany = { totalEnds: 1000, warpColorP: 16, threadingP: 4 };
  const stepsMany = LC.buildSteps(dMany, planMany, [2]);
  const warpMany = stepsMany.filter(s => s.kind === 'warp');
  check('细碎色序（16 根无同色相邻）→ 循环段', warpMany.length === 1 && Array.isArray(warpMany[0].detail.cycle),
    warpMany.length);
  check('循环段周期 16', warpMany[0].detail.cycle.length === 16, warpMany[0].detail.cycle);

  // 段数 ≤ 阈值时保留连续段（双色大块：48 根 = 3 次循环 × 2 段 = 6 段）
  const dBlock = Engine.defaultDraft();
  dBlock.warpColor = Array.from({ length: 16 }, (_, i) => (i < 8 ? 0 : 1));
  const planBlock = LC.derivePlan(Engine, dBlock, {
    finishWidth: 4, warpDensity: 10, weftDensity: 10,
    warpShrink: 0, weftShrink: 0, wasteFront: 0, wasteBack: 0,
  });
  const warpBlock = LC.buildSteps(dBlock, planBlock, [2]).filter(s => s.kind === 'warp');
  check('大块双色 → 保留连续段（3 循环 × 2 段 = 6 段）', warpBlock.length === 6 &&
    warpBlock[0].detail.color === 0 && warpBlock[1].detail.color === 1, warpBlock.length);
  check('连续段各 8 根', warpBlock.every(s => s.detail.count === 8), warpBlock.map(s => s.detail.count));

  // 末筘不足：33 根按每筘 2 → 17 筘，末筘 1 根
  const d3 = Engine.defaultDraft();
  const plan3 = LC.derivePlan(Engine, d3, {
    finishWidth: 3.3, warpDensity: 10, weftDensity: 10,
    warpShrink: 0, weftShrink: 0, wasteFront: 0, wasteBack: 0,
  });
  // 33 → 取整到循环 4 → 36；改用直接构造验证末筘逻辑
  const plan3x = { ...plan3, totalEnds: 33, warpColorP: 1, threadingP: 4 };
  const steps3 = LC.buildSteps(d3, plan3x, [2]);
  const dent3 = steps3.find(s => s.kind === 'dent');
  check('33 根每筘 2 → 17 筘末筘 1 根', dent3.detail.dents === 17 && dent3.detail.lastPartial === 1, dent3.detail);
  check('末筘标注进入步骤文本', dent3.label.includes('末筘 1 根'), dent3.label);
}

/* ---------------- 指纹 ---------------- */
{
  const d = Engine.defaultDraft();
  const p = { finishWidth: 40, warpDensity: 10 };
  const f1 = LC.fingerprint(d, p);
  check('同参同稿指纹一致', LC.fingerprint(d, p) === f1);
  check('参数变化指纹不同', LC.fingerprint(d, { ...p, finishWidth: 41 }) !== f1);
  const d2 = Engine.cloneDraft(d);
  d2.threading[0] = 3;
  check('草稿变化指纹不同', LC.fingerprint(d2, p) !== f1);
  check('纱重变化指纹不同', LC.fingerprint(d, { ...p, yarnGpm: [0.09] }) !== f1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
