/* =====================================================================
 * reed-core.js — 分区变筘：纯逻辑核心（不依赖 DOM）
 *
 * 把整幅统一穿筘扩展为分区变筘：
 *   区段 zone = { from, to,               经线范围（1 基闭区间）
 *                 targetDensity,          目标上机经密（根/cm）
 *                 maxPerDent,             每筘上限 1–4 根（0 根 = 空筘）
 *                 maxEmptyRun,            连续空筘上限
 *                 mirror,                 中心镜像（区段内筘序列回文）
 *                 locked,                 锁定（布边 / 已确认区段）
 *                 fixedSeq }              锁定时的固定筘序列
 *
 * 边界校正：区段边界吸附到 lcm(穿综周期, 色经周期) 的整数倍；
 * 锁定区段的边界不动。
 *
 * 搜索：逐区段生成候选筘序列（Bresenham 均布 / 回文构造，0–4 根/筘，
 * 连续空筘受限），再组合为整幅序列，按
 *   各段密度误差 → 总筘数 → 空筘数 → 改动量（对比基线方案的经线级差异）
 * 排序。
 *
 * 校验：漏穿 / 重穿 / 跨区段筘 / 每筘超限 / 区段宽度偏差 / 空筘超限 /
 * 镜像破坏。与服务端 app.py 的 check_zoned_plan 同口径。
 * ===================================================================== */
'use strict';

