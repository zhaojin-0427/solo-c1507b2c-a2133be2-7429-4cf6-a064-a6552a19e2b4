/* =====================================================================
 * loom-core.js — 上机工艺单：纯逻辑核心（不依赖 DOM）
 *
 * 由草稿快照 + 工艺参数推算：
 *   整经根数（按组织与色带循环取整）、上机筘幅、经纱长度、预计纬数、分色用纱量；
 *   针对目标上机经密搜索每筘 1–4 根的重复穿筘序列（按密度误差与分布均匀度排序）；
 *   把经纱色序 / 穿综 / 穿筘指令压缩为连续区段步骤（可展开到每根经线）。
 *
 * 参数口径：
 *   finishWidth / finishLength  成品宽 / 长（cm）
 *   warpShrink / weftShrink     经向 / 纬向缩率（%）：经向影响长度，纬向影响宽度
 *   warpDensity / weftDensity   目标成品密度（根/cm）
 *   reedDents                   筘齿密度（筘/cm）
 *   wasteFront / wasteBack      前 / 后废纱（cm）
 *   yarnGpm                     各色号单位长度重量（g/m，按色号索引）
 *
 * 上机经密 = 成品经密 × (1 − 纬缩/100)；上机筘幅 = 整经根数 ÷ 上机经密；
 * 经纱长度 = 成品长 ÷ (1 − 经缩/100) + 前废纱 + 后废纱；
 * 纬纱每纬长度按上机筘幅计。
 * ===================================================================== */
'use strict';

