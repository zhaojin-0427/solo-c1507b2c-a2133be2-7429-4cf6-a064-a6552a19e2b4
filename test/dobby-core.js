/**
 * 多臂织机升综计划 — 纯逻辑核心测试（dobby-core.js + engine.js dobby 部分）
 *  矩阵规整 / 从草稿生成 / dobby 驱动组织推导 / 设备约束校验 /
 *  纬段批量操作 / 升综组合与踏板还原 / 组织差异比较 / 草稿保存字段
 */
const path = require('path');
const { Engine } = require(path.join(__dirname, '..', 'static', 'engine.js'));
const { DobbyCore: DC } = require(path.join(__dirname, '..', 'static', 'dobby-core.js'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS -', name); }
  else { fail++; console.log('FAIL -', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------------- 数据规整 ---------------- */
{
  const n = Engine.normalizeDobby(null, 16, 4);
  check('缺省：16×4 全落下、未启用', n.cells.length === 16 && n.cells[0].length === 4 &&
    n.cells.every(r => r.every(v => !v)) && n.enabled === false);
  check('缺省：设备限制取草稿综框数', n.deviceShafts === 4 && n.maxLift === 4 && n.maxSwitch === 4, n);

  // 旧草稿 16 纬 4 综框：缺失矩阵按实际尺寸补齐（不为 1×1）
  const old = Engine.defaultDraft();
  delete old.dobby;
  const m = Engine.normalizeDobby(old.dobby, old.picks, old.shafts);
  check('旧草稿补齐为 16×4（非 1×1）', m.cells.length === 16 && m.cells[0].length === 4);

  // 残缺数据：越界行 / 非布尔值被规整
  const r = Engine.normalizeDobby({ enabled: 1, deviceShafts: 99, cells: [[1, 0, 'x'], null] }, 3, 2);
  check('残缺规整：3×2、越界丢弃、真值化', r.cells.length === 3 &&
    eq(r.cells[0], [true, false]) && eq(r.cells[1], [false, false]) && eq(r.cells[2], [false, false]), r.cells);
  check('设备数钳制到 24', r.deviceShafts === 24, r.deviceShafts);
  check('enabled 真值化', r.enabled === true);
}

/* ---------------- 从草稿生成 ---------------- */
{
  const d = Engine.defaultDraft();   // 4 综框 2/2 斜纹：踏 t → 综框 t、t+1
  const cells = DC.cellsFromDraft(d);
  check('生成 16×4 矩阵', cells.length === 16 && cells[0].length === 4);
  check('首纬升综框 1、2', eq(cells[0], [true, true, false, false]), cells[0]);
  check('第 2 纬升综框 2、3', eq(cells[1], [false, true, true, false]), cells[1]);
  // 空踏板 / 未踩踏 → 全落下
  const d2 = Engine.defaultDraft();
  d2.treadling[0] = -1;
  d2.tieup[1][1] = false; d2.tieup[2][1] = false;   // 踏板 2（联结综框 2、3）变空联结
  const c2 = DC.cellsFromDraft(d2);
  check('未踩踏纬 → 全落下', c2[0].every(v => !v));
  check('空联结踏板纬 → 全落下', c2[1].every(v => !v));
}

/* ---------------- dobby 驱动组织推导 ---------------- */
{
  const d = Engine.defaultDraft();
  const cells = DC.cellsFromDraft(d);
  d.dobby = Engine.normalizeDobby({ enabled: true, cells }, d.picks, d.shafts);
  const dd = Engine.derive(d);
  check('lifted 取自升综矩阵', dd.lifted[0].has(0) && dd.lifted[0].has(1) && dd.lifted[0].size === 2);
  check('dobby 模式组织与踏板模式一致',
    eq(dd.drawdown, Engine.derive(Engine.defaultDraft()).drawdown));
  // 自定义矩阵改变组织
  const d2 = Engine.defaultDraft();
  const c2 = DC.cellsFromDraft(d2);
  c2[0] = [true, false, false, false];
  d2.dobby = Engine.normalizeDobby({ enabled: true, cells: c2 }, 16, 4);
  const dd2 = Engine.derive(d2);
  check('自定义矩阵生效（首纬仅综框 1 升）', dd2.lifted[0].size === 1 && dd2.lifted[0].has(0));
  check('组织图随矩阵变化', dd2.drawdown[0][0] === 1 && dd2.drawdown[0][1] === 0);
  // 空行 = 全幅纬浮（有效组织，非缺失）
  const d3 = Engine.defaultDraft();
  const c3 = DC.cellsFromDraft(d3);
  c3[0] = [false, false, false, false];
  d3.dobby = Engine.normalizeDobby({ enabled: true, cells: c3 }, 16, 4);
  const dd3 = Engine.derive(d3);
  check('空升综行有效（全纬浮）', dd3.pickValid[0] === true && dd3.drawdown[0].every(v => v === 0));
  // 停用时回到踏板驱动
  const d4 = Engine.defaultDraft();
  d4.dobby = Engine.normalizeDobby({ enabled: false, cells: c2 }, 16, 4);
  check('停用后组织由联结·踩踏驱动', eq(Engine.derive(d4).drawdown, Engine.derive(Engine.defaultDraft()).drawdown));
  // 纬向周期取升综行周期
  const d5 = Engine.defaultDraft();
  const cyc = cells.map((_, p) => cells[p % 2]);
  d5.dobby = Engine.normalizeDobby({ enabled: true, cells: cyc }, 16, 4);
  const rep = Engine.repeats(d5, Engine.derive(d5));
  check('升综驱动时纬向周期取矩阵行周期 2', rep.treadlingP === 2, rep.treadlingP);
}

/* ---------------- 设备约束校验 ---------------- */
{
  const d = Engine.defaultDraft();
  const cells = DC.cellsFromDraft(d);   // 每纬升 2 综，相邻纬切换 2
  const db = Engine.normalizeDobby({ enabled: true, deviceShafts: 2, maxLift: 1, maxSwitch: 1, cells }, 16, 4);
  const iss = DC.validateDobby(db, 16, 4);
  check('越界检出（升综框 3、4 超出设备 2）', iss.filter(i => i.code === 'dobby-shaft-range').length > 0);
  check('越界级别 error', iss.find(i => i.code === 'dobby-shaft-range').level === 'error');
  check('超限检出（升 2 > 上限 1）', iss.filter(i => i.code === 'dobby-lift-limit').length === 16);
  check('切换过大检出（切换 2 > 上限 1）', iss.filter(i => i.code === 'dobby-switch-limit').length === 15);
  check('切换过大级别 warn', iss.find(i => i.code === 'dobby-switch-limit').level === 'warn');
  check('问题带纬次（0 基）', iss.find(i => i.code === 'dobby-lift-limit').pick === 0);

  // 空升综行提示
  const cells2 = DC.cellsFromDraft(d);
  cells2[5] = [false, false, false, false];
  const db2 = Engine.normalizeDobby({ enabled: true, cells: cells2 }, 16, 4);
  const iss2 = DC.validateDobby(db2, 16, 4);
  check('空升综行提示', iss2.some(i => i.code === 'dobby-empty' && i.pick === 5));

  // Engine.validate 集成（仅启用时）
  const dOn = Engine.defaultDraft();
  dOn.dobby = db;
  const ana = Engine.analyze(dOn);
  check('Engine.validate 含越界/超限/切换', ['dobby-shaft-range', 'dobby-lift-limit', 'dobby-switch-limit']
    .every(c => ana.validation.issues.some(i => i.code === c)));
  check('主校验问题可定位到踩踏行', (() => {
    const i = ana.validation.issues.find(x => x.code === 'dobby-lift-limit');
    return i.loc.length === 1 && i.loc[0].grid === 'treadling' && i.loc[0].r === 0;
  })(), ana.validation.issues.find(x => x.code === 'dobby-lift-limit'));
  const dOff = Engine.defaultDraft();
  dOff.dobby = Engine.normalizeDobby({ enabled: false, deviceShafts: 2, maxLift: 1, maxSwitch: 1, cells }, 16, 4);
  check('停用时主校验不含 dobby 问题',
    !Engine.analyze(dOff).validation.issues.some(i => i.code.startsWith('dobby-')));
}

/* ---------------- 纬段批量操作 ---------------- */
{
  const cells = DC.cellsFromDraft(Engine.defaultDraft());
  // 复制：0–3 纬 → 第 9 纬起
  const cp = DC.copyRange(cells, 0, 3, 8);
  check('复制纬段到目标', eq(cp[8], cells[0]) && eq(cp[11], cells[3]));
  check('复制不改动原矩阵（纯函数）', !cells[8][0] === false || eq(cells[8], DC.cellsFromDraft(Engine.defaultDraft())[8]));
  // 循环填充：0–1 纬为模板
  const cy = DC.cycleFill(cells, 0, 1);
  check('循环填充至末尾', eq(cy[4], cells[0]) && eq(cy[15], cells[1]));
  // 镜像：0–3 纬倒序
  const mi = DC.mirrorRange(cells, 0, 3);
  check('纬段镜像', eq(mi[0], cells[3]) && eq(mi[3], cells[0]) && eq(mi[4], cells[4]));
  // 平移 +2：段移走、原位清空、落点覆盖
  const sh = DC.shiftRange(cells, 0, 3, 2);
  check('平移纬段', eq(sh[2], cells[0]) && eq(sh[5], cells[3]) && sh[0].every(v => !v) && sh[1].every(v => !v));
  // 平移 -2：前两纬出界丢弃，3、4 纬落到 1、2 位
  const sh2 = DC.shiftRange(cells, 0, 3, -2);
  check('负向平移截断', eq(sh2[0], cells[2]) && eq(sh2[1], cells[3]) && sh2[2].every(v => !v));
  // 平移超出末尾：全部丢弃
  const sh3 = DC.shiftRange(cells, 14, 15, 10);
  check('平移出界丢弃', sh3[14].every(v => !v) && sh3[15].every(v => !v));
  // 清空
  const cl = DC.clearRange(cells, 2, 4);
  check('清空纬段', cl[2].every(v => !v) && cl[4].every(v => !v) && eq(cl[5], cells[5]));
  // 区间自动交换与钳制
  check('区间自动交换', eq(DC.mirrorRange(cells, 3, 0)[0], cells[3]));
}

/* ---------------- 升综组合与踏板还原 ---------------- */
{
  const d = Engine.defaultDraft();
  const cells = DC.cellsFromDraft(d);
  const combos = DC.liftCombos(cells);
  check('2/2 斜纹 → 4 种组合', combos.length === 4, combos.length);
  check('组合按首现顺序', combos[0].first === 0 && combos[1].first === 1);
  check('组合频次 4', combos.every(c => c.count === 4));
  check('组合涉及纬次', eq(combos[0].picks, [0, 4, 8, 12]), combos[0].picks);
  check('组合升综内容', eq(combos[0].shafts, [0, 1]));

  // 全保留：还原零差异
  const keep = DC.defaultKeep(combos, 4);
  check('组合 ≤ 踏板全保留', keep.size === 4);
  const red = DC.reduceToTreadles(cells, combos, DC.keptOrder(combos, keep), 4);
  check('还原 4 踏板无舍弃纬', red.treadles === 4 && red.dropped.length === 0);
  check('treadling 逐纬映射', eq(red.treadling, [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]), red.treadling);
  check('tieup 内容正确', eq(red.tieup[0], [true, false, false, true]) &&
    eq(red.tieup[1], [true, true, false, false]), red.tieup);

  const { draft: nd, reduction } = DC.applyReduction(Engine, d, cells, combos, DC.keptOrder(combos, keep));
  check('新草稿踏板数 4', nd.treadles === 4);
  check('新草稿升综计划保留但停用', nd.dobby && nd.dobby.enabled === false);
  const liftDer = DC.weaveWithCells(Engine, d, cells);
  const diff0 = DC.diffDrawdowns(liftDer.drawdown, Engine.derive(nd).drawdown);
  check('全保留还原组织零差异', diff0.count === 0, diff0.count);
  check('原草稿未被改动', d.treadles === 4 && d.treadling[0] === 0 && d.dobby.enabled === false);

  // 超限取舍：4 组合 2 踏板 → 同频按首现取前 2，舍 8 纬
  const keep2 = DC.defaultKeep(combos, 2);
  check('超限默认按频次取前 2', keep2.size === 2);
  const red2 = DC.reduceToTreadles(cells, combos, DC.keptOrder(combos, keep2), 4);
  check('舍弃纬列出', red2.dropped.length === 8 && eq(red2.dropped, [2, 3, 6, 7, 10, 11, 14, 15]), red2.dropped);
  check('舍弃纬 treadling 为 -1', red2.treadling[2] === -1 && red2.treadling[0] === 0);
  const diff2 = DC.diffDrawdowns(liftDer.drawdown,
    Engine.derive(DC.applyReduction(Engine, d, cells, combos, DC.keptOrder(combos, keep2)).draft).drawdown);
  check('超限还原差异涉及 8 纬', diff2.picks.length === 8 && diff2.count === 8 * 16, diff2.count);

  // 频次排序：高频组合优先保留
  const cellsF = [
    [true, false], [true, false], [true, false],
    [false, true],
    [true, true], [true, true],
  ];
  const combosF = DC.liftCombos(cellsF);
  const keepF = DC.defaultKeep(combosF, 2);
  check('频次优先：保留 ×3 与 ×2 组合', keepF.has(0) && keepF.has(2) && !keepF.has(1),
    combosF.map(c => c.count));
}

/* ---------------- 差异比较 ---------------- */
{
  const a = [[1, 0], [0, 1]];
  const b = [[1, 1], [0, 1]];
  const diff = DC.diffDrawdowns(a, b);
  check('差异计数', diff.count === 1);
  check('差异定位到纬', diff.picks.length === 1 && diff.picks[0].pick === 0 && diff.picks[0].diffs === 1);
  check('差异网格', eq(diff.grid, [[false, true], [false, false]]), diff.grid);
  check('null 与 0 视为差异', DC.diffDrawdowns([[null]], [[0]]).count === 1);
  check('相同矩阵零差异', DC.diffDrawdowns(a, a).count === 0);
}

/* ---------------- 随草稿保存的字段 ---------------- */
{
  const d = Engine.defaultDraft();
  check('默认草稿带 dobby 字段', d.dobby && d.dobby.cells.length === 16 && d.dobby.cells[0].length === 4);
  const c = Engine.cloneDraft(d);
  c.dobby.cells[0][0] = true;
  check('cloneDraft 深拷贝升综矩阵', d.dobby.cells[0][0] === false && c.dobby.cells[0][0] === true);
  const r = Engine.resize(d, { shafts: 6, treadles: 4, ends: 16, picks: 20 });
  check('resize 矩阵扩为 20×6', r.dobby.cells.length === 20 && r.dobby.cells[0].length === 6);
  check('resize 新增格为落下', r.dobby.cells[19].every(v => !v) && r.dobby.cells[0][4] === false);
  const r2 = Engine.resize(d, { shafts: 2, treadles: 4, ends: 16, picks: 8 });
  check('resize 缩小截断为 8×2', r2.dobby.cells.length === 8 && r2.dobby.cells[0].length === 2);
  // JSON 序列化（随草稿保存到 SQLite 的形态）
  const round = JSON.parse(JSON.stringify(d));
  check('升综计划可 JSON 序列化', round.dobby.cells.length === 16 &&
    Engine.normalizeDobby(round.dobby, 16, 4).cells.length === 16);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
