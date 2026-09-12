/**
 * 双层织物校核 — 纯逻辑核心测试（double-core.js + engine.js double 部分）
 *  配置规整 / 旧草稿补齐 / 分层模型 / 层间次序颠倒 / 接结越区 /
 *  折边断点 / 筒体未闭合 / 分层浮线 / 修复搜索（锁穿综·锁纬·锁格）/
 *  候选排序 / 差异叠色 / 草稿 patch
 */
const path = require('path');
const { Engine } = require(path.join(__dirname, '..', 'static', 'engine.js'));
const { DoubleCore: DC } = require(path.join(__dirname, '..', 'static', 'double-core.js'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS -', name); }
  else { fail++; console.log('FAIL -', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 构造经典双层平纹样稿（8 经 8 纬，8 综 4 踏）：
 *  经 1-4 上层（穿综 0/1 交替），经 5-8 下层（穿综 4/5 交替）；
 *  踏 1=上层平纹A 踏 2=下层平纹A(上层经全升) 踏 3=上层平纹B 踏 4=下层平纹B(上层经全升)；
 *  踩踏 上,下,上,下,… 构成筒织螺旋。
 */
function doubleSample() {
  const d = Engine.blankDraft(8, 4, 8, 8);
  d.threading = [0, 1, 0, 1, 4, 5, 4, 5];
  d.tieup = [
    [1, 0, 1, 1], // s0 上层经：下纬(t1,t3)时浮起
    [0, 1, 1, 1], // s1
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 1, 0, 0], // s4 下层经：仅下纬 t1 升
    [0, 0, 0, 1], // s5：仅下纬 t3 升
    [0, 1, 0, 0],
    [0, 0, 0, 1],
  ];
  d.treadling = [0, 1, 2, 3, 0, 1, 2, 3];
  d.double = Engine.normalizeDouble({
    enabled: true,
    warpLayer: [0, 0, 0, 0, 1, 1, 1, 1],
    pickLayer: [0, 1, 0, 1, 0, 1, 0, 1],
    zones: [],
    structure: 'tube',
    foldSide: 'L',
  }, 8, 8);
  return d;
}

/* ---------------- 配置规整 ---------------- */
{
  const n = Engine.normalizeDouble(null, 8, 6);
  check('缺省停用', n.enabled === false);
  check('缺省经均分（前半上）', eq(n.warpLayer, [0, 0, 0, 0, 1, 1, 1, 1]));
  check('缺省纬均分', eq(n.pickLayer, [0, 0, 0, 1, 1, 1]));
  check('缺省敞开 / 左折', n.structure === 'open' && n.foldSide === 'L');
  check('缺省无接结区无锁格', n.zones.length === 0 && n.lockedCells.length === 0);

  // 旧草稿（无 double）经 normalizeDraft 补齐后可直接打开
  const old = Engine.defaultDraft();
  delete old.double;
  const d2 = Engine.blankDraft(1, 1, 1, 1);
  const merged = { ...d2, ...old };
  merged.double = Engine.normalizeDouble(old.double, old.ends, old.picks);
  check('旧草稿补齐 16×16 双层配置', merged.double.warpLayer.length === 16 &&
    merged.double.pickLayer.length === 16 && merged.double.enabled === false);

  // 残缺数据：越界矩形钳制/交换、非法结构兜底、锁格去重排序
  const r = Engine.normalizeDouble({
    enabled: 1, structure: 'weird', foldSide: 'RR',
    warpLayer: [1, 'x', 0], pickLayer: [1],
    zones: [[99, 99, 2, 2], [0, 0, 1, 1], [0, 0, 1, 1]],
    lockedCells: [[3, 1], [0, 0], [3, 1], [99, 99]],
  }, 4, 4);
  check('残缺：非法结构兜底 open', r.structure === 'open');
  check('残缺：非法折边兜底 L', r.foldSide === 'L');
  check('残缺：经层真值化、缺省按均分', eq(r.warpLayer, [1, 0, 0, 1]));
  check('残缺：纬层补齐', eq(r.pickLayer, [1, 1, 0, 1]));
  check('残缺：越界矩形钳制并交换', eq(r.zones[0], [2, 2, 3, 3]), r.zones);
  check('残缺：重复矩形去重', r.zones.length === 2);
  check('残缺：锁格去重排序、越界丢弃', eq(r.lockedCells, [[0, 0], [3, 1]]), r.lockedCells);
}

/* ---------------- 分层模型：正确双层组织无越序 ---------------- */
{
  const d = doubleSample();
  const m = DC.buildModel(d);
  const cross = [];
  for (let p = 0; p < 8; p++)
    for (let e = 0; e < 8; e++)
      if (m.grid[p][e].cross) cross.push(m.grid[p][e]);
  check('正确双层：跨层格全部符合层间次序', cross.every(c => !c.wrong));
  check('正确双层：无 error', m.errors === 0, m.issues.map(i => i.msg));
  // 筒织无接结区只给“无接结”警告
  check('正确双层：仅无接结/分离类警告', m.warns <= 1 && m.issues.every(i =>
    ['dl-tube-no-stitch', 'dl-no-stitch'].includes(i.code)));
  check('上下层视图尺寸', m.topGrid[0].length === 4 && m.bottomGrid[0].length === 4 &&
    m.topGrid.length === 8 && m.bottomGrid.length === 8);
  check('上层纬只含上层纬次', eq(m.topPicks, [0, 2, 4, 6]));
  check('梭路径：筒织入梭边随层交替',
    m.path.enters[0] === 'L' && m.path.enters[1] === 'R' && m.path.enters[2] === 'L');
  check('梭路径：筒织两侧折返', m.path.turnAt[0] === 'R' && m.path.turnAt[1] === 'L');
}

/* ---------------- 层间次序颠倒 ---------------- */
{
  const d = doubleSample();
  // 第 2 纬（下纬）由踏 2(=t1，下层平纹A) 改为踏 4(=t3，下层平纹B)：
  // 下层经 4,6 升起而 5,7 沉；同时检查反向——改用踏 1（上纬踏板）使上层经沉
  d.treadling[1] = 0;   // 下纬踩了上层踏板 1：上层经状态像“下纬”，下层经全沉
  const m = DC.buildModel(d);
  const order = m.issues.find(i => i.code === 'dl-stitch-out' || i.code === 'dl-layer-order');
  check('下纬踩上纬踏板 → 检出层间问题', !!order, m.issues.map(i => i.code));
  check('问题定位到合并表面格', order.loc.every(l => l.grid === 'dl-merged'));
  check('追溯信息含经/纬/综框/升综', order.trace.every(t =>
    Number.isInteger(t.end) && Number.isInteger(t.pick) &&
    Number.isInteger(t.shaft) && typeof t.lifted === 'boolean'));

  // 整幅层序对调：把第 1 纬所有异层经方向弄反（tieup 极端错误）
  const d2 = doubleSample();
  d2.tieup[0][3] = 0; d2.tieup[1][3] = 0;  // 削弱 t4：先造局部不够；再造整纬颠倒
  const d3 = doubleSample();
  // 让第 1 纬(t0 上纬) 的全部下层经升起 = 全部跨层反向：t0 列加上 s4..s7
  for (let s = 4; s < 8; s++) d3.tieup[s][0] = 1;
  const m3 = DC.buildModel(d3);
  const lay = m3.issues.filter(i => i.code === 'dl-layer-order');
  check('整纬异层经全反向 → dl-layer-order', lay.some(i => /第 1 纬/.test(i.msg)),
    m3.issues.map(i => i.code));
}

/* ---------------- 接结越区与合规接结 ---------------- */
{
  const d = doubleSample();
  // 在第 1 纬（上纬）让第 5 根经（下层经，综4）升起：正常应沉。圈到区内=接结，区外=越区
  d.tieup[4][0] = 1;
  const mOut = DC.buildModel(d);
  check('区外反向跨层 → dl-stitch-out', mOut.issues.some(i => i.code === 'dl-stitch-out'));
  check('无合规接结点', mOut.stitches.length === 0);

  // 同一格圈入接结区：变成合规接结
  d.double.zones = [[0, 4, 0, 4]];
  const mIn = DC.buildModel(d);
  check('区内反向跨层为合规接结（不报越区）',
    !mIn.issues.some(i => i.code === 'dl-stitch-out' || i.code === 'dl-stitch-reverse'));
  check('合规接结点计入', mIn.stitches.length >= 1 &&
    mIn.stitches.some(s => s.pick === 0 && s.end === 4));
  check('合规接结合并表面着色为 stitch', mIn.merged[0][4] === 'stitch');

  // 区内跨层即用户许可的接结（方向不限）：不报错（敞开结构避免折/筒检查干扰）
  const d2 = doubleSample();
  d2.double.structure = 'open';
  d2.double.zones = [[1, 0, 1, 0]];
  d2.tieup[0][1] = 0;  // t2（下纬）时 s0 不升：区内上层经沉于下纬＝接结
  const mRev = DC.buildModel(d2);
  check('区内跨层方向不限，视为接结',
    !mRev.issues.some(i => i.code === 'dl-stitch-out' || i.code === 'dl-stitch-reverse') &&
    mRev.stitches.some(s => s.pick === 1 && s.end === 0));
}

/* ---------------- 折边断点（单侧折叠） ---------------- */
{
  const d = doubleSample();
  d.double.structure = 'fold';
  d.double.foldSide = 'L';
  // 左折：最左经须属于该纬的层、相邻纬层交替。样稿纬交替且经1为上层，
  // 上纬时外侧经属上层正确；下纬(p=1)时外侧经仍为上层 → 折边断点
  const m = DC.buildModel(d);
  check('左折下纬外侧上层经 → dl-fold-break',
    m.issues.some(i => i.code === 'dl-fold-break'));
  check('左折上纬不报断点', !m.issues.some(i => i.code === 'dl-fold-break' && /第 1 纬/.test(i.msg)));

  // 连续同层纬 → dl-fold-turn
  d.double.pickLayer = [0, 0, 1, 1, 0, 1, 0, 1];
  const m2 = DC.buildModel(d);
  check('连续同层纬 → dl-fold-turn', m2.issues.some(i => i.code === 'dl-fold-turn'));

  // 右折使用最右经
  const d3 = doubleSample();
  d3.double.structure = 'fold';
  d3.double.foldSide = 'R';
  const m3 = DC.buildModel(d3);
  check('右折检查最右经', m3.issues.some(i => i.code === 'dl-fold-break' &&
    i.loc.some(l => l.c === 7)));
}

/* ---------------- 筒体未闭合 ---------------- */
{
  const d = doubleSample();
  d.double.structure = 'tube';
  d.double.pickLayer = [0, 1, 0, 0, 1, 0, 1, 0]; // 第 3、4 纬同为上层
  const m = DC.buildModel(d);
  const open = m.issues.filter(i => i.code === 'dl-tube-open');
  check('层序未交替 → dl-tube-open', open.length >= 1);
  check('筒体问题定位两侧布边', open[0].loc.every(l => l.c === 0 || l.c === 7));

  const d2 = doubleSample();
  check('交替层序筒体闭合', !DC.buildModel(d2).issues.some(i => i.code === 'dl-tube-open'));
}

/* ---------------- 分层完整性 / 分层浮线 ---------------- */
{
  const d = doubleSample();
  d.double.pickLayer = new Array(8).fill(0);
  const m = DC.buildModel(d);
  check('下层无纬 → dl-empty-pick 警告', m.issues.some(i => i.code === 'dl-empty-pick'));

  const d2 = doubleSample();
  const fl = DC.buildModel(d2).floats;
  check('分层浮线为有限值',
    fl.top.warp.max >= 1 && fl.bottom.weft.max >= 1);
}

/* ---------------- 截面与追溯 ---------------- */
{
  const d = doubleSample();
  const m = DC.buildModel(d);
  const sec = DC.sectionAt(d, m, 1);
  check('截面：第 2 纬走下层槽道', sec.lane === 1 && sec.warps.length === 8);
  check('截面：入梭右、折返左边', sec.enter === 'R' && sec.exit === 'L' && sec.turnAt === 'L');
  check('截面经点带综框号', sec.warps[0].shaft === 0 && sec.warps[4].shaft === 4);
}

/* ---------------- 修复搜索：只改联结/踩踏/升综 ---------------- */
{
  // 制造可由换踏板修复的错误：下纬踩错踏板
  const d = doubleSample();
  d.treadling[1] = 0;
  const cands = DC.searchFixes(d);
  check('搜索返回候选（含基线）', cands.length >= 2);
  check('基线零改动', cands[0].key === 'base' && cands[0].changes === 0);
  const best = cands.find(c => c.key !== 'base');
  check('候选能把错误数降到基线以下', best && best.errors < cands[0].errors,
    cands.map(c => [c.key.slice(0, 20), c.errors, c.changes]));
  check('候选 patch 只含 treadling/tieup（不改穿综）',
    best.patch.mode === 'treadle' &&
    JSON.stringify(best.patch).indexOf('threading') === -1);
  const nd = DC.candidateDraft(d, best.patch);
  check('采纳返回新草稿且原稿不改', nd !== d && d.treadling[1] === 0);
  check('新草稿双层配置保留', nd.double.enabled === true);
  const diff = DC.diffGrid(d, best.patch);
  check('差异网格非空', diff.count > 0);

  // 已织纬锁定：锁定纬的踏板不得被候选改回
  d.shuttles.locked[1] = true;
  const cands2 = DC.searchFixes(d);
  check('锁定纬后：候选 patch 不动第 2 纬',
    cands2.filter(c => c.key !== 'base').every(c => c.patch.treadling[1] === d.treadling[1]));

  // 指定组织格锁定：搜索后该格交织值必须不变
  const d3 = doubleSample();
  d3.treadling[1] = 0;
  d3.double.lockedCells = [[1, 4]];
  const c3 = DC.searchFixes(d3).find(c => c.key !== 'base');
  if (c3) {
    const nd3 = DC.candidateDraft(d3, c3.patch);
    const before = DC.cellValue(d3, DC.liftModel(d3), 1, 4);
    const after = DC.cellValue(nd3, DC.liftModel(nd3), 1, 4);
    check('锁定组织格交织值不变', before === after, { before, after });
  } else {
    check('锁定组织格交织值不变（无候选）', true);
  }
}

/* ---------------- 多臂升综模式下的搜索 ---------------- */
{
  const d = doubleSample();
  // 转成 dobby 驱动：从当前方案生成升综矩阵并启用
  const { DobbyCore: DBC } = require(path.join(__dirname, '..', 'static', 'dobby-core.js'));
  const cells = DBC.cellsFromDraft(d);
  d.dobby = Engine.normalizeDobby({ enabled: true, cells }, 8, 8);
  // 破坏第 2 纬：下层经综 4,6 应为升（接结顺序需要），改成落下
  cells[1][4] = false; cells[1][6] = false;
  d.dobby.cells = cells;
  const m0 = DC.buildModel(d);
  check('升综破坏后有层间错误', m0.errors > 0, m0.issues.map(i => i.code));
  const cands = DC.searchFixes(d);
  const best = cands.find(c => c.key !== 'base');
  check('升综候选为 dobby patch', best && best.patch.mode === 'dobby');
  check('升综候选只改第 2 纬行', best && Object.keys(best.patch.rows).join() === '1',
    best && Object.keys(best.patch.rows));
  check('升综候选降低错误数', best && best.errors < cands[0].errors);
}

/* ---------------- 候选排序：错误数 → 改动格数 → 最长浮线 ---------------- */
{
  const d = doubleSample();
  d.treadling[1] = 0;
  const cands = DC.searchFixes(d);
  const sorted = cands.every((c, i) => i === 0 ||
    c.errors > cands[i - 1].errors ||
    (c.errors === cands[i - 1].errors && c.changes >= cands[i - 1].changes) ||
    (c.errors === cands[i - 1].errors && c.changes === cands[i - 1].changes &&
      c.maxFloat >= cands[i - 1].maxFloat));
  check('候选按错误数/改动/浮线升序', sorted);
}

/* ---------------- resize / clone 携带双层配置 ---------------- */
{
  const d = doubleSample();
  d.double.zones = [[0, 0, 2, 2]];
  const r = Engine.resize(d, { shafts: 8, treadles: 4, ends: 12, picks: 10 });
  check('resize 后分层带扩展', r.double.warpLayer.length === 12 && r.double.pickLayer.length === 10);
  check('resize 后接结区保留并钳制', eq(r.double.zones[0], [0, 0, 2, 2]));
  const c = Engine.cloneDraft(d);
  c.double.zones[0][0] = 5;
  check('clone 深拷贝接结区', d.double.zones[0][0] === 0);
}

/* ---------------- 停用不影响单层 ---------------- */
{
  const d = doubleSample();
  d.double.enabled = false;
  const m = DC.buildModel(d);
  check('停用时无双层问题', m.issues.length === 0 && m.errors === 0);
}

console.log(`\n${fail ? 'RESULT: FAIL (' + fail + ')' : 'RESULT: ALL PASS'} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
