/* =====================================================================
 * dobby-core.js — 多臂织机升综计划：纯逻辑核心（不依赖 DOM）
 *
 * 升综矩阵 cells[p][s]：第 p 纬综框 s 是否升起（列数 = 草稿综框数）。
 *   - 从当前穿综 / 联结 / 踩踏生成逐纬矩阵；
 *   - 纬段批量操作：复制 / 循环填充 / 镜像 / 平移（均返回新矩阵，便于撤销）；
 *   - 设备约束校验：综框越界、单纬升综超限、相邻纬切换过大；
 *   - 还原为踏板方案：相同升综组合共用踏板，组合数超过可用踏板时
 *     按频次取舍；应用前可与升综组织逐格比较差异。
 * ===================================================================== */
'use strict';

const DobbyCore = (() => {

  function clampInt(v, lo, hi, dflt) {
    v = parseInt(v, 10);
    if (!Number.isFinite(v)) return dflt;
    return Math.max(lo, Math.min(hi, v));
  }

  /* ------------------------------- 生成 -------------------------------- */
  /** 由穿综 / 联结 / 踩踏生成逐纬升综矩阵（不受当前 dobby.enabled 影响）。 */
  function cellsFromDraft(d) {
    const cells = [];
    for (let p = 0; p < d.picks; p++) {
      const row = new Array(d.shafts).fill(false);
      const t = d.treadling[p];
      if (t >= 0 && t < d.treadles) {
        for (let s = 0; s < d.shafts; s++) {
          if (d.tieup[s] && d.tieup[s][t]) row[s] = true;
        }
      }
      cells.push(row);
    }
    return cells;
  }

  /** 以指定升综矩阵推导组织（临时启用 dobby，不改原草稿）。 */
  function weaveWithCells(Engine, draft, cells) {
    const temp = { ...draft, dobby: { ...(draft.dobby || {}), enabled: true, cells } };
    return Engine.derive(temp);
  }

  /* ------------------------------- 统计 -------------------------------- */
  /** 每纬升综数 */
  function liftCounts(cells) {
    return cells.map(row => row.reduce((n, v) => n + (v ? 1 : 0), 0));
  }

  /** 每纬相对上一纬改变状态的综框数（第 1 纬为 0） */
  function switchCounts(cells) {
    const out = new Array(cells.length).fill(0);
    for (let p = 1; p < cells.length; p++) {
      const a = cells[p] || [], b = cells[p - 1] || [];
      const S = Math.max(a.length, b.length);
      let n = 0;
      for (let s = 0; s < S; s++) if (!!a[s] !== !!b[s]) n++;
      out[p] = n;
    }
    return out;
  }

  /* ------------------------------- 校验 -------------------------------- */
  /**
   * 设备约束校验（无论是否启用升综驱动都可调用，供升综台列出问题）。
   * 返回 [{ code, level, pick, msg, lifts?, switches?, shafts? }]：
   *   dobby-shaft-range  升起超出设备综框数（error）
   *   dobby-lift-limit   单纬升综数超限（error）
   *   dobby-switch-limit 相邻纬切换过大（warn）
   *   dobby-empty        该纬无综框升起（warn，全幅纬浮提示）
   */
  function validateDobby(db, picks, shafts) {
    const issues = [];
    const cells = (db && db.cells) || [];
    const device = clampInt(db && db.deviceShafts, 1, 24, shafts);
    const maxLift = clampInt(db && db.maxLift, 1, 24, shafts);
    const maxSwitch = clampInt(db && db.maxSwitch, 1, 24, shafts);
    for (let p = 0; p < picks; p++) {
      const row = cells[p] || [];
      let lifts = 0;
      const out = [];
      for (let s = 0; s < shafts; s++) {
        if (!row[s]) continue;
        lifts++;
        if (s >= device) out.push(s);
      }
      if (out.length) {
        issues.push({
          code: 'dobby-shaft-range', level: 'error', pick: p, shafts: out,
          msg: `第 ${p + 1} 纬升起综框 ${out.map(s => s + 1).join('、')}，超出设备 ${device} 综框`,
        });
      }
      if (lifts > maxLift) {
        issues.push({
          code: 'dobby-lift-limit', level: 'error', pick: p, lifts,
          msg: `第 ${p + 1} 纬升起 ${lifts} 个综框，超过单纬上限 ${maxLift}`,
        });
      }
      if (p > 0) {
        const prev = cells[p - 1] || [];
        let sw = 0;
        for (let s = 0; s < shafts; s++) if (!!row[s] !== !!prev[s]) sw++;
        if (sw > maxSwitch) {
          issues.push({
            code: 'dobby-switch-limit', level: 'warn', pick: p, switches: sw,
            msg: `第 ${p}→${p + 1} 纬切换 ${sw} 个综框状态，超过相邻纬上限 ${maxSwitch}`,
          });
        }
      }
      if (lifts === 0) {
        issues.push({
          code: 'dobby-empty', level: 'warn', pick: p,
          msg: `第 ${p + 1} 纬无综框升起（全幅纬浮）`,
        });
      }
    }
    return issues;
  }

  /* ------------------------------- 纬段批量操作 ------------------------- */
  /** 规整纬段为 0 基闭区间 [f, t]（自动交换、钳制到矩阵范围）。 */
  function clampRange(cells, from, to) {
    const P = cells.length;
    let f = clampInt(from, 0, Math.max(0, P - 1), 0);
    let t = clampInt(to, 0, Math.max(0, P - 1), 0);
    return f <= t ? [f, t] : [t, f];
  }

  const cloneCells = (cells) => cells.map(r => r.slice());

  /** 复制纬段 [from,to] 到 target 起始处（越界部分截断）。 */
  function copyRange(cells, from, to, target) {
    const out = cloneCells(cells);
    const [f, t] = clampRange(cells, from, to);
    const seg = cells.slice(f, t + 1).map(r => r.slice());
    const dst = clampInt(target, 0, Math.max(0, cells.length - 1), 0);
    for (let i = 0; i < seg.length && dst + i < cells.length; i++) out[dst + i] = seg[i];
    return out;
  }

  /** 循环填充：以纬段 [from,to] 为模板，顺次重复到最后一纬。 */
  function cycleFill(cells, from, to) {
    const out = cloneCells(cells);
    const [f, t] = clampRange(cells, from, to);
    const L = t - f + 1;
    for (let p = t + 1; p < cells.length; p++) out[p] = out[f + (p - f) % L].slice();
    return out;
  }

  /** 纬段镜像：段内纬次倒序。 */
  function mirrorRange(cells, from, to) {
    const out = cloneCells(cells);
    const [f, t] = clampRange(cells, from, to);
    for (let p = f; p <= t; p++) out[p] = cells[t - (p - f)].slice();
    return out;
  }

  /** 平移纬段：段整体移动 k 纬（可负）；移出界外的纬丢弃，原位置清空。 */
  function shiftRange(cells, from, to, k) {
    const out = cloneCells(cells);
    const [f, t] = clampRange(cells, from, to);
    k = k | 0;
    if (!k) return out;
    const seg = cells.slice(f, t + 1).map(r => r.slice());
    const S = seg.length ? seg[0].length : 0;
    for (let p = f; p <= t; p++) out[p] = new Array(S).fill(false);
    for (let i = 0; i < seg.length; i++) {
      const dst = f + i + k;
      if (dst >= 0 && dst < cells.length) out[dst] = seg[i];
    }
    return out;
  }

  /** 清空纬段（全部综框落下）。 */
  function clearRange(cells, from, to) {
    const out = cloneCells(cells);
    const [f, t] = clampRange(cells, from, to);
    const S = cells.length ? cells[0].length : 0;
    for (let p = f; p <= t; p++) out[p] = new Array(S).fill(false);
    return out;
  }

  /* ------------------------------- 还原为踏板方案 ----------------------- */
  const rowKey = (row) => row.map(v => (v ? '1' : '0')).join('');

  /**
   * 逐纬升综组合去重（按首次出现顺序）：
   * [{ key, shafts:[升起的综框], count:频次, picks:[涉及纬次 0 基], first:首现纬 }]
   */
  function liftCombos(cells) {
    const map = new Map();
    cells.forEach((row, p) => {
      const key = rowKey(row);
      let c = map.get(key);
      if (!c) {
        c = { key, shafts: [], count: 0, picks: [], first: p };
        row.forEach((v, s) => { if (v) c.shafts.push(s); });
        map.set(key, c);
      }
      c.count++;
      c.picks.push(p);
    });
    return [...map.values()];
  }

  /** 默认取舍：组合数 ≤ 踏板数全保留；否则按频次（同频按首现纬）取前 T 个。 */
  function defaultKeep(combos, treadles) {
    const order = combos.map((c, i) => i)
      .sort((a, b) => combos[b].count - combos[a].count || combos[a].first - combos[b].first);
    return new Set(order.slice(0, Math.max(0, treadles | 0)));
  }

  /** 被保留组合按首现纬顺序分配踏板号 → 组合索引数组（踏板 t = keepOrder[t]）。 */
  function keptOrder(combos, keepSet) {
    return combos.map((c, i) => i).filter(i => keepSet.has(i));
  }

  /**
   * 还原：相同升综组合共用踏板。
   * 返回 { tieup, treadling, dropped, treadles }：
   *   tieup[s][t]      踏板 t 踩下时综框 s 升起
   *   treadling[p]     第 p 纬踩的踏板；组合未保留（被舍弃）时为 -1
   *   dropped          未分配踏板的纬次（0 基）
   */
  function reduceToTreadles(cells, combos, keepIdx, shafts) {
    const keyToTreadle = new Map();
    keepIdx.forEach((ci, t) => keyToTreadle.set(combos[ci].key, t));
    const treadling = cells.map(row => {
      const t = keyToTreadle.get(rowKey(row));
      return t === undefined ? -1 : t;
    });
    const tieup = Array.from({ length: shafts }, () => new Array(keepIdx.length).fill(false));
    keepIdx.forEach((ci, t) => {
      combos[ci].shafts.forEach(s => { if (s < shafts) tieup[s][t] = true; });
    });
    const dropped = [];
    treadling.forEach((t, p) => { if (t < 0) dropped.push(p); });
    return { tieup, treadling, dropped, treadles: keepIdx.length };
  }

  /**
   * 把还原结果写成新草稿（不改动原草稿）：
   * 踏板数调整为保留组合数，联结 / 踩踏整体替换，升综计划保留但停用
   * （新草稿由踏板方案驱动组织图）。
   */
  function applyReduction(Engine, draft, cells, combos, keepIdx) {
    const red = reduceToTreadles(cells, combos, keepIdx, draft.shafts);
    const T = Math.max(1, red.treadles);
    const nd = Engine.resize(draft, {
      shafts: draft.shafts, treadles: T, ends: draft.ends, picks: draft.picks,
    });
    nd.tieup = red.tieup.map(row => {
      const r = row.slice();
      while (r.length < T) r.push(false);
      return r;
    });
    nd.treadling = red.treadling.slice();
    if (nd.dobby) nd.dobby = { ...nd.dobby, enabled: false };
    return { draft: nd, reduction: red };
  }

  /* ------------------------------- 组织差异 ----------------------------- */
  /**
   * 逐格比较两个组织图（1/0/null 不等即差异）：
   * { count, picks:[{pick, diffs}], grid:[picks][ends]bool }
   */
  function diffDrawdowns(ddA, ddB) {
    const P = Math.max(ddA.length, ddB.length);
    let count = 0;
    const picks = [];
    const grid = [];
    for (let p = 0; p < P; p++) {
      const ra = ddA[p] || [], rb = ddB[p] || [];
      const E = Math.max(ra.length, rb.length);
      const row = [];
      let rowDiff = 0;
      for (let e = 0; e < E; e++) {
        const va = ra[e] === undefined ? null : ra[e];
        const vb = rb[e] === undefined ? null : rb[e];
        const diff = va !== vb;
        row.push(diff);
        if (diff) { count++; rowDiff++; }
      }
      grid.push(row);
      if (rowDiff) picks.push({ pick: p, diffs: rowDiff });
    }
    return { count, picks, grid };
  }

  return {
    cellsFromDraft, weaveWithCells,
    liftCounts, switchCounts, validateDobby,
    clampRange, copyRange, cycleFill, mirrorRange, shiftRange, clearRange,
    rowKey, liftCombos, defaultKeep, keptOrder, reduceToTreadles, applyReduction,
    diffDrawdowns,
  };
})();

if (typeof module !== 'undefined') module.exports = { DobbyCore };
if (typeof window !== 'undefined') window.DobbyCore = DobbyCore;
