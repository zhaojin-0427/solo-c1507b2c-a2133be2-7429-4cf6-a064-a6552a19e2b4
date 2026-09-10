/* =====================================================================
 * reverse.js — 目标组织反推引擎（不依赖 DOM）
 *
 * 给定目标循环目标格 target.grid[p][e]：
 *    1 = 经线在上（经浮点），0 = 纬线在上（纬浮点），-1 = 不限
 *
 * 草稿模型与 engine.js 一致：
 *    drawdown[p][e] = tieup[ threading[e] ][ treadling[p] ]
 * 因此反推 = 把经线分到 ≤S 个综框、纬线分到 ≤T 个踏板，
 * 并为每个（综框,踏板）交叉块选 0/1，使目标硬格（非“不限”）尽量满足。
 *
 * 搜索：交叉块计数 + 下界剪枝的回溯（规范标号去重），
 *   - 每个交叉块累计 c0（要求纬在上的格数）/ c1（要求经在上的格数）；
 *   - 未锁联结时块代价 = min(c0,c1)（取多数派值），锁定时只能取锁定值；
 *   - 节点下界 = 各块代价之和，只会随分配增大，用于分支限界；
 *   - 新分组只能取当前最小编号空位，枚举的是集合划分而非标号排列。
 * ===================================================================== */
'use strict';

