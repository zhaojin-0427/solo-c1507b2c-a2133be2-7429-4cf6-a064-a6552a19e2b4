/* =====================================================================
 * double-core.js — 双层织物校核：纯逻辑核心（不依赖 DOM）
 *
 * 配置 draft.double（Engine.normalizeDouble 规整）：
 *   enabled      是否启用双层校核（停用不影响单层推导）
 *   warpLayer    [ends]  0=上层经 1=下层经
 *   pickLayer    [picks] 0=上层纬 1=下层纬
 *   zones        允许接结区矩形 [r0,c0,r1,c1]（组织图，0 基闭区间）
 *   structure    'open' 双幅敞开 | 'fold' 单侧折叠 | 'tube' 筒织
 *   foldSide     'L' | 'R' 折边方向（fold 时生效；tube 两侧皆折）
 *   lockedCells  指定锁定的组织格 [r,c]
 * 另：锁定穿综取 draft 主应用锁（lockThreading），已织纬锁取 draft.shuttles.locked。
 *
 * 分层交织规则（同一套穿综·升综，按层分离）：
 *   上层纬：上层经须与该纬交织，下层经全程沉在该纬下（仅允许在接结区内接结）；
 *   下层纬：下层经须与该纬交织，上层经全程浮在该纬上（仅允许在接结区内接结）。
 * 升综=经在上；接结＝跨层交织，且只允许发生在圈出的接结区内。
 *
 * issue 定位 loc：{ grid:'dl-merged'|'dl-top'|'dl-bottom'|'dl-config', r, c }
 * 追溯信息 trace：{ end, pick, shaft, lifted, layer:'warp'|'pick', layerName }
 * ===================================================================== */
'use strict';

