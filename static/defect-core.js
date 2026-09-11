/* =====================================================================
 * defect-core.js — 试织缺陷回标：纯逻辑核心（不依赖 DOM）
 *
 * 实物坐标（mm）→ 组织位置换算：
 *   批次参数 warpDensity/weftDensity 为成品（下机）实测密度（根/厘米），
 *   originX/originY 为对齐原点（mm）：设计第 1 根经 / 第 1 根纬的实物位置。
 *   end  = floor((mmX - originX) / (10 / warpDensity))
 *   pick = floor((mmY - originY) / (10 / weftDensity))
 *   上机坐标（缩率还原）：loom = origin + (mm - origin) / (1 - shrink/100)
 *
 * 标记类型：
 *   miss      漏织（缺纬 / 漏穿）
 *   mistread  错踏（踏板踩错）
 *   broken    断经
 *   float     浮线过长
 *
 * 反复出现：
 *   - 跨循环：同批次、同类型，最小循环位置 (end mod Rw, pick mod Rh) 相同，
 *             但落在不同循环砖（tileX/tileY），且至少一条在设计幅外。
 *   - 跨批次：同源草稿（draftId 相同，或无 id 时快照指纹相同）、同类型、
 *             同最小循环位置的标记出现在多个批次。
 * ===================================================================== */
'use strict';