const Reverse = (() => {

  const NODE_MAX = 120000;   // 回溯节点上限
  const LEAF_MAX = 1800;     // 完整方案收集上限
  const TIME_MAX = 2500;     // 毫秒上限
  const TOP_N = 12;          // 候选保留数

  const now = () => (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ------------------------------- 目标图 ------------------------------- */
  function makeTarget(ends = 4, picks = 4) {
    const grid = Array.from({ length: picks }, (_, p) =>
      Array.from({ length: ends }, (_, e) => ((p + e) % 2 === 0 ? 1 : 0)));
    return { ends, picks, grid };
  }

  /** 调整目标循环尺寸，保留重叠区域，新格默认“不限”。 */
  function resizeTarget(t, ends, picks) {
    const grid = Array.from({ length: picks }, (_, p) =>
      Array.from({ length: ends }, (_, e) =>
        (p < t.picks && e < t.ends) ? t.grid[p][e] : -1));
    return { ends, picks, grid };
  }

  function clearTarget(t, value = -1) {
    return { ends: t.ends, picks: t.picks,
             grid: Array.from({ length: t.picks }, () => new Array(t.ends).fill(value)) };
  }

  function invertTarget(t) {
    return { ends: t.ends, picks: t.picks,
             grid: t.grid.map(row => row.map(v => v === -1 ? -1 : (v ? 0 : 1))) };
  }

  /** 从一份草稿的组织图左上角截取目标（缺失格记为“不限”）。 */
  function targetFromDraft(d, ends, picks) {
    const A = Engine.derive(d);
    const E = clamp(ends || d.ends, 2, 16);
    const P = clamp(picks || d.picks, 2, 16);
    const grid = Array.from({ length: P }, (_, p) =>
      Array.from({ length: E }, (_, e) => {
        const v = A.drawdown[p % d.picks][e % d.ends];
        return v === null ? -1 : v;
      }));
    return { ends: E, picks: P, grid };
  }

  /* ------------------------------- 主搜索 ------------------------------- */
  /**
   * opts:
   *   base            当前草稿（颜色、改动对照、锁定来源）
   *   shafts/treadles 可用综框/踏板（2–8）
   *   maxFloat        最长浮线限值（仅透传给候选与标记）
   *   lockThreading / lockTieup / lockTreadling
   * 返回 { ok, exact, truncated, nodes, leaves, elapsedMs,
   *        hardCount, wildCount, candidates[] } 或 { ok:false, error }
   */
  function search(target, opts) {
    const t0 = now();
    const E = target.ends, P = target.picks;
    const S = clamp(opts.shafts | 0, 2, 8);
    const T = clamp(opts.treadles | 0, 2, 8);
    const maxFloat = clamp(opts.maxFloat | 0, 1, 64);
    const base = opts.base;

    // H[p][e]：1 / 0 / null（不限）
    const H = [];
    let hardCount = 0, wildCount = 0;
    const endHard = new Array(E).fill(0);
    const pickHard = new Array(P).fill(0);
    for (let p = 0; p < P; p++) {
      const row = [];
      for (let e = 0; e < E; e++) {
        const v = target.grid[p][e];
        if (v === 1 || v === 0) { row.push(v); hardCount++; endHard[e]++; pickHard[p]++; }
        else { row.push(null); wildCount++; }
      }
      H.push(row);
    }
    if (hardCount === 0) {
      return { ok: false, error: 'empty-target', msg: '目标循环全为“不限”，请至少标注一个目标格。' };
    }

    // 当前稿在目标尺寸下的对齐序列（循环对齐，用于锁与改动对照）
    const baseEnd = Array.from({ length: E }, (_, e) => {
      const v = base.threading[e % base.ends];
      return (v >= 0 && v < base.shafts) ? v : null;
    });
    const basePick = Array.from({ length: P }, (_, p) => {
      const v = base.treadling[p % base.picks];
      return (v >= 0 && v < base.treadles) ? v : null;
    });

    // ---- 锁定：固定的经/纬分配，固定的交叉块取值 ----
    const es = new Int32Array(E).fill(-1);
    const ps = new Int32Array(P).fill(-1);
    const lockVal = new Array(S * T).fill(null); // null=自由，0/1=锁定值

    if (opts.lockThreading) {
      for (let e = 0; e < E; e++) {
        const v = base.threading[e % base.ends];
        if (!(v >= 0 && v < S)) {
          return { ok: false, error: 'lock-threading-range',
                   msg: `锁定穿综不可用：第 ${e + 1} 根经穿在综框 ${v + 1}，超出可用综框数 ${S}。` };
        }
        es[e] = v;
      }
    }
    if (opts.lockTreadling) {
      for (let p = 0; p < P; p++) {
        const v = base.treadling[p % base.picks];
        if (!(v >= 0 && v < T)) {
          return { ok: false, error: 'lock-treadling-range',
                   msg: `锁定踩踏不可用：第 ${p + 1} 纬踩踏板 ${v + 1}，超出可用踏板数 ${T}。` };
        }
        ps[p] = v;
      }
    }
    if (opts.lockTieup) {
      for (let s = 0; s < S; s++)
        for (let t = 0; t < T; t++)
          lockVal[s * T + t] = (base.tieup[s] && base.tieup[s][t]) ? 1 : 0;
    }

    const NB = S * T;
    const c0 = new Int32Array(NB);
    const c1 = new Int32Array(NB);
    let usedSMask = 0, usedTMask = 0;

    function bump(s, t, v, dir) {
      const b = s * T + t;
      if (v === 0) c0[b] += dir; else c1[b] += dir;
    }
    function rebuildState() {
      c0.fill(0); c1.fill(0);
      usedSMask = 0; usedTMask = 0;
      for (let e = 0; e < E; e++) if (es[e] >= 0) usedSMask |= 1 << es[e];
      for (let p = 0; p < P; p++) if (ps[p] >= 0) usedTMask |= 1 << ps[p];
      for (let e = 0; e < E; e++) {
        const s = es[e];
        if (s < 0) continue;
        for (let p = 0; p < P; p++) {
          const t = ps[p];
          if (t < 0) continue;
          const v = H[p][e];
          if (v !== null) bump(s, t, v, 1);
        }
      }
    }
    function applyEnd(e, s, dir) {
      if (dir > 0) {
        for (let p = 0; p < P; p++) {
          const t = ps[p];
          if (t < 0) continue;
          const v = H[p][e];
          if (v !== null) bump(s, t, v, 1);
        }
        es[e] = s; usedSMask |= 1 << s;
      } else {
        es[e] = -1;
        rebuildState();
      }
    }
    function applyPick(p, t, dir) {
      if (dir > 0) {
        for (let e = 0; e < E; e++) {
          const s = es[e];
          if (s < 0) continue;
          const v = H[p][e];
          if (v !== null) bump(s, t, v, 1);
        }
        ps[p] = t; usedTMask |= 1 << t;
      } else {
        ps[p] = -1;
        rebuildState();
      }
    }
    // 预置锁定分配
    function replayLocks() {
      for (let e = 0; e < E; e++)
        if (opts.lockThreading) applyEnd(e, base.threading[e % base.ends], 1);
      for (let p = 0; p < P; p++)
        if (opts.lockTreadling) applyPick(p, base.treadling[p % base.picks], 1);
    }
    replayLocks();

    function blockCost(b) {
      const lv = lockVal[b];
      if (lv === 1) return c0[b];
      if (lv === 0) return c1[b];
      return Math.min(c0[b], c1[b]);
    }
    function lowerBound() {
      let lb = 0;
      for (let b = 0; b < NB; b++) lb += blockCost(b);
      return lb;
    }
    /** 若向块 b 再放入一个值 v，块代价的增量。 */
    function blockInc(b, v) {
      const a = c0[b], z = c1[b];
      const lv = lockVal[b];
      if (lv === 1) return v === 0 ? 1 : 0;
      if (lv === 0) return v === 1 ? 1 : 0;
      const before = Math.min(a, z);
      const after = Math.min(a + (v === 0 ? 1 : 0), z + (v === 1 ? 1 : 0));
      return after - before;
    }
    function smallestUnused(mask, n) {
      for (let i = 0; i < n; i++) if (!(mask & (1 << i))) return i;
      return -1;
    }

    const top = [];
    let nodes = 0, leaves = 0;
    let stop = false;
    let truncated = null;

    /* 不可行快速判定：
     * 不考虑“不限”格时，同综框的经线列必须完全一致（逐纬取值），
     * 同踏板的纬线行必须完全一致（逐经取值）。
     * 不同全确定列型 / 行型的数量若已超过综框 / 踏板数，则不可能精确满足。
     * 此时只需收集最近似方案，可放宽节点预算尽快给出答案。 */
    function distinctHardPatterns(dir) {
      const n = dir === 'e' ? E : P;
      const seen = new Set();
      for (let i = 0; i < n; i++) {
        let pat = '', full = true;
        const m = dir === 'e' ? P : E;
        for (let j = 0; j < m; j++) {
          const v = dir === 'e' ? H[j][i] : H[i][j];
          if (v === null) { full = false; break; }
          pat += v;
        }
        // 仅完全确定的列/行才构成互斥型：同框经线必须逐纬相同。
        if (full) seen.add(pat);
      }
      return seen.size;
    }
    const exactImpossibleCols = distinctHardPatterns('e') > S;
    const exactImpossibleRows = distinctHardPatterns('p') > T;
    const exactImpossible = exactImpossibleCols || exactImpossibleRows;
    const EFFECTIVE_NODE_MAX = exactImpossible ? Math.min(NODE_MAX, 40000) : NODE_MAX;
    const EFFECTIVE_LEAF_MAX = exactImpossible ? Math.min(LEAF_MAX, 300) : LEAF_MAX;
    if (exactImpossible) truncated = 'infeasible';

    function rankCmp(a, b) {
      // 目标格匹配率 → 改动格数 → 实际占用综框数 → 实际占用踏板数
      return (b.matchRate - a.matchRate) ||
             (a.changes - b.changes) ||
             (a.usedShafts - b.usedShafts) ||
             (a.usedTreadles - b.usedTreadles) ||
             (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    }
    function addCandidate(cand) {
      if (top.some(c => c.key === cand.key)) return;
      let i = 0;
      while (i < top.length && rankCmp(top[i], cand) < 0) i++;
      top.splice(i, 0, cand);
      if (top.length > TOP_N) top.pop();
    }

    /* ---------------- 叶节点：定联结值、构造候选、算指标 ---------------- */
    function makeLeaf() {
      const tie = Array.from({ length: S }, () => new Array(T).fill(false));
      const tieVal = new Int8Array(NB);
      let conflicts = 0;
      for (let s = 0; s < S; s++) {
        for (let t = 0; t < T; t++) {
          const b = s * T + t;
          const a = c0[b], z = c1[b];
          const lv = lockVal[b];
          let val;
          if (lv !== null) {
            val = lv;
            conflicts += lv === 1 ? a : z;
          } else if (a > 0 && z > 0) {
            conflicts += Math.min(a, z);
            const baseVal = (base.tieup[s] && base.tieup[s][t]) ? 1 : 0;
            val = a === z ? (baseVal ? 1 : 0) : (z > a ? 1 : 0);
          } else if (z > 0) {
            val = 1;
          } else if (a > 0) {
            val = 0;
          } else {
            // 块内只有“不限”格：取当前稿联结值，减少改动
            val = (base.tieup[s] && base.tieup[s][t]) ? 1 : 0;
          }
          tieVal[b] = val;
          tie[s][t] = !!val;
        }
      }

      const threading = Array.from(es);
      const treadling = Array.from(ps);
      const key = threading.join(',') + '|' + Array.from(tieVal).join('') + '|' + treadling.join(',');

      // 改动格数（只统计两边都存在的可比区域；扩格在摘要中另计）
      let changes = 0;
      for (let e = 0; e < Math.min(E, base.ends); e++)
        if (threading[e] !== base.threading[e]) changes++;
      for (let p = 0; p < Math.min(P, base.picks); p++)
        if (treadling[p] !== base.treadling[p]) changes++;
      for (let s = 0; s < Math.min(S, base.shafts); s++)
        for (let t = 0; t < Math.min(T, base.treadles); t++)
          if (tie[s][t] !== !!base.tieup[s][t]) changes++;

      let usedShafts = 0;
      threading.forEach(s => { usedShafts |= 1 << s; });
      let usedTreadles = 0;
      treadling.forEach(t => { usedTreadles |= 1 << t; });
      usedShafts = bitCount(usedShafts);
      usedTreadles = bitCount(usedTreadles);

      const palLen = base.palette ? base.palette.length : 0;
      const palIdx = (i) => (Number.isInteger(i) && palLen ? ((i % palLen) + palLen) % palLen : 0);
      const warpAt = (e) => (base.warpColor && base.warpColor[e % base.ends] != null)
        ? palIdx(base.warpColor[e % base.ends]) : 0;
      const weftAt = (p) => (base.weftColor && base.weftColor[p % base.picks] != null)
        ? palIdx(base.weftColor[p % base.picks]) : 1;
      const draft = {
        shafts: S, treadles: T, ends: E, picks: P, maxFloat,
        threading, treadling, tieup: tie,
        warpColor: Array.from({ length: E }, (_, e) => warpAt(e)),
        weftColor: Array.from({ length: P }, (_, p) => weftAt(p)),
        palette: (base.palette || Engine.PALETTE).map(c => ({ ...c })),
      };
      const A = Engine.analyze(draft);
      const cand = {
        key, conflicts,
        match: hardCount - conflicts,
        matchRate: hardCount ? (hardCount - conflicts) / hardCount : 0,
        changes,
        usedShafts, usedTreadles,
        maxWarp: A.stats.maxWarpFloat,
        maxWeft: A.stats.maxWeftFloat,
        floatOK: A.stats.maxWarpFloat <= maxFloat && A.stats.maxWeftFloat <= maxFloat,
        repW: A.rep.warp, repH: A.rep.weft,
        errors: A.validation.errors,
        warns: A.validation.warns,
        draft,
      };
      addCandidate(cand);
    }

    /* ------------------------------- DFS ------------------------------- */
    // 各未分配经/纬在当前状态下的标号代价缓存，仅在「另一维」分配时失效：
    // 分配经线只改变未分配纬线的代价格局，反之亦然。
    const endDeltaDirty = new Uint8Array(E);
    const endDeltaCache = Array.from({ length: E }, () => new Int32Array(S));
    const pickDeltaDirty = new Uint8Array(P);
    const pickDeltaCache = Array.from({ length: P }, () => new Int32Array(T));
    endDeltaDirty.fill(1);
    pickDeltaDirty.fill(1);

    function endDeltas(e) {
      if (!endDeltaDirty[e]) return endDeltaCache[e];
      const arr = endDeltaCache[e];
      arr.fill(0);
      for (let p = 0; p < P; p++) {
        const t = ps[p];
        if (t < 0) continue;
        const v = H[p][e];
        if (v === null) continue;
        for (let s = 0; s < S; s++) arr[s] += blockInc(s * T + t, v);
      }
      endDeltaDirty[e] = 0;
      return arr;
    }
    function pickDeltas(p) {
      if (!pickDeltaDirty[p]) return pickDeltaCache[p];
      const arr = pickDeltaCache[p];
      arr.fill(0);
      for (let e = 0; e < E; e++) {
        const s = es[e];
        if (s < 0) continue;
        const v = H[p][e];
        if (v === null) continue;
        for (let t = 0; t < T; t++) arr[t] += blockInc(s * T + t, v);
      }
      pickDeltaDirty[p] = 0;
      return arr;
    }

    function dfs() {
      if (stop) return;
      if (++nodes > EFFECTIVE_NODE_MAX) {
        truncated = truncated || 'nodes';
        stop = true;
        return;
      }
      if ((nodes & 255) === 0 && now() - t0 > TIME_MAX) { truncated = truncated || 'time'; stop = true; return; }

      // MRV：在未分配经/纬中选可用标号数最少者（并列取硬格最多）。
      let choice = null;
      for (let e = 0; e < E; e++) {
        if (es[e] >= 0) continue;
        const free = smallestUnused(usedSMask, S);
        const nDom = bitCount(usedSMask) + (free >= 0 ? 1 : 0);
        if (!choice || nDom < choice.dom || (nDom === choice.dom && endHard[e] > choice.hard))
          choice = { kind: 'e', idx: e, dom: nDom, free, hard: endHard[e] };
      }
      for (let p = 0; p < P; p++) {
        if (ps[p] >= 0) continue;
        const free = smallestUnused(usedTMask, T);
        const nDom = bitCount(usedTMask) + (free >= 0 ? 1 : 0);
        if (!choice || nDom < choice.dom ||
            (nDom === choice.dom && pickHard[p] > choice.hard))
          choice = { kind: 'p', idx: p, dom: nDom, free, hard: pickHard[p] };
      }

      if (!choice) {
        leaves++;
        makeLeaf();
        if (leaves >= EFFECTIVE_LEAF_MAX) { truncated = truncated || 'leaves'; stop = true; }
        return;
      }

      if (choice.kind === 'e') {
        const e = choice.idx, delta = endDeltas(e), pref = baseEnd[e];
        const branches = [];
        for (let s = 0; s < S; s++) {
          const isNew = !(usedSMask & (1 << s));
          if (isNew && s !== choice.free) continue;
          branches.push({ val: s, d: delta[s], isNew, pref: s === pref ? 0 : 1 });
        }
        branches.sort((a, b) => (a.d - b.d) || a.pref - b.pref ||
                                 (a.isNew - b.isNew) || (a.val - b.val));
        endDeltaDirty[e] = 0;
        for (const o of branches) {
          applyEnd(e, o.val, 1);
          // 交叉块计数一变，其余经/纬的边际增量都会变：同维缓存始终标脏
          endDeltaDirty.fill(1);
          pickDeltaDirty.fill(1);
          dfs();
          applyEnd(e, o.val, -1);
          endDeltaDirty.fill(1);
          pickDeltaDirty.fill(1);
          if (stop) return;
        }
      } else {
        const p = choice.idx, delta = pickDeltas(p), pref = basePick[p];
        const branches = [];
        for (let t = 0; t < T; t++) {
          const isNew = !(usedTMask & (1 << t));
          if (isNew && t !== choice.free) continue;
          branches.push({ val: t, d: delta[t], isNew, pref: t === pref ? 0 : 1 });
        }
        branches.sort((a, b) => (a.d - b.d) || a.pref - b.pref ||
                                 (a.isNew - b.isNew) || (a.val - b.val));
        pickDeltaDirty[p] = 0;
        for (const o of branches) {
          applyPick(p, o.val, 1);
          endDeltaDirty.fill(1);
          pickDeltaDirty.fill(1);
          dfs();
          applyPick(p, o.val, -1);
          endDeltaDirty.fill(1);
          pickDeltaDirty.fill(1);
          if (stop) return;
        }
      }
    }

    dfs();

    top.forEach((c, i) => { c.rank = i + 1; });
    return {
      ok: true,
      exact: top.length > 0 && top[0].conflicts === 0,
      truncated,
      exactImpossible,
      nodes, leaves,
      elapsedMs: Math.round(now() - t0),
      hardCount, wildCount,
      params: {
        shafts: S, treadles: T, ends: E, picks: P, maxFloat,
        lockThreading: !!opts.lockThreading,
        lockTieup: !!opts.lockTieup,
        lockTreadling: !!opts.lockTreadling,
      },
      candidates: top,
    };
  }

  function bitCount(x) {
    let n = 0;
    while (x) { n++; x &= x - 1; }
    return n;
  }

  /* ------------------------- 冲突诊断（无精确解时） ------------------------- */
  /**
   * 返回：
   *   mismatches  候选与目标硬格不符的格子（用于叠色）
   *   realized    “不限”格被实现成的值（用于角标）
   *   warpConflicts  同综框经线对：某纬处一上一下
   *   weftConflicts  同踏板纬线对：某经处一上一下
   *   blockConflicts 交叉块同时要求 0 和 1（或与锁定联结相左）
   */
  function explain(cand, target) {
    const d = cand.draft || cand;
    const A = Engine.derive(d);
    const mismatches = [];
    const realized = [];
    for (let p = 0; p < target.picks; p++) {
      for (let e = 0; e < target.ends; e++) {
        const want = target.grid[p][e];
        const got = A.drawdown[p][e];
        if (want === -1) realized.push({ p, e, got });
        else if (got !== want) mismatches.push({ p, e, want, got });
      }
    }

    const hard = (p, e) => {
      const v = target.grid[p][e];
      return v === -1 ? null : v;
    };

    // 同综框经线分组
    const shaftEnds = Array.from({ length: d.shafts }, () => []);
    d.threading.forEach((s, e) => shaftEnds[s].push(e));
    const warpConflicts = [];
    shaftEnds.forEach((ends, s) => {
      for (let i = 0; i < ends.length; i++) {
        for (let j = i + 1; j < ends.length; j++) {
          const a = ends[i], b = ends[j];
          const picks = [];
          for (let p = 0; p < target.picks; p++) {
            const va = hard(p, a), vb = hard(p, b);
            if (va !== null && vb !== null && va !== vb) picks.push(p);
          }
          if (picks.length) warpConflicts.push({ shaft: s, a, b, picks });
        }
      }
    });

    // 同踏板纬线分组
    const treadlePicks = Array.from({ length: d.treadles }, () => []);
    d.treadling.forEach((t, p) => treadlePicks[t].push(p));
    const weftConflicts = [];
    treadlePicks.forEach((picks, t) => {
      for (let i = 0; i < picks.length; i++) {
        for (let j = i + 1; j < picks.length; j++) {
          const a = picks[i], b = picks[j];
          const ends = [];
          for (let e = 0; e < target.ends; e++) {
            const va = hard(a, e), vb = hard(b, e);
            if (va !== null && vb !== null && va !== vb) ends.push(e);
          }
          if (ends.length) weftConflicts.push({ treadle: t, a, b, ends });
        }
      }
    });

    // 交叉块
    const blockConflicts = [];
    for (let s = 0; s < d.shafts; s++) {
      for (let t = 0; t < d.treadles; t++) {
        let n0 = 0, n1 = 0;
        const ends = shaftEnds[s], picks = treadlePicks[t];
        for (const p of picks) for (const e of ends) {
          const v = hard(p, e);
          if (v === 0) n0++; else if (v === 1) n1++;
        }
        if (n0 && n1) {
          blockConflicts.push({
            shaft: s, treadle: t, n0, n1,
            locked: d.tieup[s][t] ? 1 : 0,
            ends: ends.slice(), picks: picks.slice(),
          });
        }
      }
    }

    return { mismatches, realized, warpConflicts, weftConflicts, blockConflicts };
  }

  /** 中文诊断条目（界面与测试共用）。 */
  function explainNotes(info) {
    const notes = [];
    info.warpConflicts.forEach(c => {
      const at = c.picks.slice(0, 3).map(p => `第${p + 1}纬`).join('、') +
                 (c.picks.length > 3 ? ` 等${c.picks.length}处` : '');
      notes.push(`经线 ${c.a + 1}、${c.b + 1} 同穿综框 ${c.shaft + 1}，但${at}二者要求一上一下，同框经线必然同升同降，无法同时满足。`);
    });
    info.weftConflicts.forEach(c => {
      const at = c.ends.slice(0, 3).map(e => `第${e + 1}经`).join('、') +
                 (c.ends.length > 3 ? ` 等${c.ends.length}处` : '');
      notes.push(`纬线 ${c.a + 1}、${c.b + 1} 同踩踏板 ${c.treadle + 1}，但${at}二者要求一上一下，同踏板纬线升降完全相同，无法同时满足。`);
    });
    info.blockConflicts.forEach(b => {
      const es = b.ends.slice(0, 4).map(e => e + 1).join('、');
      const ps = b.picks.slice(0, 4).map(p => p + 1).join('、');
      notes.push(`交叉块（综框 ${b.shaft + 1}：经 ${es}… × 踏板 ${b.treadle + 1}：纬 ${ps}…）中，` +
        `${b.n1} 格要求经在上、${b.n0} 格要求纬在上，只能取其一。`);
    });
    return notes;
  }

  /* ----------------------------- 改动摘要 ----------------------------- */
  /** 候选相对当前稿 base 的穿综 / 联结 / 踩踏改动（不把扩维算成改动格）。 */
  function changeSummary(cand, base) {
    const c = cand.draft || cand;
    const threading = { changed: [], added: [] };
    for (let i = 0; i < Math.min(c.ends, base.ends); i++) {
      if (c.threading[i] !== base.threading[i])
        threading.changed.push({ i, from: base.threading[i], to: c.threading[i] });
    }
    for (let i = base.ends; i < c.ends; i++)
      threading.added.push({ i, to: c.threading[i] });

    const treadling = { changed: [], added: [] };
    for (let i = 0; i < Math.min(c.picks, base.picks); i++) {
      if (c.treadling[i] !== base.treadling[i])
        treadling.changed.push({ i, from: base.treadling[i], to: c.treadling[i] });
    }
    for (let i = base.picks; i < c.picks; i++)
      treadling.added.push({ i, to: c.treadling[i] });

    const tieup = { changed: [], added: [] };
    for (let s = 0; s < c.shafts; s++) {
      for (let t = 0; t < c.treadles; t++) {
        const v = !!c.tieup[s][t];
        if (s < base.shafts && t < base.treadles) {
          if (v !== !!base.tieup[s][t])
            tieup.changed.push({ s, t, from: !!base.tieup[s][t], to: v });
        } else if (v) {
          tieup.added.push({ s, t, to: v });
        }
      }
    }

    return {
      dims: {
        from: { shafts: base.shafts, treadles: base.treadles, ends: base.ends, picks: base.picks },
        to: { shafts: c.shafts, treadles: c.treadles, ends: c.ends, picks: c.picks },
      },
      threading, treadling, tieup,
      totalChanged: threading.changed.length + treadling.changed.length + tieup.changed.length,
    };
  }

  return {
    makeTarget, resizeTarget, clearTarget, invertTarget, targetFromDraft,
    search, explain, explainNotes, changeSummary,
  };
})();

if (typeof module !== 'undefined') module.exports = { Reverse };
