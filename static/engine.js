/* =====================================================================
 * engine.js — 纯组织推导引擎（不依赖 DOM）
 *
 * 数据模型 Draft:
 * {
 *   shafts: int, treadles: int, ends: int, picks: int, maxFloat: int,
 *   threading: [ends]                 值 0..shafts-1（该经穿入的综框），-1=越界/未穿
 *   tieup:     [[shafts] × [treadles]] 布尔，tieup[s][t]=1 表示踏下 t 时综框 s 升起
 *   treadling: [picks]                值 0..treadles-1（该纬踩踏的踏板），-1=未踩踏
 *   warpColor: [ends]                 色号索引
 *   weftColor:[picks]                 色号索引
 *   palette:   [{name, hex}]
 * }
 *
 * drawdown[p][e]：1=经线在上（正面见经色），0=纬线在上（正面见纬色），
 *                  null=信息缺失（越界/空踏板/未交织）
 * ===================================================================== */
'use strict';

const Engine = (() => {

  const PALETTE = [
    { name: '本白', hex: '#f4ecd8' },
    { name: '靛蓝', hex: '#274060' },
    { name: '朱红', hex: '#b3352a' },
    { name: '藤黄', hex: '#d9a441' },
    { name: '松绿', hex: '#4a7c59' },
    { name: '紫棠', hex: '#5b3a5e' },
    { name: '栗棕', hex: '#6e4423' },
    { name: '墨黑', hex: '#23211d' },
  ];

  function defaultDraft() {
    const shafts = 4, treadles = 4, ends = 16, picks = 16;
    const threading = [];
    const treadling = [];
    for (let e = 0; e < ends; e++) threading.push(e % shafts);
    for (let p = 0; p < picks; p++) treadling.push(p % treadles);
    // 2/2 斜纹联结：踏 t 时，综框 t、t+1 升起（模 4）
    const tieup = Array.from({ length: shafts }, (_, s) =>
      Array.from({ length: treadles }, (_, t) => s === t || s === (t + 1) % 4)
    );
    return {
      shafts, treadles, ends, picks, maxFloat: 3,
      threading, tieup, treadling,
      warpColor: new Array(ends).fill(0),
      weftColor: new Array(picks).fill(1),
      palette: PALETTE.map(c => ({ ...c })),
    };
  }

  function blankDraft(shafts = 4, treadles = 4, ends = 16, picks = 16) {
    return {
      shafts, treadles, ends, picks, maxFloat: 3,
      threading: new Array(ends).fill(0),
      tieup: Array.from({ length: shafts }, () => new Array(treadles).fill(false)),
      treadling: new Array(picks).fill(0),
      warpColor: new Array(ends).fill(0),
      weftColor: new Array(picks).fill(1),
      palette: PALETTE.map(c => ({ ...c })),
    };
  }

  function cloneDraft(d) {
    return {
      ...d,
      threading: d.threading.slice(),
      treadling: d.treadling.slice(),
      warpColor: d.warpColor.slice(),
      weftColor: d.weftColor.slice(),
      tieup: d.tieup.map(row => row.slice()),
      palette: d.palette.map(c => ({ ...c })),
    };
  }

  /** 调整尺寸：保留有效区域数据，新增部分给出默认值；越界值保留（由校验报错）。 */
  function resize(d, { shafts, treadles, ends, picks }) {
    const nd = cloneDraft(d);
    const old = { s: d.shafts, t: d.treadles, e: d.ends, p: d.picks };

    nd.threading = resize1D(d.threading, ends, (i) => i < shafts ? i : 0);
    nd.treadling = resize1D(d.treadling, picks, (i) => i < treadles ? i % treadles : 0);
    nd.warpColor = resize1D(d.warpColor, ends, () => 0);
    nd.weftColor = resize1D(d.weftColor, picks, () => 1);

    nd.tieup = Array.from({ length: shafts }, (_, s) =>
      Array.from({ length: treadles }, (_, t) =>
        (s < old.s && t < old.t) ? !!d.tieup[s][t] : false)
    );
    nd.shafts = shafts; nd.treadles = treadles; nd.ends = ends; nd.picks = picks;
    return nd;
  }

  function resize1D(arr, n, fill) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = i < arr.length ? arr[i] : fill(i);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 组织图推导
   * ------------------------------------------------------------------ */
  function derive(d) {
    const { shafts, treadles, ends, picks } = d;
    const drawdown = [];      // [picks][ends] : 1 | 0 | null
    const lifted = [];        // [picks] -> Set<shaft>
    const pickValid = [];

    for (let p = 0; p < picks; p++) {
      const t = d.treadling[p];
      const row = new Array(ends).fill(null);
      const set = new Set();
      let valid = true;

      if (t < 0 || t >= treadles) {
        valid = false; // 空踏板 / 越界踏板
      } else {
        for (let s = 0; s < shafts; s++) {
          if (d.tieup[s] && d.tieup[s][t]) set.add(s);
        }
        if (set.size === 0) valid = false; // 该踏板无联结
      }
      lifted[p] = set;
      pickValid[p] = valid;

      for (let e = 0; e < ends; e++) {
        const s = d.threading[e];
        if (!valid || s < 0 || s >= shafts) {
          row[e] = null;
        } else {
          row[e] = set.has(s) ? 1 : 0;
        }
      }
      drawdown.push(row);
    }
    return { drawdown, lifted, pickValid };
  }

  /** 正面颜色矩阵（hex），缺失格返回 null */
  function colorGrid(d, derived, side = 'front') {
    return derived.drawdown.map((row, p) =>
      row.map((v, e) => {
        if (v === null) return null;
        const warpUp = side === 'front' ? v === 1 : v === 0;
        const idx = warpUp ? d.warpColor[e] : d.weftColor[p];
        const c = d.palette[idx];
        return c ? c.hex : '#888';
      })
    );
  }

  /* ------------------------------------------------------------------ *
   * 周期（最小循环）
   * ------------------------------------------------------------------ */
  /** 一维序列在 [0, n) 上的最小周期 */
  function period1D(seq) {
    const n = seq.length;
    outer:
    for (let k = 1; k <= n; k++) {
      if (n % k !== 0) continue;
      for (let i = k; i < n; i++) {
        if (seq[i] !== seq[i - k]) continue outer;
      }
      return k;
    }
    return n;
  }

  /**
   * 组织循环：穿综/踩踏周期与组织图行列周期共同决定。
   * 返回 { warp, weft }，并附带是否含缺失格的标志。
   */
  function repeats(d, derived) {
    const threadingP = period1D(d.threading);
    const treadlingP = period1D(d.treadling);
    const warpColorP = period1D(d.warpColor);
    const weftColorP = period1D(d.weftColor);

    let drawWarp = d.ends, drawWeft = d.picks;
    let hasNull = false;
    const { drawdown } = derived;
    if (d.ends && d.picks) {
      hasNull = drawdown.some(row => row.some(v => v === null));
      // 行周期（经向/宽）：前 k 列决定所有列
      outerW:
      for (let k = 1; k <= d.ends; k++) {
        if (d.ends % k !== 0) continue;
        for (let p = 0; p < d.picks; p++)
          for (let e = k; e < d.ends; e++)
            if (drawdown[p][e] !== drawdown[p][e - k]) continue outerW;
        drawWarp = k;
        break;
      }
      // 列周期（纬向/高）
      outerH:
      for (let k = 1; k <= d.picks; k++) {
        if (d.picks % k !== 0) continue;
        for (let p = k; p < d.picks; p++)
          for (let e = 0; e < d.ends; e++)
            if (drawdown[p][e] !== drawdown[p - k][e]) continue outerH;
        drawWeft = k;
        break;
      }
    }
    const warp = lcm(lcm(threadingP, drawWarp), warpColorP);
    const weft = lcm(lcm(treadlingP, drawWeft), weftColorP);
    return {
      warp: Math.min(warp, d.ends),
      weft: Math.min(weft, d.picks),
      threadingP, treadlingP, drawWarp, drawWeft,
      warpColorP, weftColorP, hasNull,
    };
  }

  function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a || 1; }
  function lcm(a, b) { return Math.min(a, b) === 0 ? Math.max(a, b) : (a / gcd(a, b)) * b; }

  /* ------------------------------------------------------------------ *
   * 浮线检测
   *
   * 经浮长：同一经线连续「经在上」的根数（含跨过的纬线），沿纬向扫描。
   * 纬浮长：同一纬线上连续「纬在上」的根数（含跨过的经线），沿经向扫描。
   * 缺失格把连续段截断；首尾同色段在循环意义下合并。
   * ------------------------------------------------------------------ */
  function floats(d, derived) {
    const { drawdown } = derived;
    const P = d.picks, E = d.ends;
    const warpRuns = [];   // {end, start, length}
    const weftRuns = [];

    if (!P || !E) return { warpRuns, weftRuns, maxWarp: 0, maxWeft: 0 };

    // 经浮长：每列扫描（沿 p），值 === 1
    for (let e = 0; e < E; e++) {
      collectRuns(
        (p) => drawdown[p][e] === 1,
        (p) => drawdown[p][e] === null,
        P,
        (start, len) => {
          for (let k = 0; k < len; k++)
            warpRuns.push({ end: e, pick: (start + k) % P, start, length: len });
        }
      );
    }
    // 纬浮长：每行扫描（沿 e），值 === 0
    for (let p = 0; p < P; p++) {
      collectRuns(
        (e) => drawdown[p][e] === 0,
        (e) => drawdown[p][e] === null,
        E,
        (start, len) => {
          for (let k = 0; k < len; k++)
            weftRuns.push({ pick: p, end: (start + k) % E, start, length: len });
        }
      );
    }
    let maxWarp = 0, maxWeft = 0;
    warpRuns.forEach(r => { if (r.length > maxWarp) maxWarp = r.length; });
    weftRuns.forEach(r => { if (r.length > maxWeft) maxWeft = r.length; });
    return { warpRuns, weftRuns, maxWarp, maxWeft };
  }

  /**
   * 在长度 n 的环上收集 isOn=true 的连续段（每段只回调一次）。
   * isBroken 表示缺失点；任一格缺失则首尾不做循环合并。
   */
  function collectRuns(isOn, isBroken, n, cb) {
    let broken = false;
    for (let i = 0; i < n; i++) if (isBroken(i)) { broken = true; break; }

    const runs = [];
    let i = 0, start = -1;
    while (i < n) {
      if (isOn(i)) {
        if (start === -1) start = i;
      } else if (start !== -1) {
        runs.push([start, i - start]);
        start = -1;
      }
      i++;
    }
    if (start !== -1) runs.push([start, n - start]);

    if (!broken && runs.length >= 2) {
      const first = runs[0], last = runs[runs.length - 1];
      if (first[0] === 0 && last[0] + last[1] === n) {
        // 跨循环边界合并：合并段沿环行进，起点就是尾段起点（如 n=3 时
        // 首段 [0]、尾段 [2] 合并为长度 2 的段 [2,0]，起点为 2）。
        last[1] += first[1];
        runs.shift();
      }
    }
    for (const [s, len] of runs) cb(s, len);
  }

  /* ------------------------------------------------------------------ *
   * 校验
   * issue: { level:'error'|'warn', code, msg, loc:[{grid,r,c}...] }
   * ------------------------------------------------------------------ */
  function validate(d, derived, fl) {
    const issues = [];
    const { shafts, treadles, ends, picks } = d;

    // 1) 穿综越界
    const badEnds = [];
    d.threading.forEach((s, e) => {
      if (s < 0 || s >= shafts) badEnds.push(e);
    });
    if (badEnds.length) {
      issues.push({
        level: 'error', code: 'threading-range',
        msg: `${badEnds.length} 根经线穿综越界（综框号需在 1–${shafts} 之间）`,
        loc: badEnds.map(e => ({ grid: 'threading', r: -1, c: e })),
      });
    }

    // 2) 踩踏越界
    const badPicks = [];
    d.treadling.forEach((t, p) => {
      if (t < 0 || t >= treadles) badPicks.push(p);
    });
    if (badPicks.length) {
      issues.push({
        level: 'error', code: 'treadling-range',
        msg: `${badPicks.length} 纬踩踏越界（踏板号需在 1–${treadles} 之间）`,
        loc: badPicks.map(p => ({ grid: 'treadling', r: p, c: -1 })),
      });
    }

    // 3) 空踏板：联结为空（被踩到 -> error；完全没被踩到 -> warn）
    const usedT = new Set(d.treadling.filter(t => t >= 0 && t < treadles));
    for (let t = 0; t < treadles; t++) {
      const linked = d.tieup.some(row => row[t]);
      if (!linked) {
        const used = usedT.has(t);
        issues.push({
          level: used ? 'error' : 'warn',
          code: used ? 'empty-treadle-used' : 'empty-treadle',
          msg: used
            ? `踏板 ${t + 1} 无任何综框联结，但踩踏序列使用了它`
            : `踏板 ${t + 1} 联结为空（未与任何综框相连）`,
          loc: Array.from({ length: shafts }, (_, s) => ({ grid: 'tieup', r: s, c: t })),
        });
      }
    }

    // 4) 空综框：没有被任何经线穿入（有联结则提示）
    const usedShaft = new Set(d.threading.filter(s => s >= 0 && s < shafts));
    for (let s = 0; s < shafts; s++) {
      if (!usedShaft.has(s)) {
        const linked = d.tieup[s].some(Boolean);
        issues.push({
          level: linked ? 'warn' : 'warn',
          code: 'empty-shaft',
          msg: `综框 ${s + 1} 没有经线穿入${linked ? '（但存在联结）' : ''}`,
          loc: [],
        });
      }
    }

    // 5) 未交织经线：该列全部经在上或全部纬在上（需无缺失）
    for (let e = 0; e < ends; e++) {
      let up = 0, down = 0, nulls = 0;
      for (let p = 0; p < picks; p++) {
        const v = derived.drawdown[p][e];
        if (v === null) nulls++;
        else if (v === 1) up++;
        else down++;
      }
      if (nulls === 0 && up + down > 0 && (up === 0 || down === 0)) {
        issues.push({
          level: 'error', code: 'no-interlace-end',
          msg: up === 0
            ? `第 ${e + 1} 根经线全程沉在纬下，未形成交织`
            : `第 ${e + 1} 根经线全程浮在纬上，未形成交织`,
          loc: Array.from({ length: picks }, (_, p) => ({ grid: 'drawdown', r: p, c: e })),
        });
      }
    }

    // 6) 过长浮线
    const limit = d.maxFloat || 1;
    const longWarp = new Map(); // end -> 最长
    fl.warpRuns.forEach(run => {
      if (run.length > limit) {
        const prev = longWarp.get(run.end);
        if (!prev || run.length > prev.length) longWarp.set(run.end, run);
      }
    });
    longWarp.forEach((run, e) => {
      issues.push({
        level: 'error', code: 'long-warp-float',
        msg: `第 ${e + 1} 根经线存在 ${run.length} 根纬长的经浮长（限值 ${limit}）`,
        loc: Array.from({ length: Math.min(run.length, picks) },
          (_, k) => ({ grid: 'drawdown', r: (run.start + k) % picks, c: e })),
      });
    });
    const longWeft = new Map();
    fl.weftRuns.forEach(run => {
      if (run.length > limit) {
        const prev = longWeft.get(run.pick);
        if (!prev || run.length > prev.length) longWeft.set(run.pick, run);
      }
    });
    longWeft.forEach((run, p) => {
      issues.push({
        level: 'error', code: 'long-weft-float',
        msg: `第 ${p + 1} 纬存在 ${run.length} 根经长的纬浮长（限值 ${limit}）`,
        loc: Array.from({ length: Math.min(run.length, ends) },
          (_, k) => ({ grid: 'drawdown', r: p, c: (run.start + k) % ends })),
      });
    });

    const errors = issues.filter(i => i.level === 'error').length;
    const warns = issues.length - errors;
    return { issues, errors, warns };
  }

  /* ------------------------------------------------------------------ *
   * 统计
   * ------------------------------------------------------------------ */
  function stats(d, derived, fl, rep) {
    let points = 0, nulls = 0;
    for (const row of derived.drawdown)
      for (const v of row) { if (v === null) nulls++; else points++; }
    return {
      repeat: rep,
      maxWarpFloat: fl.maxWarp,
      maxWeftFloat: fl.maxWeft,
      interlacePoints: points,
      missing: nulls,
      density: points ? 0 : 0,
    };
  }

  /* ------------------------------------------------------------------ *
   * 两方案比较（对齐到 LCM 平铺后逐格比较）
   * ------------------------------------------------------------------ */
  function compare(a, b) {
    const da = derive(a), db = derive(b);
    const ra = repeats(a, da), rb = repeats(b, db);
    const fa = floats(a, da), fb = floats(b, db);

    const W = lcm(ra.warp, rb.warp), H = lcm(ra.weft, rb.weft);
    let diffs = 0, total = 0, capReached = false;
    const MAX = 400; // 限制采样规模
    const cw = Math.min(W, MAX), ch = Math.min(H, MAX);
    if (W > MAX || H > MAX) capReached = true;
    const gridA = [], gridB = [];
    for (let p = 0; p < ch; p++) {
      const raRow = [], rbRow = [];
      for (let e = 0; e < cw; e++) {
        const va = da.drawdown[p % a.picks] ? da.drawdown[p % a.picks][e % a.ends] : null;
        const vb = db.drawdown[p % b.picks] ? db.drawdown[p % b.picks][e % b.ends] : null;
        raRow.push(va); rbRow.push(vb);
        total++;
        if (va !== vb) diffs++;
      }
      gridA.push(raRow); gridB.push(rbRow);
    }

    return {
      repeatA: ra, repeatB: rb,
      floatA: { warp: fa.maxWarp, weft: fa.maxWeft },
      floatB: { warp: fb.maxWarp, weft: fb.maxWeft },
      lcm: { w: W, h: H },
      diffs, total,
      diffRate: total ? diffs / total : 0,
      capReached,
      sampleW: cw, sampleH: ch,
      gridA, gridB,
      paletteA: a.palette, warpColorA: a.warpColor, weftColorA: a.weftColor,
      paletteB: b.palette, warpColorB: b.warpColor, weftColorB: b.weftColor,
    };
  }

  function analyze(d) {
    const derived = derive(d);
    const fl = floats(d, derived);
    const rep = repeats(d, derived);
    const val = validate(d, derived, fl);
    const st = stats(d, derived, fl, rep);
    return { derived, fl, rep, validation: val, stats: st };
  }

  return {
    PALETTE, defaultDraft, blankDraft, cloneDraft, resize,
    derive, colorGrid, repeats, floats, validate, stats, compare, analyze,
    period1D, gcd, lcm,
  };
})();

if (typeof module !== 'undefined') module.exports = { Engine };