const LoomCore = (() => {

  function clampNum(v, lo, hi, dflt) {
    v = Number(v);
    if (!Number.isFinite(v)) return dflt;
    return Math.max(lo, Math.min(hi, v));
  }

  /* ------------------------------- 参数规整 ---------------------------- */
  function normalizeParams(p) {
    p = p || {};
    return {
      finishWidth: clampNum(p.finishWidth, 1, 1000, 40),
      finishLength: clampNum(p.finishLength, 1, 100000, 200),
      warpShrink: clampNum(p.warpShrink, 0, 90, 8),
      weftShrink: clampNum(p.weftShrink, 0, 90, 8),
      warpDensity: clampNum(p.warpDensity, 0.1, 200, 10),
      weftDensity: clampNum(p.weftDensity, 0.1, 200, 10),
      reedDents: clampNum(p.reedDents, 0.5, 100, 5),
      wasteFront: clampNum(p.wasteFront, 0, 2000, 30),
      wasteBack: clampNum(p.wasteBack, 0, 2000, 30),
      yarnGpm: Array.isArray(p.yarnGpm) ? p.yarnGpm.slice() : [],
    };
  }

  /** 各色号单位长度重量（g/m），缺省 0.05 g/m（≈50 tex） */
  function normalizeYarnGpm(arr, n) {
    const out = [];
    for (let i = 0; i < n; i++) out[i] = clampNum(arr && arr[i], 0.001, 10, 0.05);
    return out;
  }

  /** 上机（筘上）经密：成品经密按纬向缩率还原 */
  function loomWarpDensity(q) {
    return q.warpDensity * (1 - q.weftShrink / 100);
  }

  /* ------------------------------- 主推算 ------------------------------ */
  /**
   * 结合组织与色带循环推算工艺单数值。
   * 返回：
   * {
   *   params, gpm, repeatWarp, repeatWeft, threadingP, warpColorP,
   *   rawEnds, totalEnds, endsAdjusted,
   *   loomDensity, reedWidthCm, warpLengthCm, warpLengthM, estPicks,
   *   warpColors: [{color,name,hex,ends,lengthM,grams}],
   *   weftColors: [{color,name,hex,picks,lengthM,grams}],
   *   totalWarpGrams, totalWeftGrams, totalGrams,
   * }
   */
  function derivePlan(Engine, snapshot, params) {
    const q = normalizeParams(params);
    const palette = snapshot.palette || [];
    const gpm = normalizeYarnGpm(q.yarnGpm, palette.length);
    const derived = Engine.derive(snapshot);
    const rep = Engine.repeats(snapshot, derived);
    const rw = Math.max(1, rep.warp);    // 经向循环（穿综 × 组织 × 色经）
    const rf = Math.max(1, rep.weft);

    // 整经根数：成品宽 × 目标经密，向上取整到经向循环的整数倍
    const rawEnds = q.finishWidth * q.warpDensity;
    const totalEnds = Math.max(rw, Math.ceil(rawEnds / rw - 1e-9) * rw);

    const loomDensity = loomWarpDensity(q);
    const reedWidthCm = loomDensity > 0 ? totalEnds / loomDensity : 0;
    const warpLengthCm =
      q.finishLength / Math.max(0.05, 1 - q.warpShrink / 100) + q.wasteFront + q.wasteBack;
    const warpLengthM = warpLengthCm / 100;
    const reedWidthM = reedWidthCm / 100;
    const estPicks = Math.max(0, Math.round(q.finishLength * q.weftDensity));

    // 分色经纱：totalEnds 为 rw 整数倍，rw 已含色经周期
    const warpColors = [];
    const weftColors = [];
    const wc = snapshot.warpColor || [];
    const fc = snapshot.weftColor || [];
    const wcp = Math.max(1, rep.warpColorP || 1);
    const fcp = Math.max(1, rep.weftColorP || 1);
    const warpRepeats = totalEnds / rw;

    const wCount = new Map();
    for (let e = 0; e < rw; e++) {
      const c = wc[e % wc.length] | 0;
      wCount.set(c, (wCount.get(c) || 0) + 1);
    }
    let totalWarpGrams = 0;
    [...wCount.keys()].sort((a, b) => a - b).forEach(c => {
      const ends = (wCount.get(c) || 0) * warpRepeats;
      const lengthM = ends * warpLengthM;
      const grams = lengthM * (gpm[c] != null ? gpm[c] : 0.05);
      totalWarpGrams += grams;
      const pal = palette[c] || {};
      warpColors.push({
        color: c, name: pal.name || `色号${c + 1}`, hex: pal.hex || '#888',
        ends, lengthM, grams,
      });
    });

    // 分色纬纱：整循环 × 整倍数 + 余数按循环序分配
    const fCount = new Map();
    const fullCycles = Math.floor(estPicks / rf);
    const rem = estPicks % rf;
    for (let p = 0; p < rf; p++) {
      const c = fc[p % fc.length] | 0;
      const add = fullCycles + (p < rem ? 1 : 0);
      fCount.set(c, (fCount.get(c) || 0) + add);
    }
    let totalWeftGrams = 0;
    [...fCount.keys()].sort((a, b) => a - b).forEach(c => {
      const picks = fCount.get(c) || 0;
      const lengthM = picks * reedWidthM;
      const grams = lengthM * (gpm[c] != null ? gpm[c] : 0.05);
      totalWeftGrams += grams;
      const pal = palette[c] || {};
      weftColors.push({
        color: c, name: pal.name || `色号${c + 1}`, hex: pal.hex || '#888',
        picks, lengthM, grams,
      });
    });

    return {
      params: q, gpm,
      repeatWarp: rw, repeatWeft: rf,
      threadingP: Math.max(1, rep.threadingP || 1),
      warpColorP: wcp, weftColorP: fcp,
      rawEnds, totalEnds, endsAdjusted: totalEnds - Math.round(rawEnds),
      loomDensity, reedWidthCm, reedWidthM,
      warpLengthCm, warpLengthM, estPicks,
      warpColors, weftColors,
      totalWarpGrams, totalWeftGrams,
      totalGrams: totalWarpGrams + totalWeftGrams,
    };
  }

  /* ------------------------------- 穿筘方案搜索 ------------------------ */
  /** n 筘共 m 根的最均匀填充序列（Bresenham 均布，值域 1–4） */
  function dentSequence(n, m) {
    const base = Math.floor(m / n);
    const extra = m - base * n;
    const seq = [];
    for (let i = 0; i < n; i++) {
      seq.push(base + Math.floor((i + 1) * extra / n) - Math.floor(i * extra / n));
    }
    return seq;
  }

  /** 分布均匀度：前缀和相对理想直线的最大偏差（越小越均匀） */
  function discrepancy(seq) {
    const avg = seq.reduce((s, v) => s + v, 0) / seq.length;
    let maxDev = 0, sum = 0;
    for (let i = 0; i < seq.length; i++) {
      sum += seq[i];
      const dev = Math.abs(sum - (i + 1) * avg);
      if (dev > maxDev) maxDev = dev;
    }
    return maxDev;
  }

  /** 序列最小循环节长度（用于剔除非本原序列） */
  function minPeriodLen(seq) {
    const n = seq.length;
    outer:
    for (let k = 1; k <= n; k++) {
      if (n % k !== 0) continue;
      for (let i = k; i < n; i++) if (seq[i] !== seq[i - k]) continue outer;
      return k;
    }
    return n;
  }

  /**
   * 针对目标平均每筘根数搜索重复穿筘序列（每筘 1–4 根，循环 ≤ maxLen 筘）。
   * 按 密度误差 → 分布均匀度 → 循环长度 排序，返回前 6 个候选。
   * { target, exact, plans: [{seq, dents, ends, avg, err, disc}] }
   */
  function searchReedPlans(target, maxLen = 8, maxPerDent = 4) {
    const t = clampNum(target, 0.01, 100, 2);
    const cands = [];
    const seen = new Set();
    for (let n = 1; n <= maxLen; n++) {
      for (let m = n; m <= maxPerDent * n; m++) {
        const seq = dentSequence(n, m);
        if (minPeriodLen(seq) < n) continue;   // 更短循环已覆盖
        const key = seq.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const avg = m / n;
        cands.push({ seq, dents: n, ends: m, avg, err: Math.abs(avg - t), disc: discrepancy(seq) });
      }
    }
    cands.sort((a, b) => a.err - b.err || a.disc - b.disc || a.dents - b.dents);
    const plans = cands.slice(0, 6);
    const exact = plans.length > 0 && plans[0].err < 1e-9;
    return { target: t, exact, plans };
  }

  const fmt2 = (v) => String(Math.round(v * 100) / 100);

  /**
   * 无法精确匹配时的偏差说明；精确时返回 null。
   * 偏差换算：每筘平均差 × 筘齿密度 = 上机经密偏差（根/cm）。
   */
  function reedNote(search, reedDents) {
    if (!search || search.exact || !search.plans.length) return null;
    const best = search.plans[0];
    const signed = (best.avg - search.target) * reedDents;
    const pct = search.target > 0 ? (best.avg - search.target) / search.target * 100 : 0;
    const dir = signed > 0 ? '偏高' : '偏低';
    return `目标平均每筘 ${fmt2(search.target)} 根无法由每筘 1–4 根、≤8 筘的循环精确实现；` +
      `最接近方案 [${best.seq.join(' ')}] 平均 ${fmt2(best.avg)} 根/筘，` +
      `上机经密${dir} ${fmt2(Math.abs(signed))} 根/cm（约 ${Math.abs(pct).toFixed(1)}%）。`;
  }

  /* ------------------------------- 步骤生成 ---------------------------- */
  /** 穿筘逐筘展开：dent 序号（1 基）、覆盖经线区段、是否满筘 */
  function dentWalk(totalEnds, seq) {
    const rows = [];
    let cur = 0, d = 0;
    const L = Math.max(1, seq.length);
    while (cur < totalEnds) {
      const want = seq[d % L];
      const take = Math.min(want, totalEnds - cur);
      rows.push({ dent: d + 1, from: cur + 1, to: cur + take, take, full: take === want });
      cur += take;
      d++;
    }
    return rows;
  }

  /**
   * 生成操作步骤（连续区段压缩）：
   *   ① 整经色序：经纱色带循环平铺到整经根数后按同色连续段压缩；
   *      段数过多（交替 / 细小花型）时退化为一段“色序循环”指令，
   *      避免每根经线各成一步；
   *   ② 穿综：穿综最小循环平铺，整幅为一段循环指令；
   *   ③ 穿筘：所选穿筘序列循环，整幅一段（末筘不足单独注明）。
   * 步骤：{ index, kind:'warp'|'thread'|'dent', label, detail:{from,to,…} }
   */
  /** 整经 RLE 段数上限：超过则改用色序循环段（交替色经每根一段会爆步骤数） */
  const WARP_RLE_MAX = 64;

  function buildSteps(snapshot, plan, reedSeq) {
    const E = plan.totalEnds;
    const palette = snapshot.palette || [];
    const wc = snapshot.warpColor || [];
    const steps = [];

    // ① 整经色序段
    const wcp = Math.max(1, plan.warpColorP || 1);
    const colorAt = (e) => (wc.length ? wc[e % wc.length] : 0) | 0;
    const colorName = (c) => `${c + 1}${(palette[c] || {}).name || ''}`;
    // 同色连续段（0 基闭区间）
    const rleSegs = [];
    let start = 0;
    for (let e = 1; e <= E; e++) {
      const cur = e < E ? colorAt(e) : -1;
      if (cur !== colorAt(start)) {
        rleSegs.push([start, e - 1]);
        start = e;
      }
    }
    if (rleSegs.length <= WARP_RLE_MAX || wcp >= E) {
      // 段数不多（条带 / 大块色），或整幅无更小周期：按连续段
      rleSegs.forEach(([s0, e0]) => {
        const c = colorAt(s0);
        const from = s0 + 1, to = e0 + 1;
        steps.push({
          kind: 'warp',
          label: `整经：第 ${from}–${to} 根 · 色号${colorName(c)} ×${to - from + 1} 根`,
          detail: { from, to, color: c, count: to - from + 1 },
        });
      });
    } else {
      // 交替 / 细小花型：整幅一段色序循环（E 必为色经周期整数倍）
      const cycle = [];
      for (let i = 0; i < wcp; i++) cycle.push(colorAt(i));
      const times = Math.round(E / wcp);
      const cycShow = cycle.length > 12
        ? cycle.slice(0, 12).map(colorName).join(' ') + ' …'
        : cycle.map(colorName).join(' ');
      steps.push({
        kind: 'warp',
        label: `整经：第 1–${E} 根 · 色序循环 [${cycShow}] ×${times} 次`,
        detail: { from: 1, to: E, cycle, times },
      });
    }

    // ② 穿综段（最小循环平铺；不规则穿综的循环节即整幅草稿）
    const tp = Math.max(1, plan.threadingP || 1);
    const cycle = (snapshot.threading || []).slice(0, tp);
    const times = Math.round(E / tp);
    const cycShow = cycle.length > 12
      ? cycle.slice(0, 12).map(v => v + 1).join(' ') + ' …'
      : cycle.map(v => v + 1).join(' ');
    steps.push({
      kind: 'thread',
      label: `穿综：第 1–${E} 根 · 循环 [${cycShow}] ×${times} 次`,
      detail: { from: 1, to: E, cycle, times },
    });

    // ③ 穿筘段
    const seq = (reedSeq && reedSeq.length ? reedSeq : [1]).map(v =>
      Math.max(1, Math.min(4, Math.round(v))));
    const rows = dentWalk(E, seq);
    const last = rows[rows.length - 1];
    const lastPartial = last && !last.full ? last.take : null;
    steps.push({
      kind: 'dent',
      label: `穿筘：第 1–${E} 根 · 每筘 [${seq.join(' ')}] 循环，共 ${rows.length} 筘` +
        (lastPartial ? `（末筘 ${lastPartial} 根）` : ''),
      detail: { from: 1, to: E, seq, dents: rows.length, lastPartial },
    });

    steps.forEach((s, i) => { s.index = i; });
    return steps;
  }

  /* ------------------------------- 指纹 -------------------------------- */
  /** 快照 + 工艺参数指纹：用于识别“草稿或参数已变化”（原单不改写） */
  function fingerprint(snapshot, params) {
    const q = normalizeParams(params);
    const gpm = normalizeYarnGpm(q.yarnGpm, (snapshot.palette || []).length);
    return JSON.stringify([
      snapshot.shafts, snapshot.treadles, snapshot.ends, snapshot.picks,
      snapshot.threading, snapshot.treadling,
      (snapshot.tieup || []).map(r => r.map(v => (v ? 1 : 0))),
      snapshot.warpColor, snapshot.weftColor,
      q.finishWidth, q.finishLength, q.warpShrink, q.weftShrink,
      q.warpDensity, q.weftDensity, q.reedDents, q.wasteFront, q.wasteBack,
      gpm,
    ]);
  }

  return {
    normalizeParams, normalizeYarnGpm, loomWarpDensity,
    derivePlan,
    dentSequence, discrepancy, minPeriodLen, searchReedPlans, reedNote,
    dentWalk, buildSteps, WARP_RLE_MAX,
    fingerprint,
  };
})();

if (typeof module !== 'undefined') module.exports = { LoomCore };
if (typeof window !== 'undefined') window.LoomCore = LoomCore;