const DoubleCore = (() => {

  const STRUCT_NAMES = { open: '双幅敞开', fold: '单侧折叠', tube: '筒织' };
  const LAYER_NAMES = ['上层', '下层'];

  function clampInt(v, lo, hi, dflt) {
    v = parseInt(v, 10);
    if (!Number.isFinite(v)) return dflt;
    return Math.max(lo, Math.min(hi, v));
  }

  /** 确保草稿带有规整过的双层配置（不进历史）；返回 double 配置对象。 */
  function ensure(draft) {
    if (!draft.double) draft.double = normalize(draft, null);
    return draft.double;
  }

  function getEngine() {
    if (typeof Engine !== 'undefined') return Engine;
    if (typeof window !== 'undefined' && window.Engine) return window.Engine;
    return null;
  }

  function normalize(draft, dl) {
    // 延迟取 Engine，保持本模块在纯 node 测试中可与 engine.js 组合
    const E = getEngine();
    if (!E) throw new Error('DoubleCore 需要 Engine');
    return E.normalizeDouble(dl, draft.ends, draft.picks);
  }

  /* ------------------------------- 升综模型 ----------------------------- */
  /**
   * 逐纬升综集合，统一 踏板联结 与 多臂升综矩阵 两种驱动：
   * 返回 { dobbyOn, liftSets:[Set<shaft>], valid:[bool], treadle:[int] }
   */
  function liftModel(d) {
    const dobbyOn = !!(d.dobby && d.dobby.enabled && Array.isArray(d.dobby.cells));
    const liftSets = [], valid = [], treadles = [];
    for (let p = 0; p < d.picks; p++) {
      const set = new Set();
      let ok = true;
      let treadle = -1;
      if (dobbyOn) {
        const row = d.dobby.cells[p] || [];
        for (let s = 0; s < d.shafts; s++) if (row[s]) set.add(s);
      } else {
        const t = d.treadling[p];
        treadle = t;
        if (t < 0 || t >= d.treadles) ok = false;
        else {
          for (let s = 0; s < d.shafts; s++) {
            if (d.tieup[s] && d.tieup[s][t]) set.add(s);
          }
          if (set.size === 0) ok = false;
        }
      }
      liftSets.push(set); valid.push(ok); treadles.push(treadle);
    }
    return { dobbyOn, liftSets, valid, treadles: treadles };
  }

  /** 格 (p,e) 的交织值：1 经在上 / 0 纬在上 / null 缺失（与 Engine.derive 同口径）。 */
  function cellValue(d, lm, p, e) {
    const s = d.threading[e];
    if (!lm.valid[p] || s < 0 || s >= d.shafts) return null;
    return lm.liftSets[p].has(s) ? 1 : 0;
  }

  const inZone = (dl, p, e) =>
    dl.zones.some(([r0, c0, r1, c1]) => p >= r0 && p <= r1 && e >= c0 && e <= c1);

  const isLockedCell = (dl, p, e) =>
    dl.lockedCells.some(([r, c]) => r === p && c === e);

  /** 折边外侧经序号（foldSide='L' 取最左，'R' 取最右）。 */
  function foldOuterEnd(d, dl) {
    return dl.foldSide === 'R' ? d.ends - 1 : 0;
  }

  /* ------------------------------- 校核模型 ----------------------------- */
  /**
   * 构建双层校核模型：
   * {
   *   dobbyOn, lm,
   *   grid: [p][e] { v, wl, pl, same, stitch, cross, expect, wrong, missing, locked,
   *                  trace:{end,pick,shaft,lifted} },
   *   topGrid / bottomGrid   各层压缩组织（1 经在上 0 纬在上 null 非本层）
   *   merged: [p][e] 颜色键 'warp-top'|'weft-top'|'warp-bottom'|'weft-bottom'|
   *                        'stitch'|'wrong'|'null'
   *   stitches:[{pick,end,dir}]  合规接结
   *   floats: { top:{warp,weft}, bottom:{warp,weft} }  分层浮线（含 runs）
   *   issues: [{ level, code, msg, loc:[...], trace? }]
   *   errors, warns,
   *   path: { enters:[p]=>'L'|'R', exits }  逐纬梭路径（折/筒在两层间转向）
   * }
   */
  function buildModel(d) {
    const dl = ensure(d);
    const E = d.ends, P = d.picks;
    const lm = liftModel(d);
    const dobbyOn = lm.dobbyOn;
    const wl = (e) => dl.warpLayer[e] ? 1 : 0;
    const pl = (p) => dl.pickLayer[p] ? 1 : 0;

    const grid = [];
    const stitches = [];
    const topGrid = [], bottomGrid = [], merged = [];

    const topEnds = [], bottomEnds = [], topPicks = [], bottomPicks = [];
    for (let e = 0; e < E; e++) (dl.warpLayer[e] ? bottomEnds : topEnds).push(e);
    for (let p = 0; p < P; p++) (dl.pickLayer[p] ? bottomPicks : topPicks).push(p);

    for (let p = 0; p < P; p++) {
      const grow = [], trow = [], brow = [], mrow = [];
      const layerPick = pl(p);
      for (let e = 0; e < E; e++) {
        const v = cellValue(d, lm, p, e);
        const warpLay = wl(e);
        const same = warpLay === layerPick;
        // 跨层格的“分离正确”顺序：上层纬时下层经应沉（v=0）；下层纬时上层经应浮（v=1）
        const expect = layerPick === 0 ? 0 : 1;
        const cross = !same;
        const zoned = cross && inZone(dl, p, e);
        // 接结＝接结区内用户许可的跨层交织（上下接结方向皆可，区本身即许可）
        const stitch = zoned && v !== null;
        // 越序＝区外跨层且方向与分离要求相反
        const wrong = cross && v !== null && v !== expect && !zoned;
        const missing = v === null;
        const shaft = d.threading[e];
        const cell = {
          v, wl: warpLay, pl: layerPick, same, cross, expect,
          stitch, wrong, missing, zoned,
          locked: isLockedCell(dl, p, e),
          inZone: zoned,
          trace: {
            end: e, pick: p, shaft: (shaft >= 0 && shaft < d.shafts) ? shaft : -1,
            lifted: v === 1, warpLayer: warpLay, pickLayer: layerPick,
            treadle: lm.treadles[p], dobbyOn,
          },
        };
        grow.push(cell);
        if (stitch) stitches.push({ pick: p, end: e, dir: expect });

        if (dl.warpLayer[e] === 0) trow.push(v);
        if (dl.warpLayer[e] === 1) brow.push(v);
        // 合并表面：同层交织见纱色（此处给键，UI 配色）；跨层按合规接结 / 越序着色
        if (missing) mrow.push('null');
        else if (same) {
          mrow.push(layerPick === 0
            ? (v === 1 ? 'warp-top' : 'weft-top')
            : (v === 1 ? 'warp-bottom' : 'weft-bottom'));
        } else if (wrong) mrow.push('wrong');
        else mrow.push(cell.zoned ? 'stitch' : 'wrong');
      }
      grid.push(grow);
      topGrid.push(trow); bottomGrid.push(brow); merged.push(mrow);
    }

    const model = {
      dl, dobbyOn, lm, grid, stitches,
      topGrid, bottomGrid, merged,
      topEnds, bottomEnds, topPicks, bottomPicks,
      issues: [],
    };
    model.floats = layerFloats(model, d);
    model.path = shuttlePath(d, dl, model);
    validate(model, d);
    model.errors = model.issues.filter(i => i.level === 'error').length;
    model.warns = model.issues.length - model.errors;
    return model;
  }

  /* ------------------------------- 分层浮线 ----------------------------- */
  /**
   * 分层浮线：仅在该层经 × 该层纬 的压缩组织上测量（非本层纬视为截断）。
   * 返回 { top:{warp,weft}, bottom:{warp,weft} }，每侧 { max, runs }。
   */
  function layerFloats(model, d) {
    const dl = model.dl;
    const measure = (ends, picks) => {
      const nE = ends.length, nP = picks.length;
      const at = (p, e) => {
        const gp = picks[p], ge = ends[e];
        return model.grid[gp][ge].v;
      };
      // 经浮：每根层经沿该层纬扫描 v===1；纬浮：每根层纬沿该层经扫描 v===0
      let maxWarp = 0, maxWeft = 0;
      const warpRuns = [], weftRuns = [];
      for (let e = 0; e < nE; e++) {
        let run = 0, start = -1;
        for (let p = 0; p <= nP; p++) {
          const on = p < nP && at(p, e) === 1;
          if (on) { if (!run) start = p; run++; }
          else if (run) {
            if (run > maxWarp) maxWarp = run;
            warpRuns.push({ end: ends[e], start: picks[start], length: run });
            run = 0;
          }
        }
      }
      for (let p = 0; p < nP; p++) {
        let run = 0, start = -1;
        for (let e = 0; e <= nE; e++) {
          const on = e < nE && at(p, e) === 0;
          if (on) { if (!run) start = e; run++; }
          else if (run) {
            if (run > maxWeft) maxWeft = run;
            weftRuns.push({ pick: picks[p], start: ends[start], length: run });
            run = 0;
          }
        }
      }
      return { warp: { max: maxWarp, runs: warpRuns }, weft: { max: maxWeft, runs: weftRuns } };
    };
    return {
      top: measure(model.topEnds, model.topPicks),
      bottom: measure(model.bottomEnds, model.bottomPicks),
    };
  }

  /* ------------------------------- 梭路径 ------------------------------- */
  /**
   * 逐纬梭路径（用于播放时画梭线在两层之间的走向）：
   *   open：无折返，全部入梭边统一从左（同多梭计划未指定时的主图板口径）；
   *   fold：上/下层纬分别在折边外侧转向，入梭边随层交替（上层从折边对侧入，
   *         折边处 U 形回折；同层连续纬之间无折返＝折边断点之一）；
   *   tube：两侧皆折，入梭边与层同时交替（螺旋筒）。
   * 返回 { enters:[p] 'L'|'R', turnAt:[p] 'L'|'R'|null }
   */
  function shuttlePath(d, dl, model) {
    const P = d.picks;
    const enters = new Array(P).fill('L');
    const turnAt = new Array(P).fill(null);
    if (!dl.enabled) return { enters, turnAt, active: false };
    for (let p = 0; p < P; p++) {
      const lay = dl.pickLayer[p] ? 1 : 0;
      if (dl.structure === 'open') {
        enters[p] = 'L';
      } else if (dl.structure === 'fold') {
        // 上层纬从折边对侧入、在折边侧回；下层纬反之（连续纬纱转向）
        enters[p] = (lay === 0)
          ? (dl.foldSide === 'R' ? 'L' : 'R')
          : dl.foldSide;
        turnAt[p] = dl.foldSide;
      } else { // tube：螺旋，层与边同时交替
        enters[p] = lay === 0 ? 'L' : 'R';
        turnAt[p] = enters[p] === 'L' ? 'R' : 'L';
      }
    }
    return { enters, turnAt, active: true };
  }

  /* ------------------------------- 校核 --------------------------------- */
  function validate(model, d) {
    const dl = model.dl;
    const E = d.ends, P = d.picks;
    const issues = model.issues;
    const locGrid = (p, e) => ({ grid: 'dl-merged', r: p, c: e });
    const push = (level, code, msg, loc, trace) =>
      issues.push({ level, code, msg, loc, trace: trace || null });

    if (!dl.enabled) return;

    // 0) 分层完整性：两层都须有经、有纬
    if (!model.topEnds.length || !model.bottomEnds.length) {
      const empty = !model.topEnds.length ? '上层' : '下层';
      push('warn', 'dl-empty-warp', `${empty}没有分配经线：双层校核需要两层都有经`,
        [{ grid: 'dl-config', r: -1, c: -1 }]);
    }
    if (!model.topPicks.length || !model.bottomPicks.length) {
      const empty = !model.topPicks.length ? '上层' : '下层';
      push('warn', 'dl-empty-pick', `${empty}没有分配纬次：双层校核需要两层都有纬`,
        [{ grid: 'dl-config', r: -1, c: -1 }]);
    }

    // 1) 层间次序颠倒 / 接结越区（逐纬分组；区内跨层＝许可接结，不报错）
    for (let p = 0; p < P; p++) {
      const lay = dl.pickLayer[p] ? 1 : 0;
      const cross = [], wrongOut = [];
      for (let e = 0; e < E; e++) {
        const cell = model.grid[p][e];
        if (!cell.cross) continue;
        cross.push(cell);
        if (cell.wrong) wrongOut.push(cell);
      }
      if (!cross.length) continue;
      const ratio = wrongOut.length / cross.length;
      if (wrongOut.length >= 2 && ratio >= 0.6) {
        // 整纬层间次序颠倒
        push('error', 'dl-layer-order',
          `第 ${p + 1} 纬（${LAYER_NAMES[lay]}纬）层间次序颠倒：${cross.length} 根异层经` +
          `中 ${wrongOut.length} 根在接结区外反向跨层，上下层疑似整体对调`,
          wrongOut.map(c => locGrid(p, c.trace.end)),
          wrongOut.map(c => c.trace));
      } else if (wrongOut.length) {
        push('error', 'dl-stitch-out',
          `第 ${p + 1} 纬（${LAYER_NAMES[lay]}纬）有 ${wrongOut.length} 根异层经在接结区外跨层交织` +
          `（接结越区），异层经共 ${cross.length} 根`,
          wrongOut.map(c => locGrid(p, c.trace.end)),
          wrongOut.map(c => c.trace));
      }
    }

    // 2) 同层未交织（该层经在该层所有纬上全浮或全沉）——层内组织基本健康
    for (const [layerName, ends, picks] of
      [['上层', model.topEnds, model.topPicks], ['下层', model.bottomEnds, model.bottomPicks]]) {
      if (!ends.length || !picks.length) continue;
      for (const e of ends) {
        let up = 0, down = 0, nulls = 0;
        for (const p of picks) {
          const v = model.grid[p][e].v;
          if (v === null) nulls++;
          else if (v === 1) up++; else down++;
        }
        if (nulls === 0 && up + down > 0 && (up === 0 || down === 0)) {
          push('error', 'dl-no-interlace',
            `${layerName}第 ${e + 1} 根经在${layerName}纬中全程${up === 0 ? '沉于纬下' : '浮于纬上'}，未交织`,
            picks.map(p => locGrid(p, e)),
            picks.map(p => model.grid[p][e].trace));
        }
      }
    }

    // 3) 折边断点（单侧折叠）
    if (dl.structure === 'fold' && E >= 2 && P >= 1) {
      const outer = foldOuterEnd(d, dl);
      const sideName = dl.foldSide === 'R' ? '右' : '左';
      for (let p = 0; p < P; p++) {
        const lay = dl.pickLayer[p] ? 1 : 0;
        const cell = model.grid[p][outer];
        // 折边外侧经必须属于该纬的层：否则纬纱无法在折边处连续折返
        if (!cell.missing && cell.wl !== lay) {
          push('error', 'dl-fold-break',
            `第 ${p + 1} 纬（${LAYER_NAMES[lay]}纬）折到${sideName}折边，但外侧第 ${outer + 1} 根经` +
            `属于${LAYER_NAMES[cell.wl]}：折边处纬纱断开（折边断点）`,
            [locGrid(p, outer)], [cell.trace]);
        }
        if (p > 0) {
          const prevLay = dl.pickLayer[p - 1] ? 1 : 0;
          if (prevLay === lay) {
            push('error', 'dl-fold-turn',
              `第 ${p}→${p + 1} 纬同为${LAYER_NAMES[lay]}纬，纬纱未在${sideName}折边折返到另一层`,
              [locGrid(p - 1, outer), locGrid(p, outer)],
              [model.grid[p - 1][outer].trace, model.grid[p][outer].trace]);
          }
        }
      }
    }

    // 4) 筒体未闭合（筒织：两侧皆折，层与入梭边必须逐纬交替螺旋）
    if (dl.structure === 'tube' && P >= 2) {
      const badTurns = [];
      for (let p = 1; p < P; p++) {
        if ((dl.pickLayer[p] ? 1 : 0) === (dl.pickLayer[p - 1] ? 1 : 0)) badTurns.push(p);
      }
      if (badTurns.length) {
        // 连续同层纬：筒体在该处无法螺旋闭合
        const groups = [];
        badTurns.forEach(p => {
          const g = groups[groups.length - 1];
          if (g && g[g.length - 1] === p - 1) g.push(p);
          else groups.push([p]);
        });
        groups.slice(0, 6).forEach(g => {
          const p0 = g[0], p1 = g[g.length - 1];
          push('error', 'dl-tube-open',
            `第 ${p0}→${p1 + 1} 纬层序未交替：筒织纬纱须上下层逐纬交替才能螺旋闭合，` +
            `此处筒体未闭合`,
            g.flatMap(p => [locGrid(p - 1, 0), locGrid(p, E - 1)]),
            g.flatMap(p => [model.grid[p - 1][0].trace, model.grid[p][E - 1].trace]));
        });
        if (groups.length > 6) {
          push('warn', 'dl-tube-open-more', `另有 ${groups.length - 6} 处筒体未闭合，从略`, []);
        }
      }
      if (!model.stitches.length && dl.zones.length === 0) {
        push('warn', 'dl-tube-no-stitch',
          '筒织未圈出接结区且无接结点：上下两层仅靠两侧折回相连，布面易分层错位',
          []);
      }
    }

    // 5) 敞开 / 折叠结构完全没有接结点（两层互不相连）——警告
    if (dl.structure !== 'tube' && !model.stitches.length &&
        model.topEnds.length && model.bottomEnds.length &&
        model.topPicks.length && model.bottomPicks.length) {
      push('warn', 'dl-no-stitch',
        '两层之间没有任何接结点：双幅布将完全分离（如需分离双幅可忽略此提示）',
        []);
    }
  }

  /* ------------------------------- 截面数据 ----------------------------- */
  /**
   * 逐纬截面（沿该纬方向切开）：
   * 返回 { pick, lane:0|1, enter, exit, turnAt,
   *         warps:[{ end, x, layer, up:bool, shaft, locked }] }
   * 绘制层由 UI 完成（保持核心不依赖 canvas）。lane 上下对应层槽位（0 上 1 下）。
   */
  function sectionAt(d, model, p) {
    const dl = model.dl;
    const lm = model.lm;
    const warps = [];
    for (let e = 0; e < d.ends; e++) {
      const cell = model.grid[p][e];
      const shaft = d.threading[e];
      warps.push({
        end: e, x: e, layer: dl.warpLayer[e], up: cell.v === 1,
        shaft: (shaft >= 0 && shaft < d.shafts) ? shaft : -1,
        cross: cell.cross, stitch: cell.stitch, wrong: cell.wrong,
        missing: cell.missing, locked: cell.locked,
      });
    }
    const path = model.path;
    return {
      pick: p, lane: dl.pickLayer[p] ? 1 : 0,
      enter: path.enters[p], exit: path.enters[p] === 'L' ? 'R' : 'L',
      turnAt: path.turnAt[p],
      warps,
    };
  }

  /* ------------------------------- 修改搜索 ----------------------------- */
  /**
   * 在不改动穿综、已织纬、指定锁定格的前提下，搜索只改动
   * 联结 / 踩踏 / 升综格的修复候选。
   *
   * 入参 locks：{ threading:bool, lockedPicks:[bool]P }（lockThreading 恒成立语义：
   *   本工具从不改穿综；已织纬取 shuttles.locked；组织格取 dl.lockedCells）
   *
   * 候选（按 错误数 → 改动格数 → 最长浮线 排序）：
   *   { key, patch, changes, errors, warns, maxFloat, model? }
   * patch：
   *   dobby 模式 { mode:'dobby', rows:{p:[bool S]} }
   *   踏板模式   { mode:'treadle', treadling:[p], tieup:[[S][T]]（完整新矩阵）, treadles:T }
   */
  function searchFixes(d, opts = {}) {
    const dl = ensure(d);
    const limit = opts.limit || 12;
    const maxCandidates = opts.maxCandidates || 40;
    const base = buildModel(d);
    const lm = base.lm;
    const lockedPicks = (d.shuttles && d.shuttles.locked)
      ? d.shuttles.locked.slice() : new Array(d.picks).fill(false);

    // 基线候选（不改）
    const candidates = [];
    const seen = new Set();
    const baseMaxFloat = Math.max(
      base.floats.top.warp.max, base.floats.top.weft.max,
      base.floats.bottom.warp.max, base.floats.bottom.weft.max);
    const basePatch = base.dobbyOn
      ? { mode: 'dobby', rows: {} }
      : { mode: 'treadle', treadling: d.treadling.slice(),
          tieup: d.tieup.map(r => r.slice()), treadles: d.treadles };
    candidates.push({
      key: 'base', patch: basePatch, changes: 0,
      errors: base.errors, warns: base.warns, maxFloat: baseMaxFloat,
    });
    seen.add('base');

    if (!dl.enabled) return rank(candidates).slice(0, limit);

    // 逐纬收集修复要求（只在存在区外越序、且未锁定的纬上搜索）
    const requirements = [];
    for (let p = 0; p < d.picks; p++) {
      if (lockedPicks[p]) continue;
      const hasWrong = base.grid[p].some(c => c.cross && c.wrong && !c.locked);
      if (hasWrong) requirements.push(pickRequirements(base, d, p, lockedPicks));
    }
    if (!requirements.length) return rank(candidates).slice(0, limit);

    // 穿综分层冲突的纬：同综框上穿有分属两层的经，任何踏板/升综列都无法
    // 同时满足，只能通过改穿综修复（本工具不动穿综）——明确返回说明。
    const conflictPicks = requirements.filter(r => r.conflict);
    if (conflictPicks.length) {
      candidates.push({
        key: 'threading-conflict', patch: null, changes: 0,
        errors: base.errors, warns: base.warns, maxFloat: baseMaxFloat,
        blocked: conflictPicks.map(r => ({
          pick: r.pick, shafts: r.conflictShafts,
        })),
      });
    }
    const searchable = requirements.filter(r => !r.conflict);
    if (!searchable.length) return rank(candidates).slice(0, limit);

    if (base.dobbyOn) searchDobby(d, dl, base, searchable, lockedPicks, candidates, seen, maxCandidates);
    else searchTreadle(d, dl, base, searchable, lockedPicks, candidates, seen, maxCandidates);

    return rank(candidates).slice(0, limit);
  }

  /** 评估候选：应用 patch → 重建模型 → 错误数 / 浮线；违反锁定格的候选丢弃。 */
  function evaluate(d, patch, changes, lockSet) {
    const nd = applyPatch(d, patch);
    // 锁定组织格交织值不得改变
    for (const [r, c] of lockSet) {
      const before = cellValue(d, liftModel(d), r, c);
      const after = cellValue(nd, liftModel(nd), r, c);
      if (before !== after) return null;
    }
    const m = buildModel(nd);
    const maxFloat = Math.max(
      m.floats.top.warp.max, m.floats.top.weft.max,
      m.floats.bottom.warp.max, m.floats.bottom.weft.max);
    return { draft: nd, model: m, errors: m.errors, warns: m.warns, maxFloat };
  }

  function rank(list) {
    return list.sort((a, b) =>
      a.errors - b.errors || a.changes - b.changes || a.maxFloat - b.maxFloat ||
      a.warns - b.warns);
  }

  /**
   * 修复某纬所需的综框升落要求。
   * 关键：升综以“综框”为单位，同综框上的每根经状态相同。因此一个综框的要求
   * 由该纬上它需要扮演的角色决定——若该综框穿入的经全属一层，要求唯一；
   * 若同综框混穿两层经，则该纬无论升降都会有一层出错（穿综分层冲突）。
   *
   * 对一个“层内一致”的综框（穿入经全部属于层 L）：
   *   - 该纬就是 L 层纬：属于层内交织，升落由本层组织决定（不强制）；
   *   - 该纬是另一层纬：跨层分离要求固定
   *       上层经综框在下层纬时必须升起（v=1）；
   *       下层经综框在上层纬时必须落下（v=0）。
   *
   * 区内（zoned）跨层经为可选接结，放入 optional（多臂枚举用；踏板模式不枚举）。
   */
  function pickRequirements(base, d, p) {
    const dl = base.dl;
    const lay = dl.pickLayer[p] ? 1 : 0;
    const firm = new Map();
    const optional = new Map();
    const conflictShafts = new Set();

    // 综框 -> 穿入经的层集合（层内一致才能被踏板/升综修复）
    const shaftLayers = new Map();
    for (let e = 0; e < d.ends; e++) {
      const s = d.threading[e];
      if (s < 0 || s >= d.shafts) continue;
      if (!shaftLayers.has(s)) shaftLayers.set(s, new Set());
      shaftLayers.get(s).add(dl.warpLayer[e] ? 1 : 0);
    }

    // 只看该纬的跨层经：它们是双层分离约束的来源
    base.grid[p].forEach((cell) => {
      if (!cell.cross) return;
      const sh = cell.trace.shaft;
      if (sh < 0) return;
      if (shaftLayers.get(sh).size > 1) { conflictShafts.add(sh); return; }
      if (cell.locked) return;
      if (cell.zoned) optional.set(sh, cell.expect);
      else firm.set(sh, cell.expect);
    });

    return {
      pick: p, lay,
      firm, optional,
      conflict: conflictShafts.size > 0,
      conflictShafts: [...conflictShafts],
    };
  }

  /** 多臂模式：逐违规纬枚举行变体（必改跨层 + 区内可选接结），贪心组合。 */
  function searchDobby(d, dl, base, offending, lockedPicks, candidates, seen, maxCandidates) {
    const S = d.shafts;
    const origRow = (p) => (d.dobby.cells[p] || new Array(S).fill(false)).slice();

    // 每纬的局部行变体：{ row:[bool], change:int }
    const perPick = offending.map((req) => {
      const pick = req.pick;
      const orig = origRow(pick);
      const firm = req.firm;
      const optional = req.optional;
      const variants = [{ row: orig.slice(), change: 0 }];
      const firmRow = orig.slice();
      let firmChange = 0;
      for (const [sh, v] of firm) {
        if (!!firmRow[sh] !== !!v) { firmRow[sh] = !!v; firmChange++; }
      }
      const optShafts = [...optional.keys()];
      const push = (row) => {
        const change = row.reduce((n, v, i) => n + (!!v !== !!orig[i]), 0);
        const key = row.map(v => v ? '1' : '0').join('');
        if (!variants.some(v => v.key === key)) variants.push({ row, change, key });
      };
      variants[0].key = orig.map(v => v ? '1' : '0').join('');
      // 必改行（不含可选接结）
      if (firmChange) push(firmRow);
      // 可选接结：枚举（上限 2^8），让评估按浮线/错误自行取舍
      if (optShafts.length) {
        const N = Math.min(optShafts.length, 8), total = Math.min(1 << N, 96);
        for (let mask = 0; mask < total; mask++) {
          const row = firmRow.slice();
          for (let i = 0; i < N; i++) if (mask & (1 << i)) {
            const sh = optShafts[i];
            row[sh] = !!optional.get(sh);
          }
          push(row);
        }
      }
      // 变体按本纬改动数预筛，保留前 8
      variants.sort((a, b) => a.change - b.change);
      return { pick, variants: variants.slice(0, 8) };
    });

    // 贪心束搜索：从基行开始，逐纬并入最优变体
    const lockSet = lockList(d);
    let beam = [{ rows: {}, change: 0 }];
    for (const { pick, variants } of perPick) {
      const next = [];
      for (const cur of beam) {
        for (const v of variants) {
          const rows = { ...cur.rows };
          if (v.change) rows[pick] = v.row.slice();
          next.push({ rows, change: cur.change + v.change });
        }
      }
      // 去重 + 限量评估
      const uniq = new Map();
      for (const n of next) {
        const key = Object.keys(n.rows).sort().map(p => `${p}:${n.rows[p].map(x => x ? 1 : 0).join('')}`).join('|');
        if (!uniq.has(key) || uniq.get(key).change > n.change) uniq.set(key, n);
      }
      const scored = [...uniq.values()].map(n => {
        const ev = evaluate(d, { mode: 'dobby', rows: n.rows }, n.change, lockSet);
        return ev ? { ...n, errors: ev.errors, warns: ev.warns, maxFloat: ev.maxFloat } : null;
      }).filter(Boolean);
      scored.sort((a, b) => a.errors - b.errors || a.change - b.change || a.maxFloat - b.maxFloat);
      beam = scored.slice(0, 5);
    }

    for (const n of beam) {
      if (!n.change) continue;
      const key = 'D' + Object.keys(n.rows).sort().map(p => `${p}:${n.rows[p].map(x => x ? 1 : 0).join('')}`).join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        key, patch: { mode: 'dobby', rows: n.rows }, changes: n.change,
        errors: n.errors, warns: n.warns, maxFloat: n.maxFloat,
      });
      if (candidates.length >= maxCandidates) break;
    }
  }

  /** 踏板模式：优先复用现成踏板；必要时把未被锁定纬使用的踏板改作新组合。 */
  function searchTreadle(d, dl, base, requirements, lockedPicks, candidates, seen, maxCandidates) {
    const S = d.shafts, T = d.treadles;
    const lockSet = lockList(d);
    const lockedTreadles = new Set();
    d.treadling.forEach((t, p) => { if (lockedPicks[p] && t >= 0 && t < T) lockedTreadles.add(t); });
    const colOf = (t) => Array.from({ length: S }, (_, s) => !!(d.tieup[s] && d.tieup[s][t]));

    const wants = requirements;

    const tried = new Set();
    const addCandidate = (treadling, tieup, change) => {
      const patch = { mode: 'treadle', treadling, tieup, treadles: T };
      const ev = evaluate(d, patch, change, lockSet);
      if (!ev) return;
      const key = 'T' + treadling.join(',') + '#' +
        tieup.map(r => r.map(x => x ? 1 : 0).join('')).join('|');
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({
        key, patch, changes: change,
        errors: ev.errors, warns: ev.warns, maxFloat: ev.maxFloat,
      });
    };

    // 方案一：逐纬改用现成踏板。不预设期望列：逐个尝试未被锁定纬占用的踏板
    // （重复穿综的经要求一致，恢复到原正确踏板的方案自然胜出）。
    for (const req of wants) {
      const pick = req.pick;
      const cur = d.treadling[pick];
      for (let t = 0; t < T; t++) {
        if (t === cur || lockedTreadles.has(t)) continue;
        const treadling = d.treadling.slice();
        treadling[pick] = t;
        if (tried.has(pick + ':' + t)) continue;
        tried.add(pick + ':' + t);
        addCandidate(treadling, d.tieup.map(r => r.slice()), 1);
      }
    }

    // 方案二：把一个空闲（未被锁定纬踩踏）踏板重联结为期望组合；
    // 多纬要求一致时共用同一新踏板。
    const freeTreadles = [];
    for (let t = 0; t < T; t++) if (!lockedTreadles.has(t)) freeTreadles.push(t);
    if (freeTreadles.length) {
      // 按期望列分组（最多取前 3 组）
      const groups = new Map();
      for (const req of wants) {
        if (!req.firm.size) continue;
        const k = [...req.firm.entries()].sort((a, b) => a[0] - b[0])
          .map(([s, v]) => `${s}:${v ? 1 : 0}`).join('|');
        if (!groups.has(k)) groups.set(k, { want: req.firm, picks: [] });
        groups.get(k).picks.push(req.pick);
      }
      let usedGroups = 0;
      for (const g of groups.values()) {
        if (usedGroups++ >= 3) break;
        const slot = freeTreadles.find(t => {
          const col = colOf(t);
          return [...g.want.entries()].every(([sh, v]) => col[sh] === v);
        }) || freeTreadles[0];
        const newCol = colOf(slot);
        let tieChange = 0;
        for (const [sh, v] of g.want) if (newCol[sh] !== v) { newCol[sh] = v; tieChange++; }
        // 该踏板若被未锁定纬踩着，改联结会波及它们——仍允许，但由评估的错误数把关
        const tieup = d.tieup.map(r => r.slice());
        for (let s = 0; s < S; s++) tieup[s][slot] = newCol[s];
        const treadling = d.treadling.slice();
        let pickChange = 0;
        for (const p of g.picks) {
          if (treadling[p] !== slot) { treadling[p] = slot; pickChange++; }
        }
        addCandidate(treadling, tieup, tieChange + pickChange);
      }
    }

    // 方案三：现有踏板无法承载时，新增踏板。新踏板列必须同时满足它将服务的
    // 全部纬次：跨层分离（firm）+ 各纬的层内交织（取这些纬所需综框升态的并集；
    // 同层穿法一致时并集无冲突）。
    {
      const addGroups = new Map();
      for (const req of wants) {
        if (!req.firm.size) continue;
        // 与现有踏板列完全一致的组合无需新增（方案一已覆盖）
        const exact = [...Array(T).keys()].find(t =>
          [...req.firm.entries()].every(([sh, v]) => colOf(t)[sh] === v));
        const k = [...req.firm.entries()].sort((a, b) => a[0] - b[0])
          .map(([s, v]) => `${s}:${v ? 1 : 0}`).join('|');
        if (exact !== undefined) continue;
        if (!addGroups.has(k)) addGroups.set(k, { reqs: [] });
        addGroups.get(k).reqs.push(req);
      }
      const groupsArr = [...addGroups.values()].slice(0, 2);
      if (groupsArr.length) {
        const newT = T + groupsArr.length;
        const tieup = Array.from({ length: S }, (_, s) => {
          const row = new Array(newT).fill(false);
          for (let t = 0; t < T; t++) row[t] = !!(d.tieup[s] && d.tieup[s][t]);
          return row;
        });
        const treadling = d.treadling.slice();
        let pickChange = 0, tieChange = 0;
        groupsArr.forEach((g, i) => {
          const slot = T + i;
          const col = new Array(S).fill(false);
          const lay = g.reqs[0].lay;
          const offendingPicks = new Set(wants.map(r => r.pick));
          // 同层其它“完好”纬所用踏板列：用于推断新踏板的层内升态
          const otherCols = [];
          for (let pp = 0; pp < d.picks; pp++) {
            if ((dl.pickLayer[pp] ? 1 : 0) !== lay) continue;
            if (offendingPicks.has(pp)) continue;
            const tt = d.treadling[pp];
            if (tt >= 0 && tt < T) otherCols.push(colOf(tt));
          }
          // 综框 -> 穿入经的层集合（层内一致才参与推断）
          const shaftLayers = new Map();
          for (let e = 0; e < d.ends; e++) {
            const sh = d.threading[e];
            if (sh < 0 || sh >= S) continue;
            if (!shaftLayers.has(sh)) shaftLayers.set(sh, new Set());
            shaftLayers.get(sh).add(dl.warpLayer[e] ? 1 : 0);
          }
          // 跨层要求优先（同组各纬一致）
          for (const [sh, v] of g.reqs[0].firm) col[sh] = v;
          // 层内综框：保证同层经在“其它同层纬 + 本踏板”间既有升也有落
          for (let sh = 0; sh < S; sh++) {
            if (g.reqs[0].firm.has(sh)) continue;
            const layers = shaftLayers.get(sh);
            if (!layers || layers.size !== 1) continue;
            if ([...layers][0] !== lay) continue;
            if (!otherCols.length) { col[sh] = !!(d.tieup[sh] && d.tieup[sh][d.treadling[g.reqs[0].pick]]); continue; }
            const ups = otherCols.filter(c => c[sh]).length;
            if (ups === otherCols.length) col[sh] = false; // 别处全升 → 此处落
            else if (ups === 0) col[sh] = true;             // 别处全落 → 此处升
            else { const ot = d.treadling[g.reqs[0].pick]; col[sh] = !!(d.tieup[sh] && d.tieup[sh][ot]); }
          }
          for (let s = 0; s < S; s++) { tieup[s][slot] = col[s]; tieChange++; }
          for (const req of g.reqs) {
            if (treadling[req.pick] !== slot) { treadling[req.pick] = slot; pickChange++; }
          }
        });
        const patch = { mode: 'treadle', treadling, tieup, treadles: newT };
        // 新踏板矩阵须按新尺寸直接评估（addCandidate 闭包按 T 计）
        const ev = evaluate(d, patch, tieChange + pickChange, lockList(d));
        if (ev) {
          const key = 'T+' + treadling.join(',') + '#' +
            tieup.map(r => r.map(x => x ? 1 : 0).join('')).join('|');
          if (!seen.has(key)) {
            seen.add(key);
            candidates.push({
              key, patch, changes: tieChange + pickChange,
              errors: ev.errors, warns: ev.warns, maxFloat: ev.maxFloat,
            });
          }
        }
      }
    }
  }

  function lockList(d) {
    const dl = ensure(d);
    return dl.lockedCells.map(([r, c]) => [r, c]);
  }

  /** 应用 patch 返回新草稿（不改原草稿）；patch 之外的字段原样保留。 */
  function applyPatch(d, patch) {
    const nd = JSON.parse(JSON.stringify(d));
    if (patch.mode === 'dobby') {
      // dobby 候选只可能产生于升综驱动，原草稿必带 cells；旧数据兜底补建
      if (!nd.dobby || !Array.isArray(nd.dobby.cells)) {
        nd.double && (nd.double.enabled = nd.double && nd.double.enabled);
        nd.dobby = window.Engine
          ? window.Engine.normalizeDobby({ enabled: true, cells: [] }, d.picks, d.shafts)
          : { enabled: true, cells: Array.from({ length: d.picks }, () => new Array(d.shafts).fill(false)) };
      }
      nd.dobby.enabled = true;
      nd.dobby.cells = nd.dobby.cells.map(r => r.slice());
      for (const [p, row] of Object.entries(patch.rows)) {
        nd.dobby.cells[p | 0] = row.slice();
      }
    } else {
      // 踏板数可能增加（方案三新增踏板）；必须同步 nd.treadles，否则踩踏值越界
      nd.treadles = patch.treadles;
      nd.treadling = patch.treadling.slice();
      nd.tieup = patch.tieup.map(r => r.slice());
      if (nd.dobby) nd.dobby.enabled = false;
    }
    return nd;
  }

  /** 采纳候选：返回可交给主应用 loadDraft 的新草稿（另存草稿，不覆盖原稿）。 */
  function candidateDraft(d, patch) {
    return applyPatch(d, patch);
  }

  /* ------------------------------- 差异叠色 ----------------------------- */
  /**
   * 候选相对当前稿的差异格（合并表面网格，p×e 布尔）。
   * 同时返回交织值差异网格 raw[p][e]：'flip' | null，供 UI 叠色。
   */
  function diffGrid(d, patch) {
    const nd = applyPatch(d, patch);
    const a = liftModel(d), b = liftModel(nd);
    const P = d.picks, E = d.ends;
    const raw = [], count = { flip: 0 };
    for (let p = 0; p < P; p++) {
      const row = [];
      for (let e = 0; e < E; e++) {
        const va = cellValue(d, a, p, e), vb = cellValue(nd, b, p, e);
        const flip = va !== vb;
        row.push(flip ? 'flip' : null);
        if (flip) count.flip++;
      }
      raw.push(row);
    }
    return { raw, count: count.flip };
  }

  return {
    STRUCT_NAMES, LAYER_NAMES,
    ensure, normalize,
    liftModel, cellValue, inZone, isLockedCell, foldOuterEnd,
    buildModel, layerFloats, shuttlePath, sectionAt,
    searchFixes, applyPatch, candidateDraft, evaluate: (d, patch) => {
      const changes = patchChangeCount(d, patch);
      return evaluate(d, patch, changes, lockList(d));
    },
    diffGrid,
    patchChangeCount,
  };

  function patchChangeCount(d, patch) {
    if (patch.mode === 'dobby') {
      let n = 0;
      const orig = (p) => (d.dobby && d.dobby.cells[p]) || [];
      for (const [p, row] of Object.entries(patch.rows)) {
        const o = orig(p | 0);
        row.forEach((v, s) => { if (!!v !== !!o[s]) n++; });
      }
      return n;
    }
    let n = 0;
    patch.treadling.forEach((t, p) => { if (t !== d.treadling[p]) n++; });
    for (let s = 0; s < d.shafts; s++)
      for (let t = 0; t < patch.treadles; t++)
        if (!!patch.tieup[s][t] !== !!(d.tieup[s] && d.tieup[s][t])) n++;
    return n;
  }
})();

if (typeof module !== 'undefined') module.exports = { DoubleCore };
if (typeof window !== 'undefined') window.DoubleCore = DoubleCore;