const DefectCore = (() => {

  const TYPES = ['miss', 'mistread', 'broken', 'float'];
  const TYPE_NAMES = {
    miss: '漏织', mistread: '错踏', broken: '断经', float: '浮线过长',
  };
  const TYPE_COLORS = {
    miss: '#29528c',      // 蓝
    mistread: '#b3352a',  // 朱
    broken: '#7a4d1f',    // 棕
    float: '#b8862f',     // 琥珀
  };
  const TYPE_GLYPHS = { miss: '漏', mistread: '踏', broken: '断', float: '浮' };

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

  /* ------------------------------- 批次参数规整 ------------------------ */
  function normalizeParams(p) {
    p = p || {};
    return {
      warpDensity: clampNum(p.warpDensity, 0.1, 200, 10),
      weftDensity: clampNum(p.weftDensity, 0.1, 200, 10),
      warpShrink: clampNum(p.warpShrink, 0, 90, 0),
      weftShrink: clampNum(p.weftShrink, 0, 90, 0),
      originX: clampNum(p.originX, -100000, 100000, 0),
      originY: clampNum(p.originY, -100000, 100000, 0),
    };
  }

  /** 每根经 / 每根纬的成品间距（mm） */
  function pitch(params) {
    const q = normalizeParams(params);
    return { x: 10 / q.warpDensity, y: 10 / q.weftDensity };
  }

  /** 实物 mm → 序号（0 基，可能为负 / 越界） */
  function mmToIndex(mm, density, origin) {
    if (!(density > 0)) return -1;
    const spacing = 10 / density;
    return Math.floor(((mm - origin) + 1e-9) / spacing);
  }

  function locate(mmX, mmY, params, snapshot) {
    const q = normalizeParams(params);
    const end = mmToIndex(mmX, q.warpDensity, q.originX);
    const pick = mmToIndex(mmY, q.weftDensity, q.originY);
    const ends = snapshot ? snapshot.ends | 0 : 0;
    const picks = snapshot ? snapshot.picks | 0 : 0;
    const inWarp = end >= 0 && end < ends;
    const inWeft = pick >= 0 && pick < picks;
    return {
      end, pick,
      inWarp, inWeft,
      inCloth: inWarp && inWeft,
      loomX: q.originX + (mmX - q.originX) / Math.max(1e-6, 1 - q.warpShrink / 100),
      loomY: q.originY + (mmY - q.originY) / Math.max(1e-6, 1 - q.weftShrink / 100),
    };
  }

  /** 序号 → 实物 mm（格子中心） */
  function indexToMm(end, pick, params) {
    const q = normalizeParams(params);
    const p = pitch(q);
    return {
      x: q.originX + (end + 0.5) * p.x,
      y: q.originY + (pick + 0.5) * p.y,
    };
  }

  /* ------------------------------- 最小循环位置 ------------------------ */
  /** 用快照推导出最小循环（穿综/踩踏周期与组织图行列周期，同 Engine.repeats 的口径） */
  function snapshotRepeats(Engine, snapshot) {
    try {
      const d = Engine.derive(snapshot);
      return Engine.repeats(snapshot, d);
    } catch (e) {
      return { warp: snapshot.ends | 0, weft: snapshot.picks | 0 };
    }
  }

  /**
   * 标记在最小循环中的位置，以及循环砖编号（第几块循环）。
   * 越界序号同样取模，用于识别“循环边界外反复出现”的问题。
   */
  function cyclePosition(mark, rw, rh) {
    rw = Math.max(1, rw | 0);
    rh = Math.max(1, rh | 0);
    const end = mark.end | 0, pick = mark.pick | 0;
    return {
      cx: ((end % rw) + rw) % rw,
      cy: ((pick % rh) + rh) % rh,
      tileX: Math.floor(end / rw),
      tileY: Math.floor(pick / rh),
    };
  }

  /* ------------------------------- 标记关联 ---------------------------- */
  /** 标记对应的穿综 / 联结 / 踩踏 / 梭次（信息缺失时对应字段为 null） */
  function relate(mark, snapshot, derived) {
    const out = {
      end: null, pick: null, shaft: null, treadle: null,
      lifted: [], tiePoints: [], shuttle: null, drawdown: null,
    };
    if (!snapshot) return out;
    const { end, pick } = mark;
    if (end >= 0 && end < snapshot.ends) {
      out.end = end;
      const s = snapshot.threading[end];
      if (Number.isInteger(s) && s >= 0 && s < snapshot.shafts) out.shaft = s;
    }
    if (pick >= 0 && pick < snapshot.picks) {
      out.pick = pick;
      const t = snapshot.treadling[pick];
      if (Number.isInteger(t) && t >= 0 && t < snapshot.treadles) {
        out.treadle = t;
        if (derived && derived.lifted && derived.lifted[pick])
          out.lifted = [...derived.lifted[pick]];
        for (let s = 0; s < snapshot.shafts; s++)
          if (snapshot.tieup[s] && snapshot.tieup[s][t]) out.tiePoints.push(s);
      }
      const sh = snapshot.shuttles;
      if (sh && Array.isArray(sh.picks) && sh.picks[pick]) {
        const a = sh.picks[pick];
        out.shuttle = {
          s: a.s,
          color: sh.colors ? sh.colors[a.s] : null,
          enter: a.enter, join: a.join || null,
        };
      }
      if (derived && derived.drawdown && end >= 0 && end < snapshot.ends)
        out.drawdown = derived.drawdown[pick][end];
    }
    return out;
  }

  /* ------------------------------- 浮线核查 ---------------------------- */
  /**
   * 找到覆盖 (end,pick) 的经浮 / 纬浮段。
   * Engine.floats 对浮段覆盖的每个格都推一条记录（含同一段的 start/length），
   * 故按 (end,pick) 命中记录即可，再按 start 去重得到唯一浮段。
   * 返回 { warpRun: {end,start,length}|null, weftRun:{pick,start,length}|null }
   */
  function floatRunAt(fl, end, pick) {
    let warpRun = null, weftRun = null;
    if (fl && Array.isArray(fl.warpRuns)) {
      const hit = fl.warpRuns.find(r => r.end === end && r.pick === pick);
      if (hit) warpRun = { end: hit.end, pick: hit.pick, start: hit.start, length: hit.length };
    }
    if (fl && Array.isArray(fl.weftRuns)) {
      const hit = fl.weftRuns.find(r => r.pick === pick && r.end === end);
      if (hit) weftRun = { pick: hit.pick, end: hit.end, start: hit.start, length: hit.length };
    }
    return { warpRun, weftRun };
  }

  /* ------------------------------- 反复出现分析 ------------------------ */
  /** 快照指纹：穿综/联结/踩踏决定组织，同指纹视为同一设计（无 draftId 时用） */
  function fingerprint(snapshot) {
    if (!snapshot) return '';
    return JSON.stringify([
      snapshot.shafts, snapshot.treadles,
      snapshot.threading, snapshot.treadling,
      (snapshot.tieup || []).map(r => r.map(v => v ? 1 : 0)),
    ]);
  }

  /**
   * 跨循环 / 跨批次分组。
   * batches: [{ id, draftId, snapshot, repeatWarp, repeatWeft, marks:[...] }]
   * 返回：
   *   groups: [{ key, type, cx, cy, members:[{batchId, markId, end, pick, tileX, tileY}],
   *              crossCycle:bool, crossBatch:bool, batches:Set, shafts:Set,
   *              treadles:Set, tiePoints:Set }]
   *   markGroup: Map(markKey `${batchId}:${markId}` -> group)
   */
  function analyzeRecurrence(batches) {
    const groups = new Map();
    const markGroup = new Map();
    const fpCache = new Map();

    for (const b of batches) {
      const rw = Math.max(1, b.repeatWarp | 0), rh = Math.max(1, b.repeatWeft | 0);
      const sourceKey = b.draftId != null ? `d${b.draftId}` : `f${fingerprint(b.snapshot)}`;
      for (const m of b.marks || []) {
        const cp = cyclePosition(m, rw, rh);
        const key = `${sourceKey}|${m.type}|${cp.cx},${cp.cy}`;
        let g = groups.get(key);
        if (!g) {
          g = {
            key, type: m.type, cx: cp.cx, cy: cp.cy,
            members: [], batchIds: new Set(),
            tiles: new Set(), outOfRange: false,
            shafts: new Set(), treadles: new Set(), tiePoints: new Set(),
            ends: new Set(), picks: new Set(),
          };
          groups.set(key, g);
        }
        g.members.push({
          batchId: b.id, markId: m.id, end: m.end, pick: m.pick,
          tileX: cp.tileX, tileY: cp.tileY,
        });
        g.batchIds.add(b.id);
        g.tiles.add(`${cp.tileX},${cp.tileY}`);
        const E = b.snapshot ? b.snapshot.ends | 0 : 0;
        const P = b.snapshot ? b.snapshot.picks | 0 : 0;
        if (m.end < 0 || m.end >= E || m.pick < 0 || m.pick >= P) g.outOfRange = true;

        // 关联综框 / 踏板 / 联结点
        const s = b.snapshot;
        if (s && m.end >= 0 && m.end < s.ends) {
          const sh = s.threading[m.end];
          if (Number.isInteger(sh) && sh >= 0 && sh < s.shafts) g.shafts.add(sh);
          g.ends.add(m.end);
        }
        if (s && m.pick >= 0 && m.pick < s.picks) {
          const t = s.treadling[m.pick];
          if (Number.isInteger(t) && t >= 0 && t < s.treadles) {
            g.treadles.add(t);
            for (let k = 0; k < s.shafts; k++)
              if (s.tieup[k] && s.tieup[k][t]) g.tiePoints.add(`${k + 1}-${t + 1}`);
          }
          g.picks.add(m.pick);
        }
        markGroup.set(`${b.id}:${m.id}`, g);
      }
    }

    const list = [];
    for (const g of groups.values()) {
      g.crossBatch = g.batchIds.size > 1;
      // 跨循环：同批次内落到不止一块循环砖（含幅外循环砖）
      g.crossCycle = g.tiles.size > 1 || (g.members.length > 1 && g.outOfRange);
      g.count = g.members.length;
      g.shafts = [...g.shafts].sort((a, b) => a - b);
      g.treadles = [...g.treadles].sort((a, b) => a - b);
      g.tiePoints = [...g.tiePoints];
      g.batches = [...g.batchIds];
      list.push(g);
    }
    list.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    return { groups: list, markGroup };
  }

  /* ------------------------------- 修订动作 ---------------------------- */
  /**
   * 把单条修订动作应用到快照副本，返回 { draft, meta }（不落库、不改原对象）。
   * action:
   *   threading  { end, shaft, applyCycle:bool, rw }     穿综改挂综框
   *   tieup      { shaft, treadle, value:bool }           联结翻转
   *   treadling  { pick, treadle, applyCycle:bool, rh }   踩踏改踏板
   */
  function applyRevision(snapshot, action) {
    const d = JSON.parse(JSON.stringify(snapshot));
    let meta = {};
    if (action.action === 'threading') {
      const shaft = clampInt(action.shaft, 0, d.shafts - 1, 0);
      const ends = action.applyCycle ? sameCycleEnds(d.ends, action.end, action.rw)
                                      : [clampInt(action.end, 0, d.ends - 1, 0)];
      ends.forEach(e => { d.threading[e] = shaft; });
      meta = { kind: 'threading', ends };
    } else if (action.action === 'tieup') {
      const s = clampInt(action.shaft, 0, d.shafts - 1, 0);
      const t = clampInt(action.treadle, 0, d.treadles - 1, 0);
      d.tieup[s][t] = !!action.value;
      meta = { kind: 'tieup', cells: [{ shaft: s, treadle: t, value: !!action.value }] };
    } else if (action.action === 'treadling') {
      const t = clampInt(action.treadle, 0, d.treadles - 1, 0);
      const picks = action.applyCycle ? sameCyclePicks(d.picks, action.pick, action.rh)
                                      : [clampInt(action.pick, 0, d.picks - 1, 0)];
      picks.forEach(p => { d.treadling[p] = t; });
      meta = { kind: 'treadling', picks };
    } else {
      throw new Error('未知修订类型：' + action.action);
    }
    return { draft: d, meta };
  }

  function sameCycleEnds(ends, anchorEnd, rw) {
    rw = Math.max(1, rw | 0);
    anchorEnd = clampInt(anchorEnd, 0, ends - 1, 0);
    const c = ((anchorEnd % rw) + rw) % rw;
    const out = [];
    for (let e = c; e < ends; e += rw) out.push(e);
    return out;
  }
  function sameCyclePicks(picks, anchorPick, rh) {
    rh = Math.max(1, rh | 0);
    anchorPick = clampInt(anchorPick, 0, picks - 1, 0);
    const c = ((anchorPick % rh) + rh) % rh;
    const out = [];
    for (let p = c; p < picks; p += rh) out.push(p);
    return out;
  }

  /** 修订前后组织差异：逐格 drawdown 比较（在两稿并集尺寸内）+ 浮线/缺失统计 */
  function diffDraft(Engine, before, after, meta) {
    const da = Engine.derive(before), db = Engine.derive(after);
    const E = Math.max(before.ends, after.ends), P = Math.max(before.picks, after.picks);
    const changes = [];
    let changed = 0, nullsA = 0, nullsB = 0;
    for (let p = 0; p < P; p++) {
      for (let e = 0; e < E; e++) {
        const va = da.drawdown[p] ? da.drawdown[p][e] : undefined;
        const vb = db.drawdown[p] ? db.drawdown[p][e] : undefined;
        if (va === null || va === undefined) nullsA++;
        if (vb === null || vb === undefined) nullsB++;
        if (va !== vb) {
          changed++;
          if (changes.length < 4000) changes.push({ end: e, pick: p, from: va ?? null, to: vb ?? null });
        }
      }
    }
    const fa = Engine.floats(before, da), fb = Engine.floats(after, db);
    meta = meta || {};
    return {
      changes, changed, total: E * P,
      changeRate: E * P ? changed / (E * P) : 0,
      maxWarpBefore: fa.maxWarp, maxWarpAfter: fb.maxWarp,
      maxWeftBefore: fa.maxWeft, maxWeftAfter: fb.maxWeft,
      nullsBefore: nullsA, nullsAfter: nullsB,
      drawdownBefore: da.drawdown, drawdownAfter: db.drawdown,
      revEnds: meta.ends || null,
      revPicks: meta.picks || null,
      revCells: meta.cells || null,
    };
  }

  /** 修订摘要文字（写入 revisions.summary） */
  function revisionSummary(kind, action, diff) {
    if (kind === 'threading')
      return `穿综：第 ${action.end + 1} 根经${action.applyCycle ? `起循环位置（${diff.revEnds.length} 根）` : ''} → 综框 ${action.shaft + 1}；组织变化 ${diff.changed} 格`;
    if (kind === 'tieup')
      return `联结：综框 ${action.shaft + 1} × 踏板 ${action.treadle + 1} → ${action.value ? '联结' : '脱开'}；组织变化 ${diff.changed} 格`;
    return `踩踏：第 ${action.pick + 1} 纬${action.applyCycle ? `起循环位置（${diff.revPicks.length} 纬）` : ''} → 踏板 ${action.treadle + 1}；组织变化 ${diff.changed} 格`;
  }

  return {
    TYPES, TYPE_NAMES, TYPE_COLORS, TYPE_GLYPHS,
    normalizeParams, pitch, mmToIndex, locate, indexToMm,
    snapshotRepeats, cyclePosition, relate, floatRunAt,
    fingerprint, analyzeRecurrence,
    applyRevision, sameCycleEnds, sameCyclePicks, diffDraft, revisionSummary,
  };
})();

if (typeof module !== 'undefined') module.exports = { DefectCore };
if (typeof window !== 'undefined') window.DefectCore = DefectCore;
