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
 *   shuttles:  多梭布边计划（可缺省，旧草稿没有该字段）
 *     {
 *       count: 2..8,                  梭子把数
 *       colors: [count]               每把梭子的纱色（色号索引）
 *       home:   [count]               每把梭子的初始停放边 'L'|'R'
 *       parkLimit: int,               停放浮线上限（纬）
 *       picks:  [picks]               null | { s:梭子号, enter:'L'|'R' 入梭边,
 *                                      join:null|'wrap'包绕|'lock'交锁|'cut'剪断重接 }
 *       locked: [picks]               已织纬锁定（批量操作与建议不得改动）
 *     }
 *   dobby:     多臂织机升综计划（可缺省，旧草稿没有该字段）
 *     {
 *       enabled: bool,                升综矩阵驱动组织图（替代 联结×踩踏）
 *       deviceShafts: int,            设备综框数（升起超出该编号的综框记越界）
 *       maxLift: int,                 单纬最大升综数
 *       maxSwitch: int,               相邻两纬允许改变状态的综框数
 *       cells: [picks][shafts]        布尔，cells[p][s]=1 表示第 p 纬综框 s 升起
 *     }
 *   double:    双层织物校核配置（可缺省，旧草稿没有该字段；默认停用，不影响单层推导）
 *     {
 *       enabled: bool,                是否启用双层校核工作区
 *       warpLayer: [ends]             0=上层经 | 1=下层经
 *       pickLayer: [picks]            0=上层纬 | 1=下层纬
 *       zones: [[r,c,r1,c1]...]       允许接结区（组织图矩形，闭区间，0 基）
 *       structure: 'open'|'fold'|'tube'   双幅敞开 / 单侧折叠 / 筒织
 *       foldSide: 'L'|'R'             折边方向（fold 时生效；tube 两侧皆折）
 *       lockedCells: [[r,c]...]       指定锁定的组织格（搜索不得改动该格交织）
 *     }
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
      shuttles: defaultShuttles(picks),
      dobby: defaultDobby(picks, shafts),
      double: defaultDouble(ends, picks),
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
      shuttles: defaultShuttles(picks),
      dobby: defaultDobby(picks, shafts),
      double: defaultDouble(ends, picks),
    };
  }

  /* ------------------------------------------------------------------ *
   * 多梭布边：数据规整
   * ------------------------------------------------------------------ */
  function clampInt(v, lo, hi, dflt) {
    v = parseInt(v, 10);
    if (!Number.isFinite(v)) return dflt;
    return Math.max(lo, Math.min(hi, v));
  }

  /** 默认多梭计划：2 把梭子、全部纬未指定、无锁定（即功能未启用，不产生校验）。 */
  function defaultShuttles(picks) {
    return normalizeShuttles(null, picks);
  }

  /**
   * 把（可能缺失/残缺的）多梭数据规整为完整结构。
   * 旧草稿没有 shuttles 字段时传入 null，得到一份“未启用”的默认计划。
   */
  function normalizeShuttles(sh, picks) {
    const P = Math.max(0, picks | 0);
    const count = clampInt(sh && sh.count, 2, 8, 2);
    const parkLimit = clampInt(sh && sh.parkLimit, 1, 200, 8);
    const colors = [], home = [];
    for (let k = 0; k < count; k++) {
      const c = sh && sh.colors && sh.colors[k];
      colors[k] = Number.isInteger(c) && c >= 0 ? c : (k % 7) + 1;
      const hv = sh && sh.home && sh.home[k];
      home[k] = (hv === 'L' || hv === 'R') ? hv : (k % 2 ? 'R' : 'L');
    }
    const pickArr = [], locked = [];
    for (let p = 0; p < P; p++) {
      const a = sh && sh.picks && sh.picks[p];
      if (a && Number.isInteger(a.s) && a.s >= 0 && a.s < count) {
        pickArr[p] = {
          s: a.s,
          enter: a.enter === 'R' ? 'R' : 'L',
          join: (a.join === 'wrap' || a.join === 'lock' || a.join === 'cut') ? a.join : null,
        };
      } else pickArr[p] = null;
      locked[p] = !!(sh && sh.locked && sh.locked[p]);
    }
    return { count, colors, home, parkLimit, picks: pickArr, locked };
  }

  /* ------------------------------------------------------------------ *
   * 多臂升综计划：数据规整
   * ------------------------------------------------------------------ */
  /** 默认升综计划：未启用、全不升起、设备限制取草稿综框数（即不产生额外校验）。 */
  function defaultDobby(picks, shafts) {
    return normalizeDobby(null, picks, shafts);
  }

  /**
   * 把（可能缺失/残缺的）升综计划规整为完整结构。
   * 旧草稿没有 dobby 字段时传入 null，得到一份“未启用”的默认计划。
   * 矩阵列数恒等于草稿综框数（经穿综映射到组织图）；deviceShafts 是设备能力，
   * 升起编号 ≥ deviceShafts 的综框由校验记为越界。
   */
  function normalizeDobby(db, picks, shafts) {
    const P = Math.max(0, picks | 0);
    const S = Math.max(1, shafts | 0);
    const deviceShafts = clampInt(db && db.deviceShafts, 1, 24, S);
    const maxLift = clampInt(db && db.maxLift, 1, 24, S);
    const maxSwitch = clampInt(db && db.maxSwitch, 1, 24, S);
    const cells = [];
    for (let p = 0; p < P; p++) {
      const row = [];
      for (let s = 0; s < S; s++)
        row[s] = !!(db && db.cells && db.cells[p] && db.cells[p][s]);
      cells.push(row);
    }
    return { enabled: !!(db && db.enabled), deviceShafts, maxLift, maxSwitch, cells };
  }

  /* ------------------------------------------------------------------ *
   * 双层织物校核：数据规整
   *
   * 分层 / 接结区 / 锁定格均随草稿持久化；默认停用。
   * 旧草稿没有 double 字段时传入 null，得到一份“未启用”的默认配置，
   * 打开双层工作区即可直接使用，不影响任何单层推导。
   * ------------------------------------------------------------------ */
  /** 默认双层配置：未启用；上/下层按经纬序号均分（前半上、后半下）。 */
  function defaultDouble(ends, picks) {
    return normalizeDouble(null, ends, picks);
  }

  /**
   * 把（可能缺失/残缺的）双层配置规整为完整结构：
   *  - warpLayer/pickLayer 长度恒为 ends/picks，取值 0（上）|1（下）；
   *  - zones 为去重、钳制到组织图范围内的整数矩形 [r,c,r1,c1]（0 基闭区间）；
   *  - lockedCells 为范围内去重的 [r,c] 格点；
   *  - structure/foldSide 枚举兜底；enabled 恒为布尔。
   */
  function normalizeDouble(dl, ends, picks) {
    const E = Math.max(0, ends | 0), P = Math.max(0, picks | 0);
    const layerOf = (v, half) => v === 1 ? (half ? 1 : 0) : 0;
    // 默认均分：前半上、后半下（旧草稿“直接打开”也能立刻看到两层）
    const warpLayer = [], pickLayer = [];
    for (let e = 0; e < E; e++) {
      const v = dl && dl.warpLayer && dl.warpLayer[e];
      warpLayer[e] = (v === 1 || v === 0) ? v : (e >= E / 2 ? 1 : 0);
    }
    for (let p = 0; p < P; p++) {
      const v = dl && dl.pickLayer && dl.pickLayer[p];
      pickLayer[p] = (v === 1 || v === 0) ? v : (p >= P / 2 ? 1 : 0);
    }
    const structure = (dl && (dl.structure === 'fold' || dl.structure === 'tube'))
      ? dl.structure : 'open';
    const foldSide = (dl && dl.foldSide === 'R') ? 'R' : 'L';

    const inRect = (q) => Array.isArray(q) && q.length === 4 &&
      q.every(n => Number.isInteger(n));
    const zoneSet = new Set(), zones = [];
    if (dl && Array.isArray(dl.zones)) {
      for (const z of dl.zones) {
        if (!inRect(z)) continue;
        let r0 = clampInt(z[0], 0, Math.max(0, P - 1), 0);
        let r1 = clampInt(z[2], 0, Math.max(0, P - 1), 0);
        let c0 = clampInt(z[1], 0, Math.max(0, E - 1), 0);
        let c1 = clampInt(z[3], 0, Math.max(0, E - 1), 0);
        if (r0 > r1) [r0, r1] = [r1, r0];
        if (c0 > c1) [c0, c1] = [c1, c0];
        const key = `${r0},${c0},${r1},${c1}`;
        if (zoneSet.has(key)) continue;
        zoneSet.add(key);
        zones.push([r0, c0, r1, c1]);
      }
    }
    const lockSet = new Set(), lockedCells = [];
    if (dl && Array.isArray(dl.lockedCells)) {
      for (const q of dl.lockedCells) {
        if (!Array.isArray(q) || q.length < 2) continue;
        const r = clampInt(q[0], 0, Math.max(0, P - 1), -1);
        const c = clampInt(q[1], 0, Math.max(0, E - 1), -1);
        if (r < 0 || c < 0) continue;
        const key = `${r},${c}`;
        if (lockSet.has(key)) continue;
        lockSet.add(key);
        lockedCells.push([r, c]);
      }
    }
    lockedCells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return {
      enabled: !!(dl && dl.enabled),
      warpLayer, pickLayer, zones,
      structure, foldSide, lockedCells,
    };
  }

  /** 双层接结区命中：格 (p,e) 是否落在任一允许接结矩形内。 */
  function inStitchZone(dl, p, e) {
    if (!dl || !Array.isArray(dl.zones)) return false;
    return dl.zones.some(([r0, c0, r1, c1]) =>
      p >= r0 && p <= r1 && e >= c0 && e <= c1);
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
      shuttles: d.shuttles ? {
        ...d.shuttles,
        colors: d.shuttles.colors.slice(),
        home: d.shuttles.home.slice(),
        picks: d.shuttles.picks.map(a => (a ? { ...a } : null)),
        locked: d.shuttles.locked.slice(),
      } : d.shuttles,
      dobby: d.dobby ? {
        ...d.dobby,
        cells: d.dobby.cells.map(row => row.slice()),
      } : d.dobby,
      double: d.double ? {
        ...d.double,
        warpLayer: d.double.warpLayer.slice(),
        pickLayer: d.double.pickLayer.slice(),
        zones: d.double.zones.map(z => z.slice()),
        lockedCells: d.double.lockedCells.map(q => q.slice()),
      } : d.double,
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
    if (nd.shuttles) {
      nd.shuttles.picks = resize1D(d.shuttles.picks, picks, () => null);
      nd.shuttles.locked = resize1D(d.shuttles.locked, picks, () => false);
    }
    if (nd.dobby) {
      nd.dobby.cells = Array.from({ length: picks }, (_, p) =>
        Array.from({ length: shafts }, (_, s) =>
          (p < old.p && s < old.s && d.dobby.cells[p]) ? !!d.dobby.cells[p][s] : false)
      );
    }

    // 双层配置按新尺寸规整：分层带保留旧序号、新增部分给默认层；接结区 / 锁定格越界钳制
    nd.double = normalizeDouble(d.double, ends, picks);

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
    const db = (d.dobby && d.dobby.enabled && Array.isArray(d.dobby.cells)) ? d.dobby : null;
    const drawdown = [];      // [picks][ends] : 1 | 0 | null
    const lifted = [];        // [picks] -> Set<shaft>
    const pickValid = [];

    for (let p = 0; p < picks; p++) {
      const row = new Array(ends).fill(null);
      const set = new Set();
      let valid = true;

      if (db) {
        // 升综矩阵驱动：每格确定，空行 = 全幅纬浮（有效组织，由浮线检查提示）
        const cells = db.cells[p] || [];
        for (let s = 0; s < shafts; s++) if (cells[s]) set.add(s);
      } else {
        const t = d.treadling[p];
        if (t < 0 || t >= treadles) {
          valid = false; // 空踏板 / 越界踏板
        } else {
          for (let s = 0; s < shafts; s++) {
            if (d.tieup[s] && d.tieup[s][t]) set.add(s);
          }
          if (set.size === 0) valid = false; // 该踏板无联结
        }
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

  /** 升综矩阵行序列（每行视为一个组合）的最小周期 */
  function periodRows(cells) {
    const n = cells.length;
    const keys = cells.map(row => row.map(v => (v ? 1 : 0)).join(''));
    return period1D(keys);
  }

  /**
   * 组织循环：穿综/踩踏周期与组织图行列周期共同决定。
   * 返回 { warp, weft }，并附带是否含缺失格的标志。
   */
  function repeats(d, derived) {
    const threadingP = period1D(d.threading);
    // 升综矩阵驱动时踩踏序列不再参与组织，纬向周期取升综行周期
    const dobbyOn = !!(d.dobby && d.dobby.enabled && Array.isArray(d.dobby.cells));
    const treadlingP = dobbyOn ? periodRows(d.dobby.cells) : period1D(d.treadling);
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
   * 多梭布边路径推演
   *
   * 依据每把梭子的上次离场边（初始为停放边）逐纬推演：
   *   - 入梭边必须等于该梭当前停放边，否则为「入梭边不一致」；
   *   - 相邻两纬换梭时，新梭入梭一侧需要交接方式（包绕/交锁/剪断重接）；
   *   - 梭子离场后沿布边停放，再次入梭的纬距超过 parkLimit 为「停放浮线超限」，
   *     该纬交接方式为「剪断重接」时浮线被剪断，不计超限。
   *
   * 返回 null（无多梭数据）或：
   * {
   *   active,            是否有任一纬指定了梭子（否则不做布边校验）
   *   rows: [picks]      null | { pick, shuttle, enter, exit, join, mismatch,
   *                               changed, prevShuttle, floatLen, floatEdge, floatFrom }
   *   parked: [picks]    每纬织完后各梭停放边快照
   *   home:   [count]    初始停放边
   * }
   * ------------------------------------------------------------------ */
  function shuttlePath(d) {
    const sh = d.shuttles;
    if (!sh || !Array.isArray(sh.picks)) return null;
    const P = d.picks, N = sh.count;
    const home = [];
    for (let k = 0; k < N; k++) home[k] = sh.home[k] === 'R' ? 'R' : 'L';
    const edges = home.slice();
    const used = new Array(N).fill(false);
    const lastExit = new Array(N).fill(-1);
    const rows = new Array(P).fill(null);
    const parked = new Array(P).fill(null);
    let active = false, prevS = null;

    for (let p = 0; p < P; p++) {
      const a = sh.picks[p];
      if (a && Number.isInteger(a.s) && a.s >= 0 && a.s < N) {
        active = true;
        const k = a.s;
        const enter = a.enter === 'R' ? 'R' : 'L';
        const exit = enter === 'L' ? 'R' : 'L';
        rows[p] = {
          pick: p, shuttle: k, enter, exit,
          join: a.join || null,
          mismatch: enter !== edges[k],
          changed: prevS !== null && prevS !== k,
          prevShuttle: prevS,
          floatLen: used[k] ? p - lastExit[k] : 0,
          floatEdge: edges[k],
          floatFrom: lastExit[k],
        };
        edges[k] = exit;
        used[k] = true; lastExit[k] = p;
        prevS = k;
      } else {
        prevS = null;
      }
      parked[p] = edges.slice();
    }
    return { active, rows, parked, home };
  }

  /* ------------------------------------------------------------------ *
   * 多梭布边修改建议
   *
   * 逐纬顺序推演并生成修复建议（锁定纬只列入 skipped，不生成可应用项）：
   *   - 入梭边不一致   → 顺边（enter 改为推演停放边）
   *   - 停放浮线超限   → 剪断重接（join='cut'）
   *   - 换梭未交接     → 包绕 / 交锁（join=prefer）
   * 入梭边修正会即时代入后续推演，保证一串不一致能被顺序理顺。
   * 返回 { changes:[{pick,shuttle,enter,join,reasons}], skipped:[同构] }
   * ------------------------------------------------------------------ */
  function shuttleSuggest(d, prefer) {
    const sh = d.shuttles;
    const empty = { changes: [], skipped: [] };
    if (!sh || !Array.isArray(sh.picks)) return empty;
    const N = sh.count;
    const edges = [];
    for (let k = 0; k < N; k++) edges[k] = sh.home[k] === 'R' ? 'R' : 'L';
    const used = new Array(N).fill(false);
    const lastExit = new Array(N).fill(-1);
    const changes = [], skipped = [];
    let prevS = null;

    for (let p = 0; p < d.picks; p++) {
      const a = sh.picks[p];
      if (!a || !Number.isInteger(a.s) || a.s < 0 || a.s >= N) { prevS = null; continue; }
      const k = a.s, locked = !!sh.locked[p];
      const fix = { pick: p, shuttle: k, enter: null, join: null, reasons: [] };

      if ((a.enter === 'R' ? 'R' : 'L') !== edges[k]) {
        fix.enter = edges[k];
        fix.reasons.push(`入梭边顺为${edges[k] === 'L' ? '左' : '右'}边`);
      }
      if (used[k] && p - lastExit[k] > sh.parkLimit && a.join !== 'cut') {
        fix.join = 'cut';
        fix.reasons.push(`停放浮线 ${p - lastExit[k]} 纬超限（${sh.parkLimit}），剪断重接`);
      }
      if (prevS !== null && prevS !== k && !a.join && !fix.join) {
        fix.join = prefer === 'lock' ? 'lock' : 'wrap';
        fix.reasons.push(prefer === 'lock' ? '换梭交接（交锁）' : '换梭交接（包绕）');
      }
      if (fix.reasons.length) (locked ? skipped : changes).push(fix);

      // 用修正后的入梭边继续推演；锁定纬按原样织入
      const enterSim = locked ? (a.enter === 'R' ? 'R' : 'L')
                              : (fix.enter || (a.enter === 'R' ? 'R' : 'L'));
      edges[k] = enterSim === 'L' ? 'R' : 'L';
      used[k] = true; lastExit[k] = p;
      prevS = k;
    }
    return { changes, skipped };
  }

  /* ------------------------------------------------------------------ *
   * 校验
   * issue: { level:'error'|'warn', code, msg, loc:[{grid,r,c}...] }
   * ------------------------------------------------------------------ */
  function validate(d, derived, fl, sp) {
    const issues = [];
    const { shafts, treadles, ends, picks } = d;
    if (sp === undefined) sp = shuttlePath(d);

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

    // 7) 多梭布边路径（仅当至少一纬指定了梭子才启用）
    if (sp && sp.active) {
      const sh = d.shuttles;
      const edgeCol = (e) => e === 'L' ? 0 : ends - 1;
      const edgeName = (e) => e === 'L' ? '左' : '右';
      const unassigned = [];
      for (let p = 0; p < picks; p++) {
        const r = sp.rows[p];
        if (!r) { unassigned.push(p); continue; }
        // 入梭边与停放边不一致
        if (r.mismatch) {
          issues.push({
            level: 'error', code: 'shuttle-entry',
            msg: `第 ${p + 1} 纬：梭子 ${r.shuttle + 1} 停在${edgeName(r.exit)}布边，` +
                 `却设为从${edgeName(r.enter)}边入梭`,
            loc: [{ grid: 'drawdown', r: p, c: edgeCol(r.enter) }],
          });
        }
        // 换梭未交接
        if (r.changed && !r.join) {
          const prev = sp.rows[p - 1];
          const loc = [{ grid: 'drawdown', r: p, c: edgeCol(r.enter) }];
          if (prev) loc.push({ grid: 'drawdown', r: p - 1, c: edgeCol(prev.exit) });
          issues.push({
            level: 'warn', code: 'shuttle-join',
            msg: `第 ${p + 1} 纬换梭（梭${r.prevShuttle + 1}→梭${r.shuttle + 1}），` +
                 `${edgeName(r.enter)}布边纬纱未交接`,
            loc,
          });
        }
        // 停放浮线超限
        if (r.floatLen > sh.parkLimit && r.join !== 'cut') {
          issues.push({
            level: 'error', code: 'shuttle-float',
            msg: `梭子 ${r.shuttle + 1} 自第 ${r.floatFrom + 1} 纬起沿${edgeName(r.floatEdge)}布边` +
                 `停放 ${r.floatLen} 纬（限值 ${sh.parkLimit}）`,
            loc: Array.from({ length: r.floatLen + 1 }, (_, i) =>
              ({ grid: 'drawdown', r: r.floatFrom + i, c: edgeCol(r.floatEdge) })),
          });
        }
      }
      if (unassigned.length) {
        issues.push({
          level: 'warn', code: 'shuttle-unassigned',
          msg: `${unassigned.length} 纬未指定梭子（多梭计划不完整）`,
          loc: unassigned.map(p => ({ grid: 'drawdown', r: p, c: 0 })),
        });
      }
    }

    // 8) 多臂升综计划：设备约束（仅升综矩阵驱动组织图时启用）
    if (d.dobby && d.dobby.enabled && Array.isArray(d.dobby.cells)) {
      const db = d.dobby;
      for (let p = 0; p < picks; p++) {
        const row = db.cells[p] || [];
        let lifts = 0;
        const out = [];
        for (let s = 0; s < shafts; s++) {
          if (!row[s]) continue;
          lifts++;
          if (s >= db.deviceShafts) out.push(s);
        }
        if (out.length) {
          issues.push({
            level: 'error', code: 'dobby-shaft-range',
            msg: `第 ${p + 1} 纬升起综框 ${out.map(s => s + 1).join('、')}，` +
                 `超出设备 ${db.deviceShafts} 综框`,
            loc: [{ grid: 'treadling', r: p, c: -1 }],
          });
        }
        if (lifts > db.maxLift) {
          issues.push({
            level: 'error', code: 'dobby-lift-limit',
            msg: `第 ${p + 1} 纬升起 ${lifts} 个综框，超过单纬上限 ${db.maxLift}`,
            loc: [{ grid: 'treadling', r: p, c: -1 }],
          });
        }
        if (p > 0) {
          const prev = db.cells[p - 1] || [];
          let sw = 0;
          for (let s = 0; s < shafts; s++) if (!!row[s] !== !!prev[s]) sw++;
          if (sw > db.maxSwitch) {
            issues.push({
              level: 'warn', code: 'dobby-switch-limit',
              msg: `第 ${p}→${p + 1} 纬切换 ${sw} 个综框状态，超过相邻纬上限 ${db.maxSwitch}`,
              loc: [{ grid: 'treadling', r: p, c: -1 }],
            });
          }
        }
      }
    }

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
    const sp = shuttlePath(d);
    const val = validate(d, derived, fl, sp);
    const st = stats(d, derived, fl, rep);
    return { derived, fl, rep, shuttle: sp, validation: val, stats: st };
  }

  return {
    PALETTE, defaultDraft, blankDraft, cloneDraft, resize,
    derive, colorGrid, repeats, floats, validate, stats, compare, analyze,
    period1D, gcd, lcm,
    defaultShuttles, normalizeShuttles, shuttlePath, shuttleSuggest,
    defaultDobby, normalizeDobby,
    defaultDouble, normalizeDouble, inStitchZone,
  };
})();

if (typeof module !== 'undefined') module.exports = { Engine };