const ReedCore = (() => {

  function clampInt(v, lo, hi, dflt) {
    v = parseInt(v, 10);
    if (!Number.isFinite(v)) return dflt;
    return Math.max(lo, Math.min(hi, v));
  }
  function clampNum(v, lo, hi, dflt) {
    v = Number(v);
    if (!Number.isFinite(v)) return dflt;
    return Math.max(lo, Math.min(hi, v));
  }
  function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a || 1; }
  function lcm(a, b) { return (a / gcd(a, b)) * b; }

  /* ------------------------------- 区段规整 ---------------------------- */
  /** 边界校正单位：穿综周期与色经周期的最小公倍数（根） */
  function alignUnit(threadingP, warpColorP) {
    return Math.max(1, lcm(Math.max(1, threadingP | 0), Math.max(1, warpColorP | 0)));
  }

  /** 默认区段规格（整幅一段，等价于统一穿筘的入口） */
  function defaultSpec(targetDensity, from, to) {
    return {
      from: from | 0, to: to | 0,
      targetDensity: clampNum(targetDensity, 0.1, 200, 10),
      maxPerDent: 4, maxEmptyRun: 0,
      mirror: false, locked: false,
    };
  }

  function sanitizeZone(z) {
    if (!z || typeof z !== 'object') return null;
    const from = Number.isInteger(z.from) ? z.from : NaN;
    const to = Number.isInteger(z.to) ? z.to : NaN;
    if (!(from >= 1) || !(to >= from)) return null;
    const out = {
      from, to,
      targetDensity: clampNum(z.targetDensity, 0.1, 200, 10),
      maxPerDent: clampInt(z.maxPerDent, 1, 4, 4),
      maxEmptyRun: clampInt(z.maxEmptyRun, 0, 64, 0),
      mirror: !!z.mirror,
      locked: !!z.locked,
    };
    if (Array.isArray(z.fixedSeq) && z.fixedSeq.length) {
      out.fixedSeq = z.fixedSeq.map(v => clampInt(v, 0, 4, 0));
    }
    return out;
  }

  /**
   * 规整区段列表：排序、去重叠（后者截断）、缺口以默认段补齐、
   * 钳制到 [1, totalEnds]，保证连续覆盖整幅。
   */
  function normalizeZones(zones, totalEnds, dfltDensity) {
    const E = Math.max(1, totalEnds | 0);
    const zs = (Array.isArray(zones) ? zones : [])
      .map(sanitizeZone)
      .filter(z => z && z.to >= 1 && z.from <= E)
      .map(z => ({ ...z, from: Math.max(1, z.from), to: Math.min(E, z.to) }))
      .sort((a, b) => a.from - b.from);
    const out = [];
    let expect = 1;
    for (const z of zs) {
      const from = Math.max(z.from, expect);
      if (z.to < from) continue;              // 完全被前段覆盖
      if (from > expect) out.push(defaultSpec(dfltDensity, expect, from - 1));
      out.push({ ...z, from });
      expect = z.to + 1;
    }
    if (expect <= E) out.push(defaultSpec(dfltDensity, expect, E));
    if (!out.length) out.push(defaultSpec(dfltDensity, 1, E));
    return out;
  }

  /**
   * 边界校正：把未锁定的区段边界吸附到 alignUnit 的整数倍。
   * 锁定区段的边界不动。返回移动记录 [{boundary, snapped}]。
   */
  function correctBoundaries(zones, unit, totalEnds) {
    const u = Math.max(1, unit | 0);
    const E = Math.max(1, totalEnds | 0);
    const moved = [];
    for (let i = 0; i < zones.length - 1; i++) {
      const a = zones[i], b = zones[i + 1];
      if (a.locked || b.locked) continue;
      const boundary = a.to;
      const snapped = Math.round(boundary / u) * u;
      const nb = Math.max(a.from, Math.min(b.to - 1, Math.min(E - 1, snapped)));
      if (nb !== boundary && nb >= 1) {
        a.to = nb;
        b.from = nb + 1;
        moved.push({ boundary, snapped: nb });
      }
    }
    return moved;
  }

  /**
   * 在经线尺上拖出新区段：从现有区段中挖出 [a, b]（1 基闭区间），
   * 插入 spec 指定的新区段。锁定区段不被挖除；拖选范围被锁定段
   * 截断，完全落入锁定段时返回 null。
   */
  function carveZone(zones, a, b, spec) {
    let A = Math.min(a, b), B = Math.max(a, b);
    for (const z of zones) {
      if (!z.locked) continue;
      if (z.to < A || z.from > B) continue;
      if (z.from <= A && z.to >= B) return null;         // 完全落入锁定段
      if (z.from > A && z.to < B) return null;           // 跨过锁定段
      if (z.from > A) B = Math.min(B, z.from - 1);
      else A = Math.max(A, z.to + 1);
    }
    if (A > B) return null;
    const out = [];
    for (const z of zones) {
      if (z.to < A || z.from > B) { out.push(z); continue; }
      if (z.from < A) out.push({ ...z, to: A - 1 });
      if (z.to > B) out.push({ ...z, from: B + 1 });
    }
    const nz = sanitizeZone({ ...spec, from: A, to: B, locked: false });
    delete nz.fixedSeq;
    out.push(nz);
    out.sort((x, y) => x.from - y.from);
    return out;
  }

  /* ------------------------------- 序列构造 ---------------------------- */
  /**
   * m 根经线填入 n 筘的最均匀序列（Bresenham 均布，每筘 0–cap 根）。
   * m > n×cap 时不可行，返回 null。
   */
  function dentSeq(m, n, cap) {
    if (n <= 0) return m === 0 ? [] : null;
    if (m < 0 || m > n * cap) return null;
    const base = Math.floor(m / n);
    const extra = m - base * n;
    const seq = [];
    for (let i = 0; i < n; i++) {
      seq.push(base + Math.floor((i + 1) * extra / n) - Math.floor(i * extra / n));
    }
    return seq;
  }

  /**
   * 中心镜像序列（回文）：n 偶 → m 必须为偶，两半互为镜像；
   * n 奇 → 中间筘吸收奇偶差。中心值取最接近平均值的可行解。
   */
  function mirrorSeq(m, n, cap) {
    if (m < 0 || m > n * cap) return null;
    if (n === 1) return m <= cap ? [m] : null;
    if (n % 2 === 0) {
      if (m % 2 !== 0) return null;
      const half = dentSeq(m / 2, n / 2, cap);
      return half ? half.concat(half.slice().reverse()) : null;
    }
    const halfN = (n - 1) / 2;
    const ideal = m / n;
    for (let dc = 0; dc <= cap + 1; dc++) {
      for (const c of [Math.round(ideal) + dc, Math.round(ideal) - dc]) {
        if (c < 0 || c > cap || (m - c) % 2 !== 0) continue;
        const hm = (m - c) / 2;
        if (hm < 0 || hm > halfN * cap) continue;
        const half = dentSeq(hm, halfN, cap);
        if (half) return half.concat([c], half.slice().reverse());
      }
    }
    return null;
  }

  /** 最长连续空筘（0）数 */
  function maxZeroRun(seq) {
    let best = 0, run = 0;
    for (const v of seq) {
      run = v === 0 ? run + 1 : 0;
      if (run > best) best = run;
    }
    return best;
  }

  /** 分布均匀度：前缀和相对理想直线的最大偏差 */
  function discrepancy(seq) {
    if (!seq.length) return 0;
    const avg = seq.reduce((s, v) => s + v, 0) / seq.length;
    let maxDev = 0, sum = 0;
    for (let i = 0; i < seq.length; i++) {
      sum += seq[i];
      const dev = Math.abs(sum - (i + 1) * avg);
      if (dev > maxDev) maxDev = dev;
    }
    return maxDev;
  }

  /* ------------------------------- 区段候选 ---------------------------- */
  /**
   * 单个区段的候选筘序列。
   * 目标平均每筘 target = targetDensity ÷ reedDents（根/筘）；
   * 在理想筘数附近 ±4 筘窗口内构造（镜像段用回文构造），
   * 过滤连续空筘超限，按 误差 → 均匀度 → 空筘数 → 筘数 排序。
   */
  function zoneCandidates(len, spec, reedDents, maxCands = 4) {
    const cap = clampInt(spec.maxPerDent, 1, 4, 4);
    const maxEmpty = clampInt(spec.maxEmptyRun, 0, 64, 0);
    const rd = Math.max(0.01, clampNum(reedDents, 0.01, 100, 5));
    const target = clampNum((spec.targetDensity || 0) / rd, 0.05, cap, Math.min(2, cap));
    const nStar = len / target;
    const nMin = Math.max(1, Math.ceil(len / cap - 1e-9));
    // 筘数硬上限：非空筘至少 nMin 个，空筘受连续上限约束
    const nAbsMax = maxEmpty === 0 ? len : len + maxEmpty * (nMin + 1);
    const lo = Math.max(nMin, Math.floor(nStar - 4));
    const hi = Math.min(nAbsMax, Math.ceil(nStar + 4));
    const out = [];
    const seen = new Set();
    for (let n = lo; n <= hi; n++) {
      const seq = spec.mirror ? mirrorSeq(len, n, cap) : dentSeq(len, n, cap);
      if (!seq || !seq.length) continue;
      if (maxZeroRun(seq) > maxEmpty) continue;
      const key = seq.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        seq, dents: n, ends: len, avg: len / n,
        err: Math.abs(len / n - target),
        disc: discrepancy(seq),
        empty: seq.reduce((s, v) => s + (v === 0 ? 1 : 0), 0),
      });
    }
    out.sort((a, b) => a.err - b.err || a.disc - b.disc || a.empty - b.empty || a.dents - b.dents);
    return { target, cands: out.slice(0, maxCands) };
  }

  /* ------------------------------- 整幅展开 ---------------------------- */
  /**
   * 逐筘走查：dents[i] = 第 i+1 筘根数（0 = 空筘）。
   * 返回 [{dent, from, to, take, empty}]（经线号 1 基，含 endOffset）。
   */
  function dentWalkFull(dents, endOffset = 0, dentOffset = 0) {
    const rows = [];
    let cur = 0;
    for (let i = 0; i < dents.length; i++) {
      const take = Math.max(0, dents[i] | 0);
      rows.push({
        dent: dentOffset + i + 1,
        from: endOffset + cur + 1,
        to: endOffset + cur + take,
        take, empty: take === 0,
      });
      cur += take;
    }
    return rows;
  }

  /** 每根经线（0 基）所在的筘号（0 基） */
  function endToDentArr(dents) {
    const arr = [];
    for (let i = 0; i < dents.length; i++) {
      for (let k = 0; k < dents[i]; k++) arr.push(i);
    }
    return arr;
  }

  /** 改动量：两方案下筘号不同的经线根数（按整幅展开对比） */
  function changesVs(dentsNew, dentsBase) {
    if (!Array.isArray(dentsBase) || !dentsBase.length) return 0;
    const a = endToDentArr(dentsNew), b = endToDentArr(dentsBase);
    const n = Math.max(a.length, b.length);
    let diff = 0;
    for (let e = 0; e < n; e++) {
      if ((e < a.length ? a[e] : -1) !== (e < b.length ? b[e] : -1)) diff++;
    }
    return diff;
  }

  /** 统一穿筘序列（循环）展开为整幅逐筘数组（末筘可不足） */
  function uniformDents(totalEnds, seq) {
    const out = [];
    const L = Math.max(1, (seq && seq.length) ? seq.length : 1);
    let cur = 0, d = 0;
    const E = Math.max(0, totalEnds | 0);
    while (cur < E) {
      const want = Math.max(1, seq && seq.length ? seq[d % L] : 1);
      const take = Math.min(want, E - cur);
      out.push(take);
      cur += take;
      d++;
    }
    return out;
  }

  /** 各区段占用的筘号区间（0 基闭区间）：按区段经线长度顺序走筘 */
  function zoneDentRanges(zones, dents) {
    const ranges = [];
    let di = 0;
    for (const z of zones) {
      const len = z.to - z.from + 1;
      let covered = 0;
      const d0 = di;
      while (covered < len && di < dents.length) { covered += Math.max(0, dents[di] | 0); di++; }
      ranges.push({ d0, d1: di - 1, covered });
    }
    return ranges;
  }

  /** 截取区段在整幅筘序列中的子序列 */
  function sliceZoneSeq(dents, zones, zi) {
    const ranges = zoneDentRanges(zones, dents);
    const r = ranges[zi];
    return r ? dents.slice(r.d0, r.d1 + 1) : [];
  }

  /* ------------------------------- 区段指标 ---------------------------- */
  /**
   * 逐区段指标：筘数 / 覆盖根数 / 平均根每筘 / 实际经密 / 密度误差 /
   * 实际上机宽 / 目标宽 / 宽度偏差 / 空筘数 / 覆盖差（>0 重穿，<0 漏穿）。
   */
  function zoneMetrics(zones, dents, reedDents) {
    const rd = Math.max(0.01, clampNum(reedDents, 0.01, 100, 5));
    const ranges = zoneDentRanges(zones, dents);
    return zones.map((z, zi) => {
      const len = z.to - z.from + 1;
      const r = ranges[zi];
      const n = r ? r.d1 - r.d0 + 1 : 0;
      const covered = r ? r.covered : 0;
      let empty = 0;
      for (let i = r ? r.d0 : 0; i <= (r ? r.d1 : -1); i++) if (dents[i] === 0) empty++;
      const avg = n > 0 ? covered / n : 0;
      const density = avg * rd;
      const target = z.targetDensity || 0;
      const idealWidthCm = target > 0 ? len / target : 0;
      const widthCm = n / rd;
      return {
        zone: zi, from: z.from, to: z.to, len,
        dents: n, ends: covered, empty,
        avg, density, err: density - target,
        widthCm, idealWidthCm, devCm: widthCm - idealWidthCm,
        over: covered - len,
      };
    });
  }

  /* ------------------------------- 整幅搜索 ---------------------------- */
  /**
   * 搜索整幅穿筘序列候选。
   * zones 需已规整（连续覆盖）；锁定区段使用 fixedSeq 作为唯一候选。
   * 返回 { ok, zone?, plans: [{seq, zoneSeqs, metrics, densityErr,
   *   totalDents, emptyDents, changes}] }；某区段无可行序列时 ok=false。
   */
  function searchZonedPlans(zones, reedDents, baselineDents, opts = {}) {
    const maxCombos = opts.maxCombos || 48;
    const topK = opts.topK || 6;
    const rd = Math.max(0.01, clampNum(reedDents, 0.01, 100, 5));
    const perZone = zones.map(z => {
      const len = z.to - z.from + 1;
      if (z.locked && Array.isArray(z.fixedSeq) && z.fixedSeq.length) {
        const seq = z.fixedSeq.map(v => clampInt(v, 0, 4, 0));
        return {
          locked: true,
          cands: [{
            seq, dents: seq.length, ends: len, avg: len / seq.length,
            err: 0, disc: discrepancy(seq),
            empty: seq.reduce((s, v) => s + (v === 0 ? 1 : 0), 0),
          }],
        };
      }
      const { cands } = zoneCandidates(len, z, rd, 3);
      return { locked: false, cands };
    });
    const badZone = perZone.findIndex(p => !p.cands.length);
    if (badZone >= 0) return { ok: false, zone: badZone, plans: [] };

    // 组合规模控制：超出上限时逐步缩减候选最多的未锁区段
    const sizes = perZone.map(p => p.cands.length);
    const total = () => sizes.reduce((a, b) => a * b, 1);
    while (total() > maxCombos) {
      let best = -1, bestSize = 1;
      sizes.forEach((s, i) => {
        if (!perZone[i].locked && s > bestSize) { bestSize = s; best = i; }
      });
      if (best < 0) break;
      sizes[best] = Math.max(1, sizes[best] - 1);
    }

    const plans = [];
    const idx = new Array(zones.length).fill(0);
    for (;;) {
      const zoneSeqs = idx.map((ci, zi) => perZone[zi].cands[ci]);
      const seq = [];
      zoneSeqs.forEach(c => { for (const v of c.seq) seq.push(v); });
      const metrics = zoneMetrics(zones, seq, rd);
      const densityErr = metrics.reduce((s, m) => s + Math.abs(m.err), 0);
      plans.push({
        seq, zoneSeqs: zoneSeqs.map(c => c.seq.slice()),
        metrics, densityErr,
        totalDents: seq.length,
        emptyDents: seq.reduce((s, v) => s + (v === 0 ? 1 : 0), 0),
        changes: changesVs(seq, baselineDents),
      });
      let p = zones.length - 1;
      while (p >= 0) {
        idx[p]++;
        if (idx[p] < sizes[p]) break;
        idx[p] = 0;
        p--;
      }
      if (p < 0) break;
    }
    plans.sort((a, b) =>
      (a.densityErr - b.densityErr) || (a.totalDents - b.totalDents) ||
      (a.emptyDents - b.emptyDents) || (a.changes - b.changes));
    return { ok: true, plans: plans.slice(0, topK) };
  }

  /* ------------------------------- 校验 -------------------------------- */
  /**
   * 定位穿筘问题。issue: { code, level, zone, dent, endFrom, endTo, msg }
   *   miss      漏穿（区段未覆盖 / 筘序列根数不足）
   *   over      重穿（区段重叠 / 筘序列超出整幅）
   *   cap       每筘根数超区段上限或超 0–4 范围
   *   span      一筘跨越区段边界
   *   width     区段宽度偏差（实际上机宽 vs 目标宽，>0.2cm，warn）
   *   empty-run 连续空筘超区段上限
   *   mirror    镜像破坏（镜像区段筘序列非回文）
   */
  function checkPlan(zones, dents, totalEnds, reedDents) {
    const issues = [];
    const rd = Math.max(0.01, clampNum(reedDents, 0.01, 100, 5));
    const E = Math.max(0, totalEnds | 0);
    const add = (code, msg, o = {}) =>
      issues.push({
        code, level: o.level || 'error', msg,
        zone: o.zone != null ? o.zone : null,
        dent: o.dent != null ? o.dent : null,
        endFrom: o.endFrom != null ? o.endFrom : null,
        endTo: o.endTo != null ? o.endTo : null,
      });

    // ① 区段覆盖：缺口 = 漏穿，重叠 = 重穿
    const zs = (Array.isArray(zones) ? zones : [])
      .map(sanitizeZone)
      .filter(Boolean)
      .sort((a, b) => a.from - b.from);
    let expect = 1;
    zs.forEach((z, i) => {
      if (z.from > expect) {
        add('miss', `第 ${expect}–${z.from - 1} 根不属于任何区段（漏穿）`,
          { endFrom: expect, endTo: z.from - 1 });
      } else if (z.from < expect) {
        add('over', `第 ${z.from}–${expect - 1} 根被多个区段覆盖（重穿）`,
          { zone: i, endFrom: z.from, endTo: expect - 1 });
      }
      expect = Math.max(expect, z.to + 1);
    });
    if (E > 0 && expect <= E) {
      add('miss', `第 ${expect}–${E} 根不属于任何区段（漏穿）`,
        { endFrom: expect, endTo: E });
    }

    // ② 筘序列值域（0–4）
    const clean = (Array.isArray(dents) ? dents : []).map((v, i) => {
      const ok = Number.isInteger(v) && v >= 0 && v <= 4;
      if (!ok) add('cap', `第 ${i + 1} 筘根数 ${v} 超出每筘 0–4 根范围`, { dent: i + 1 });
      return ok ? v : 0;
    });

    // ③ 逐区段走筘
    let di = 0;
    zs.forEach((z, zi) => {
      const len = z.to - z.from + 1;
      const d0 = di;
      let covered = 0;
      while (covered < len && di < clean.length) {
        const take = clean[di];
        if (take > z.maxPerDent) {
          add('cap', `第 ${di + 1} 筘 ${take} 根超过区段 ${zi + 1} 每筘上限 ${z.maxPerDent} 根`,
            { zone: zi, dent: di + 1 });
        }
        if (take > 0 && covered + take > len) {
          add('span', `第 ${di + 1} 筘跨越区段 ${zi + 1} 边界（第 ${z.to} 根）`,
            { zone: zi, dent: di + 1, endFrom: z.from, endTo: z.to });
        }
        covered += take;
        di++;
      }
      const sub = clean.slice(d0, di);
      if (covered < len) {
        add('miss', `区段 ${zi + 1} 少穿 ${len - covered} 根（第 ${z.from + covered}–${z.to} 根漏穿）`,
          { zone: zi, endFrom: z.from + covered, endTo: z.to });
      }
      // 连续空筘
      let k = 0;
      while (k < sub.length) {
        if (sub[k] !== 0) { k++; continue; }
        let j = k;
        while (j < sub.length && sub[j] === 0) j++;
        const run = j - k;
        if (run > z.maxEmptyRun) {
          add('empty-run',
            `区段 ${zi + 1} 第 ${d0 + k + 1}–${d0 + j} 筘连续 ${run} 个空筘（上限 ${z.maxEmptyRun}）`,
            { zone: zi, dent: d0 + k + 1 });
        }
        k = j;
      }
      // 中心镜像
      if (z.mirror) {
        const n = sub.length;
        for (let i = 0; i < Math.floor(n / 2); i++) {
          if (sub[i] !== sub[n - 1 - i]) {
            add('mirror',
              `区段 ${zi + 1} 镜像破坏：第 ${d0 + i + 1} 筘（${sub[i]} 根）与` +
              `第 ${d0 + n - i} 筘（${sub[n - 1 - i]} 根）不对称`,
              { zone: zi, dent: d0 + i + 1 });
            break;
          }
        }
      }
      // 区段宽度偏差
      if (z.targetDensity > 0) {
        const ideal = len / z.targetDensity;
        const actual = sub.length / rd;
        const dev = actual - ideal;
        if (Math.abs(dev) > 0.2) {
          add('width',
            `区段 ${zi + 1} 实际上机宽 ${actual.toFixed(2)} cm，与目标 ${ideal.toFixed(2)} cm 偏差 ${dev >= 0 ? '+' : ''}${dev.toFixed(2)} cm`,
            { zone: zi, level: 'warn' });
        }
      }
    });

    // ④ 筘序列总长：走完区段仍有剩余 = 重穿（超出整幅）
    if (di < clean.length) {
      const extra = clean.slice(di).reduce((s, v) => s + v, 0);
      add('over', `第 ${di + 1} 筘起共 ${clean.length - di} 筘（${extra} 根）超出整幅 ${E} 根（重穿）`,
        { dent: di + 1 });
    }
    return issues;
  }

  return {
    alignUnit, defaultSpec, sanitizeZone, normalizeZones, correctBoundaries, carveZone,
    dentSeq, mirrorSeq, maxZeroRun, discrepancy, zoneCandidates,
    dentWalkFull, endToDentArr, changesVs, uniformDents,
    zoneDentRanges, sliceZoneSeq, zoneMetrics,
    searchZonedPlans, checkPlan,
  };
})();

if (typeof module !== 'undefined') module.exports = { ReedCore };
if (typeof window !== 'undefined') window.ReedCore = ReedCore;
