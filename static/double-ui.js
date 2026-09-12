/* =====================================================================
 * double-ui.js — 双层织物校核工作区（原生 DOM + Canvas，无外部依赖）
 *
 * 通过 window.__loom 与主应用通信（state / Engine / pushHistory / afterEdit）。
 * 所有配置修改统一走 mutate()：先压撤销历史 → 变更 → afterEdit 级联，
 * 因此分层 / 接结区 / 结构 / 锁定格均可 Ctrl+Z，并随草稿写入 SQLite。
 *
 * 并排四视图：上层组织 · 下层组织 · 合并表面 · 逐纬截面；
 * 播放时在截面画出梭线在两层间的路径；点选异常可追溯到
 * 经线、纬次、综框与升综状态（主图板定位）。
 * ===================================================================== */
'use strict';

(function () {

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const CELL = 18, BAND = 10, LBL = 30, TOP = 20, LEFT = 34;
  const MERGED_CELL = 20, MTOP = 22, MLEFT = 34;

  // 合并表面语义配色
  const MERGE_COLORS = {
    'warp-top': '#d9a441', 'weft-top': '#e9d3a0',
    'warp-bottom': '#274060', 'weft-bottom': '#7d94b8',
    'stitch': '#4a7c59', 'wrong': '#d23b2f', 'null': '#e3dccb',
  };

  const S = {
    open: false,
    model: null,
    hover: null,           // 合并表面悬停 {p,e,x,y}
    gesture: null,         // {mode, pointerId, p0,e0,p1,e1,done:Set}
    locate: null,          // {cells:[[p,e]], until}
    pick: 0,
    playing: false,
    timer: null,
    prog: 0,
    candidates: [],
    selected: -1,
    diff: null,            // 选中候选的差异 {raw,count}
  };

  const loom = () => window.__loom;
  const draft = () => loom().state.draft;
  const dl = () => draft().double;
  const DC = () => window.DoubleCore;
  const Engine = () => loom().Engine;

  function toast(msg, ms) { if (window.toast) window.toast(msg, ms); }

  /** 统一修改入口：压历史 → 变更 → 级联（afterEdit 回调 __dlRefresh 重绘） */
  function mutate(fn, msg) {
    const L = loom();
    L.pushHistory();
    fn();
    L.afterEdit();
    S.candidates = []; S.selected = -1; S.diff = null;
    if (msg) toast(msg);
  }

  /* ------------------------------- 打开 / 关闭 ------------------------- */
  function openModal() {
    const d = draft();
    if (!d.double) d.double = Engine().defaultDouble(d.ends, d.picks);
    S.open = true;
    S.pick = clamp(S.pick, 0, d.picks - 1);
    $('#doubleModal').classList.remove('hidden');
    syncControls();
    rebuildModel();
    renderAll();
  }

  function closeModal() {
    stopPlay();
    S.open = false;
    $('#doubleModal').classList.add('hidden');
  }

  function rebuildModel() {
    S.model = dl().enabled ? DC().buildModel(draft()) : null;
  }

  function renderAll() {
    if (!S.open) return;
    rebuildModel();
    resizeAllCanvases();
    drawLayer('top');
    drawLayer('bottom');
    drawMergedBase();
    drawMergedOverlay();
    drawSection(performance.now());
    renderIssues();
    renderCounts();
    renderCandidates();
    updatePlayInfo();
  }

  /* ------------------------------- 控件同步 ---------------------------- */
  function syncControls() {
    const d = draft(), cfg = dl();
    $('#dlEnabled').checked = !!cfg.enabled;
    const setRadio = (name, val) => {
      $$(`input[name="${name}"]`).forEach(r => { r.checked = r.value === val; });
    };
    setRadio('dlStruct', cfg.structure);
    setRadio('dlFoldSide', cfg.foldSide);
    $('#dlPickTo').value = d.picks;
    $('#dlWarpTo').value = d.ends;
    $('#dlFoldSideRow').classList.toggle('dl-dim', cfg.structure === 'tube');
    $('#dlFoldHint').textContent = cfg.structure === 'tube'
      ? '筒织时两侧皆折，折边方向不生效。'
      : cfg.structure === 'fold'
        ? (cfg.foldSide === 'R' ? '纬纱在右边折回。' : '纬纱在左边折回。')
        : '双幅敞开无折回，此选项不生效。';
  }

  /* ------------------------------- 分层分配 ---------------------------- */
  function rangeFrom(fromId, toId, n) {
    const f = clamp(parseInt($(fromId).value, 10) || 1, 1, n);
    const t = clamp(parseInt($(toId).value, 10) || f, 1, n);
    return [Math.min(f, t) - 1, Math.max(f, t) - 1];
  }

  function assignWarp() {
    const d = draft();
    const [f, t] = rangeFrom('#dlWarpFrom', '#dlWarpTo', d.ends);
    const layer = parseInt($('#dlWarpLayer').value, 10) === 1 ? 1 : 0;
    mutate(() => {
      for (let e = f; e <= t; e++) dl().warpLayer[e] = layer;
    }, `第 ${f + 1}–${t + 1} 根经 → ${layer ? '下' : '上'}层`);
  }

  function assignPick() {
    const d = draft();
    const [f, t] = rangeFrom('#dlPickFrom', '#dlPickTo', d.picks);
    const layer = parseInt($('#dlPickLayer').value, 10) === 1 ? 1 : 0;
    mutate(() => {
      for (let p = f; p <= t; p++) dl().pickLayer[p] = layer;
    }, `第 ${f + 1}–${t + 1} 纬 → ${layer ? '下' : '上'}层`);
  }

  function warpSplit() {
    const d = draft();
    mutate(() => {
      dl().warpLayer = Array.from({ length: d.ends }, (_, e) => (e >= d.ends / 2 ? 1 : 0));
    }, '经线已按前后半分到下 / 上层');
  }

  function pickAlternate() {
    const d = draft();
    mutate(() => {
      dl().pickLayer = Array.from({ length: d.picks }, (_, p) => p % 2);
    }, '纬次已按奇偶交替分层');
  }

  function pickSplit() {
    const d = draft();
    mutate(() => {
      dl().pickLayer = Array.from({ length: d.picks }, (_, p) => (p >= d.picks / 2 ? 1 : 0));
    }, '纬次已按前后半分到下 / 上层');
  }

  /* ------------------------------- 结构 / 折边 / 启用 ------------------ */
  function setEnabled(on) {
    if (dl().enabled === on) return;
    mutate(() => { dl().enabled = on; }, on ? '已启用双层校核' : '已停用双层校核（配置保留）');
    syncControls();
  }

  function setStruct(v) {
    if (dl().structure === v) return;
    mutate(() => { dl().structure = v; }, `结构 → ${DC().STRUCT_NAMES[v]}`);
    syncControls();
  }

  function setFoldSide(v) {
    if (dl().foldSide === v) return;
    mutate(() => { dl().foldSide = v; }, `折边 → ${v === 'R' ? '右' : '左'}边`);
    syncControls();
  }

  /* ------------------------------- 接结区 / 锁定格 --------------------- */
  function paintMode() {
    const r = $('input[name="dlPaint"]:checked');
    return r ? r.value : 'zone';
  }

  /** 合并表面上的涂绘手势处理（橡皮 / 圈区 / 锁格）。 */
  function applyPaintAt(p, e, mode, gesture) {
    const cfg = dl();
    if (mode === 'lock') {
      const key = `${p},${e}`;
      const has = cfg.lockedCells.some(([r, c]) => r === p && c === e);
      if (gesture.value === null) gesture.value = has ? 'remove' : 'add';
      if (gesture.value === 'add' && !has) cfg.lockedCells.push([p, e]);
      if (gesture.value === 'remove' && has)
        cfg.lockedCells = cfg.lockedCells.filter(([r, c]) => !(r === p && c === e));
    } else if (mode === 'erase') {
      // 擦除该格上的锁定与覆盖接结区
      cfg.lockedCells = cfg.lockedCells.filter(([r, c]) => !(r === p && c === e));
      cfg.zones = cfg.zones.filter(z => !(p >= z[0] && p <= z[2] && e >= z[1] && e <= z[3]));
    }
  }

  function commitRect(gesture) {
    const p0 = Math.min(gesture.p0, gesture.p1), p1 = Math.max(gesture.p0, gesture.p1);
    const e0 = Math.min(gesture.e0, gesture.e1), e1 = Math.max(gesture.e0, gesture.e1);
    if (gesture.mode === 'zone') {
      const cfg = dl();
      const dup = cfg.zones.some(z => z[0] === p0 && z[1] === e0 && z[2] === p1 && z[3] === e1);
      if (!dup) cfg.zones.push([p0, e0, p1, e1]);
      return `已圈出接结区：纬 ${p0 + 1}–${p1 + 1} × 经 ${e0 + 1}–${e1 + 1}`;
    }
    if (gesture.mode === 'erase')
      return '已擦除该区接结区 / 锁定格';
    return null;
  }

  /* ------------------------------- 问题列表 ---------------------------- */
  function renderIssues() {
    const box = $('#dlIssueList');
    box.innerHTML = '';
    const cfg = dl();
    if (!cfg.enabled || !S.model) {
      $('#dlIssueCount').textContent = '0';
      $('#dlIssueCount').className = 'badge ok';
      box.innerHTML = '<p class="hint">勾选“启用双层校核”后在此列出层间次序颠倒、接结越区、折边断点与筒体未闭合。</p>';
      return;
    }
    const m = S.model;
    const badge = $('#dlIssueCount');
    badge.textContent = m.errors + m.warns;
    badge.className = 'badge' + (!m.errors ? (!m.warns ? ' ok' : ' warn') : '');
    if (!m.issues.length) {
      box.innerHTML = '<p class="hint dl-good">✓ 双层校核未发现问题。</p>';
      return;
    }
    m.issues.forEach((iss, i) => {
      const row = document.createElement('div');
      row.className = 'dl-issue' + (iss.level === 'warn' ? ' warn' : '');
      const txt = document.createElement('span');
      txt.className = 'dl-issue-msg';
      txt.textContent = `${iss.level === 'warn' ? '⚠' : '✗'} ${iss.msg}`;
      const btn = document.createElement('button');
      btn.className = 'btn tiny';
      btn.textContent = '定位';
      btn.addEventListener('click', () => locateIssue(i));
      row.append(txt, btn);
      box.appendChild(row);
    });
  }

  function renderCounts() {
    const d = draft(), cfg = dl();
    const m = S.model;
    let txt = `上层经 ${m ? m.topEnds.length : '–'} 根 / 下层经 ${m ? m.bottomEnds.length : '–'} 根` +
      `　上层纬 ${m ? m.topPicks.length : '–'} / 下层纬 ${m ? m.bottomPicks.length : '–'}` +
      `　接结区 ${cfg.zones.length} 块（合规接结 ${m ? m.stitches.length : 0} 点）` +
      `　锁定格 ${cfg.lockedCells.length}`;
    if (m) {
      txt += `　分层最长浮线：上 ${Math.max(m.floats.top.warp.max, m.floats.top.weft.max)} / ` +
        `下 ${Math.max(m.floats.bottom.warp.max, m.floats.bottom.weft.max)}`;
    }
    $('#dlCounts').textContent = txt;
    $('#dlTopInfo').textContent = m
      ? `${m.topEnds.length} 经 × ${m.topPicks.length} 纬　最长浮线 ${m.floats.top.warp.max} 经浮 / ${m.floats.top.weft.max} 纬浮` : '';
    $('#dlBottomInfo').textContent = m
      ? `${m.bottomEnds.length} 经 × ${m.bottomPicks.length} 纬　最长浮线 ${m.floats.bottom.warp.max} 经浮 / ${m.floats.bottom.weft.max} 纬浮` : '';
  }

  /** 点选异常：合并表面闪烁定位，并给出可追溯到主图板的入口。 */
  function locateIssue(i) {
    const iss = S.model.issues[i];
    const cells = iss.loc.filter(l => l.grid === 'dl-merged').map(l => [l.r, l.c]);
    if (cells.length) {
      S.locate = { cells, until: Date.now() + 3200 };
      // 滚动到首个格
      const [p, e] = cells[0];
      const wrap = $('#dlMergedWrap');
      wrap.scrollTo({
        left: Math.max(0, e * MERGED_CELL - wrap.clientWidth / 2),
        top: Math.max(0, p * MERGED_CELL - wrap.clientHeight / 2),
        behavior: 'smooth',
      });
      drawMergedOverlay();
      setTimeout(() => { if (S.locate && Date.now() >= S.locate.until - 50) { S.locate = null; drawMergedOverlay(); } }, 3300);
    }
    // 追溯：首个定位格 → 经线 / 纬次 / 综框 / 升综状态
    const tr = iss.trace && iss.trace[0];
    if (tr) {
      const shaftTxt = tr.shaft >= 0 ? `综框 ${tr.shaft + 1}` : '穿综越界';
      $('#dlHoverInfo').innerHTML =
        `追溯：第 <b>${tr.end + 1}</b> 根经（${tr.warpLayer ? '下' : '上'}层，${shaftTxt}）` +
        `× 第 <b>${tr.pick + 1}</b> 纬（${tr.pickLayer ? '下' : '上'}层` +
        (tr.dobbyOn ? '，多臂升综' : `，踏板 ${tr.treadle + 1}`) +
        `），该经此刻<b>${tr.lifted ? '升起' : '落下'}</b>　` +
        `<button id="dlTraceMain" class="btn tiny">在主图板定位</button>`;
      $('#dlTraceMain').addEventListener('click', () => {
        window.locateCell({ grid: 'drawdown', r: tr.pick, c: tr.end });
      });
    }
  }

  /* ------------------------------- 候选搜索 ---------------------------- */
  function runSearch() {
    if (!dl().enabled) { toast('请先启用双层校核'); return; }
    const cands = DC().searchFixes(draft(), { limit: 12 });
    S.candidates = cands;
    S.selected = -1; S.diff = null;
    renderCandidates();
    drawMergedOverlay();
    const best = cands.find(c => c.key !== 'base');
    toast(best
      ? `找到 ${cands.length - 1} 个候选：最少错误 ${best.errors}、改动 ${best.changes} 格`
      : '没有在锁定条件下找到可只改联结 / 踩踏 / 升综的修复方案');
  }

  function renderCandidates() {
    const box = $('#dlCandList');
    box.innerHTML = '';
    if (!S.candidates.length) {
      box.innerHTML = '<p class="hint">候选按 错误数 → 改动格数 → 最长浮线 排列；选中后在合并表面叠色标出差异。</p>';
      $('#dlAdopt').disabled = true;
      return;
    }
    S.candidates.forEach((c, i) => {
      const row = document.createElement('label');
      row.className = 'dl-cand' + (i === S.selected ? ' sel' : '') + (c.key === 'base' ? ' base' : '');
      const chk = document.createElement('input');
      chk.type = 'radio';
      chk.name = 'dlCand';
      chk.checked = i === S.selected;
      chk.addEventListener('change', () => selectCandidate(i));
      const txt = document.createElement('span');
      txt.className = 'dl-cand-txt';
      const modeTxt = c.patch.mode === 'dobby' ? '升综格' : '联结/踩踏';
      txt.textContent = c.key === 'base'
        ? `当前稿（不改）：错误 ${c.errors}，警告 ${c.warns}，最长浮线 ${c.maxFloat}`
        : `错误 ${c.errors} · 警告 ${c.warns} · 改 ${c.changes} 个${modeTxt} · 最长浮线 ${c.maxFloat}`;
      row.append(chk, txt);
      box.appendChild(row);
    });
    $('#dlAdopt').disabled = S.selected < 0 || S.candidates[S.selected].key === 'base';
  }

  function selectCandidate(i) {
    S.selected = i;
    const c = S.candidates[i];
    S.diff = c.key === 'base' ? null : DC().diffGrid(draft(), c.patch);
    drawMergedOverlay();
    renderCandidates();
  }

  function adoptCandidate() {
    const c = S.candidates[S.selected];
    if (!c || c.key === 'base') return;
    const nd = DC().candidateDraft(draft(), c.patch);
    const baseName = ($('#draftName') && $('#draftName').value.trim()) || '未命名草稿';
    const name = `${baseName} 双层修复`;
    window.loadDraft(nd, name, null);
    toast(`已采纳候选并另存为新草稿「${name}」，原稿未改动；确认后请手动保存。`, 3400);
    closeModal();
  }

  /* ------------------------------- 画布尺寸 ---------------------------- */
  function layerViewSize(layer) {
    const d = draft(), m = S.model;
    if (!m) return { W: 120, H: 80 };
    const ends = layer === 'top' ? m.topEnds : m.bottomEnds;
    const picks = layer === 'top' ? m.topPicks : m.bottomPicks;
    return {
      W: LEFT + ends.length * CELL + 6,
      H: TOP + picks.length * CELL + 6,
      ends, picks,
    };
  }

  function mergedSize() {
    const d = draft();
    return {
      W: MLEFT + d.ends * MERGED_CELL + 8,
      H: MTOP + d.picks * MERGED_CELL + BAND + 18,
    };
  }

  function sectionSize() {
    const d = draft();
    return { W: Math.max(320, MLEFT + d.ends * MERGED_CELL + 8), H: 210 };
  }

  function sizeCanvas(cvs, W, H) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    cvs.width = Math.round(W * dpr);
    cvs.height = Math.round(H * dpr);
    cvs.style.width = W + 'px';
    cvs.style.height = H + 'px';
    const ctx = cvs.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function resizeAllCanvases() {
    const d = draft();
    ['top', 'bottom'].forEach(layer => {
      const { W, H } = layerViewSize(layer);
      const cvs = $(layer === 'top' ? '#dlTopCanvas' : '#dlBottomCanvas');
      const ctx = sizeCanvas(cvs, W, H);
      cvs._ctx = ctx;
    });
    const { W: mW, H: mH } = mergedSize();
    const mctx = sizeCanvas($('#dlMergedBase'), mW, mH);
    const octx = sizeCanvas($('#dlMergedOv'), mW, mH);
    $('#dlMergedBase')._ctx = mctx; $('#dlMergedOv')._ctx = octx;
    const { W: sW, H: sH } = sectionSize();
    const sctx = sizeCanvas($('#dlSectionCanvas'), sW, sH);
    $('#dlSectionCanvas')._ctx = sctx;
    // overlay 绝对定位覆盖
    $('#dlMergedOv').style.position = 'absolute';
    $('#dlMergedOv').style.left = '0'; $('#dlMergedOv').style.top = '0';
    $('#dlMergedOv').style.pointerEvents = 'none';
  }

  /* ------------------------------- 上 / 下层组织图 --------------------- */
  function drawLayer(layer) {
    const cvs = $(layer === 'top' ? '#dlTopCanvas' : '#dlBottomCanvas');
    const ctx = cvs._ctx; if (!ctx) return;
    const d = draft(), m = S.model;
    const { W, H, ends, picks } = layerViewSize(layer);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fffdf7';
    ctx.fillRect(0, 0, W, H);
    if (!m) {
      ctx.fillStyle = '#9a917e'; ctx.font = '12px sans-serif';
      ctx.fillText('未启用双层校核', 12, 30);
      return;
    }
    // 压缩组织：该层经 × 该层纬
    picks.forEach((gp, py) => {
      ends.forEach((ge, ex) => {
        const cell = m.grid[gp][ge];
        const x = LEFT + ex * CELL, y = TOP + py * CELL;
        if (cell.v === null) ctx.fillStyle = MERGE_COLORS.null;
        else if (cell.stitch) ctx.fillStyle = MERGE_COLORS.stitch;
        else if (layer === 0 || layer === 'top')
          ctx.fillStyle = cell.v === 1 ? MERGE_COLORS['warp-top'] : MERGE_COLORS['weft-top'];
        else
          ctx.fillStyle = cell.v === 1 ? MERGE_COLORS['warp-bottom'] : MERGE_COLORS['weft-bottom'];
        ctx.fillRect(x, y, CELL, CELL);
      });
    });
    // 网格
    ctx.strokeStyle = '#e4dcc9'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let ex = 0; ex <= ends.length; ex++) {
      const x = LEFT + ex * CELL + .5;
      ctx.moveTo(x, TOP); ctx.lineTo(x, TOP + picks.length * CELL);
    }
    for (let py = 0; py <= picks.length; py++) {
      const y = TOP + py * CELL + .5;
      ctx.moveTo(LEFT, y); ctx.lineTo(LEFT + ends.length * CELL, y);
    }
    ctx.stroke();
    ctx.strokeStyle = '#b9ae94';
    ctx.strokeRect(LEFT + .5, TOP + .5, ends.length * CELL - 1, picks.length * CELL - 1);
    // 序号（压缩位置标注原经/纬号）
    ctx.fillStyle = '#6b6457'; ctx.font = '8px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (CELL * ends.length < 900)
      ends.forEach((ge, ex) => ctx.fillText(String(ge + 1), LEFT + ex * CELL + CELL / 2, TOP - 7));
    if (CELL * picks.length < 700)
      picks.forEach((gp, py) => ctx.fillText(String(gp + 1), LEFT - 9, TOP + py * CELL + CELL / 2));
  }

  /* ------------------------------- 合并表面 ---------------------------- */
  function drawMergedBase() {
    const cvs = $('#dlMergedBase');
    const ctx = cvs._ctx; if (!ctx) return;
    const d = draft(), m = S.model, cfg = dl();
    const { W, H } = mergedSize();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fffdf7';
    ctx.fillRect(0, 0, W, H);
    if (!m) {
      ctx.fillStyle = '#9a917e'; ctx.font = '12px sans-serif';
      ctx.fillText('启用双层校核后显示合并表面', 12, 30);
      return;
    }
    for (let p = 0; p < d.picks; p++) {
      for (let e = 0; e < d.ends; e++) {
        ctx.fillStyle = MERGE_COLORS[m.merged[p][e]] || '#ccc';
        ctx.fillRect(MLEFT + e * MERGED_CELL, MTOP + p * MERGED_CELL, MERGED_CELL, MERGED_CELL);
      }
    }
    // 网格
    ctx.strokeStyle = 'rgba(107,100,87,.25)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let e = 0; e <= d.ends; e++) {
      const x = MLEFT + e * MERGED_CELL + .5;
      ctx.moveTo(x, MTOP); ctx.lineTo(x, MTOP + d.picks * MERGED_CELL);
    }
    for (let p = 0; p <= d.picks; p++) {
      const y = MTOP + p * MERGED_CELL + .5;
      ctx.moveTo(MLEFT, y); ctx.lineTo(MLEFT + d.ends * MERGED_CELL, y);
    }
    ctx.stroke();
    // 接结区：绿色虚线框
    ctx.save();
    ctx.strokeStyle = '#2f6b3e'; ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    for (const [r0, c0, r1, c1] of cfg.zones) {
      ctx.strokeRect(MLEFT + c0 * MERGED_CELL + 1, MTOP + r0 * MERGED_CELL + 1,
        (c1 - c0 + 1) * MERGED_CELL - 2, (r1 - r0 + 1) * MERGED_CELL - 2);
    }
    ctx.restore();
    // 折边：蓝边条；筒织两侧；敞开无
    if (cfg.structure === 'fold') {
      const x = cfg.foldSide === 'R' ? MLEFT + d.ends * MERGED_CELL - 4 : MLEFT;
      ctx.fillStyle = 'rgba(41,82,140,.55)';
      ctx.fillRect(x, MTOP, 4, d.picks * MERGED_CELL);
    } else if (cfg.structure === 'tube') {
      ctx.fillStyle = 'rgba(41,82,140,.55)';
      ctx.fillRect(MLEFT, MTOP, 4, d.picks * MERGED_CELL);
      ctx.fillRect(MLEFT + d.ends * MERGED_CELL - 4, MTOP, 4, d.picks * MERGED_CELL);
    }
    // 分层带（顶：经线层；左：纬次层）
    for (let e = 0; e < d.ends; e++) {
      ctx.fillStyle = cfg.warpLayer[e] ? '#274060' : '#d9a441';
      ctx.fillRect(MLEFT + e * MERGED_CELL, MTOP - BAND, MERGED_CELL, BAND - 1);
    }
    for (let p = 0; p < d.picks; p++) {
      ctx.fillStyle = cfg.pickLayer[p] ? '#7d94b8' : '#e9d3a0';
      ctx.fillRect(MLEFT - BAND, MTOP + p * MERGED_CELL, BAND - 1, MERGED_CELL);
    }
    ctx.strokeStyle = '#b9ae94';
    ctx.strokeRect(MLEFT + .5, MTOP + .5, d.ends * MERGED_CELL - 1, d.picks * MERGED_CELL - 1);
    // 播放当前纬行
    if (S.playing || S._stepHold) {
      ctx.fillStyle = 'rgba(217,164,65,.25)';
      ctx.fillRect(MLEFT, MTOP + S.pick * MERGED_CELL, d.ends * MERGED_CELL, MERGED_CELL);
    }
    // 图例
    drawLegend(ctx, MLEFT, MTOP + d.picks * MERGED_CELL + 12);
  }

  function drawLegend(ctx, x, y) {
    const items = [
      ['warp-top', '上经在上'], ['weft-top', '上纬在上'],
      ['warp-bottom', '下经在上'], ['weft-bottom', '下纬在上'],
      ['stitch', '接结'], ['wrong', '越序'],
    ];
    ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    let cx = x;
    for (const [key, name] of items) {
      ctx.fillStyle = MERGE_COLORS[key];
      ctx.fillRect(cx, y - 5, 10, 10);
      ctx.strokeStyle = '#b9ae94'; ctx.strokeRect(cx + .5, y - 4.5, 9, 9);
      ctx.fillStyle = '#6b6457';
      ctx.fillText(name, cx + 14, y);
      cx += 14 + ctx.measureText(name).width + 12;
    }
  }

  /** 叠加层：问题高亮 / 悬停 / 手势矩形 / 锁定格 / 差异叠色 / 定位闪烁 */
  function drawMergedOverlay() {
    const cvs = $('#dlMergedOv');
    const ctx = cvs._ctx; if (!ctx) return;
    const d = draft(), m = S.model;
    const { W, H } = mergedSize();
    ctx.clearRect(0, 0, W, H);
    if (!m) return;

    // 锁定格：锁形小标（半透明黑角块）
    ctx.fillStyle = 'rgba(45,42,36,.55)';
    for (const [r, c] of dl().lockedCells) {
      ctx.beginPath();
      ctx.arc(MLEFT + c * MERGED_CELL + 5, MTOP + r * MERGED_CELL + 5, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // 候选差异叠色：紫白斜纹框
    if (S.diff) {
      ctx.save();
      ctx.strokeStyle = '#7a3ea8';
      ctx.fillStyle = 'rgba(122,62,168,.28)';
      ctx.lineWidth = 1.5;
      for (let p = 0; p < d.picks; p++)
        for (let e = 0; e < d.ends; e++)
          if (S.diff.raw[p][e]) {
            ctx.fillRect(MLEFT + e * MERGED_CELL + 1, MTOP + p * MERGED_CELL + 1,
              MERGED_CELL - 2, MERGED_CELL - 2);
          }
      ctx.restore();
    }

    // 问题格：错误红框 / 警告黄框（去重）
    const err = new Set(), warn = new Set();
    m.issues.forEach(iss => {
      iss.loc.filter(l => l.grid === 'dl-merged').forEach(l => {
        (iss.level === 'warn' ? warn : err).add(`${l.r},${l.c}`);
      });
    });
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(179,53,42,.85)';
    err.forEach(k => {
      const [p, e] = k.split(',').map(Number);
      ctx.strokeRect(MLEFT + e * MERGED_CELL + 1, MTOP + p * MERGED_CELL + 1,
        MERGED_CELL - 2, MERGED_CELL - 2);
    });
    ctx.strokeStyle = 'rgba(184,134,47,.8)';
    warn.forEach(k => {
      const [p, e] = k.split(',').map(Number);
      ctx.strokeRect(MLEFT + e * MERGED_CELL + 1.5, MTOP + p * MERGED_CELL + 1.5,
        MERGED_CELL - 3, MERGED_CELL - 3);
    });

    // 定位闪烁
    if (S.locate && Date.now() < S.locate.until) {
      const pulse = .55 + .35 * Math.sin(Date.now() / 140);
      ctx.save();
      ctx.strokeStyle = '#c8784f'; ctx.lineWidth = 3;
      ctx.shadowColor = '#c8784f'; ctx.shadowBlur = 8;
      ctx.globalAlpha = .6 + pulse * .4;
      S.locate.cells.forEach(([p, e]) =>
        ctx.strokeRect(MLEFT + e * MERGED_CELL + 1, MTOP + p * MERGED_CELL + 1,
          MERGED_CELL - 2, MERGED_CELL - 2));
      ctx.restore();
    }

    // 悬停格
    if (S.hover && !S.gesture) {
      const { p, e } = S.hover;
      ctx.fillStyle = 'rgba(217,164,65,.25)';
      ctx.fillRect(MLEFT + e * MERGED_CELL, MTOP + p * MERGED_CELL, MERGED_CELL, MERGED_CELL);
    }
    // 手势矩形
    if (S.gesture && S.gesture.mode === 'zone') {
      const g = S.gesture;
      const p0 = Math.min(g.p0, g.p1), p1 = Math.max(g.p0, g.p1);
      const e0 = Math.min(g.e0, g.e1), e1 = Math.max(g.e0, g.e1);
      ctx.fillStyle = 'rgba(47,107,62,.14)';
      ctx.fillRect(MLEFT + e0 * MERGED_CELL, MTOP + p0 * MERGED_CELL,
        (e1 - e0 + 1) * MERGED_CELL, (p1 - p0 + 1) * MERGED_CELL);
      ctx.strokeStyle = '#2f6b3e'; ctx.lineWidth = 2; ctx.setLineDash([5, 3]);
      ctx.strokeRect(MLEFT + e0 * MERGED_CELL + 1, MTOP + p0 * MERGED_CELL + 1,
        (e1 - e0 + 1) * MERGED_CELL - 2, (p1 - p0 + 1) * MERGED_CELL - 2);
      ctx.setLineDash([]);
    }
  }

  /* ------------------------------- 逐纬截面 ---------------------------- */
  /**
   * 截面示意（沿当前纬方向）：
   *   两条纬纱槽道（上槽 / 下槽）；每根经画为竖线，升起时拱到槽道上方；
   *   当前纬的梭线在自己槽道行进，播放时从入梭边画到折返边（筒织/折叠转向）。
   */
  function drawSection(now) {
    const cvs = $('#dlSectionCanvas');
    const ctx = cvs._ctx; if (!ctx) return;
    const d = draft(), m = S.model;
    const { W, H } = sectionSize();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fffdf7';
    ctx.fillRect(0, 0, W, H);
    if (!m) {
      ctx.fillStyle = '#9a917e'; ctx.font = '12px sans-serif';
      ctx.fillText('未启用双层校核', 12, 30);
      return;
    }
    const sec = DC().sectionAt(d, m, S.pick);
    const cfg = dl();
    const x0 = MLEFT, laneW = d.ends * MERGED_CELL;
    const yTop = 78, yBottom = 140;

    // 层标签 + 槽道
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#8a6d1f';
    ctx.fillText('上层纬槽道', 6, yTop);
    ctx.fillStyle = '#33507a';
    ctx.fillText('下层纬槽道', 6, yBottom);
    ctx.strokeStyle = '#d8cfba'; ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(x0, yTop); ctx.lineTo(x0 + laneW, yTop);
    ctx.moveTo(x0, yBottom); ctx.lineTo(x0 + laneW, yBottom);
    ctx.stroke();

    // 经线竖线（升=拱过当前槽道；异层经在该纬跨层处画接结/越序色）
    sec.warps.forEach((w) => {
      const x = x0 + w.x * MERGED_CELL + MERGED_CELL / 2;
      const baseY = w.layer === 0 ? yTop + 26 : yBottom + 26;
      ctx.strokeStyle = w.layer === 0 ? '#b88a25' : '#274060';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, 36); ctx.lineTo(x, H - 14);
      ctx.stroke();
      // 升起综框：经在上 → 在槽道上方画小拱
      if (w.up) {
        const laneY = w.layer === 0 ? yTop : yBottom;
        ctx.beginPath();
        ctx.moveTo(x - MERGED_CELL / 2 + 2, laneY);
        ctx.quadraticCurveTo(x, laneY - 13, x + MERGED_CELL / 2 - 2, laneY);
        ctx.strokeStyle = w.layer === 0 ? '#b88a25' : '#274060';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (w.stitch) {
        ctx.fillStyle = MERGE_COLORS.stitch;
        ctx.beginPath();
        ctx.arc(x, w.layer === 0 ? yBottom - 4 : yTop - 4, 3.4, 0, Math.PI * 2);
        ctx.fill();
      }
      if (w.wrong) {
        ctx.fillStyle = MERGE_COLORS.wrong;
        ctx.beginPath();
        ctx.arc(x, w.layer === 0 ? yBottom - 4 : yTop - 4, 3.4, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // 当前纬梭线：按入梭边 / 折返边在两层槽道之间画路径
    const cycle = 1300 / Number($('#dlSpeed').value || 3);
    const prog = S.playing ? ((now % cycle) / cycle) : 1;
    S.prog = prog;
    drawShuttlePath(ctx, sec, cfg, x0, laneW, yTop, yBottom, prog);

    // 经纬序号
    ctx.fillStyle = '#6b6457'; ctx.font = '8px sans-serif';
    ctx.textAlign = 'center';
    for (let e = 0; e < d.ends; e += (d.ends > 60 ? 5 : 1)) {
      ctx.fillText(String(e + 1), x0 + e * MERGED_CELL + MERGED_CELL / 2, H - 4);
    }
  }

  function drawShuttlePath(ctx, sec, cfg, x0, laneW, yTop, yBottom, prog) {
    const laneY = sec.lane === 0 ? yTop : yBottom;
    const enter = sec.enter;
    const startX = enter === 'L' ? x0 : x0 + laneW;
    const endX = enter === 'L' ? x0 + laneW : x0;
    const headX = startX + (endX - startX) * prog;

    // 已走过的纬纱
    ctx.save();
    ctx.strokeStyle = '#1d6f8e'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(startX, laneY);
    ctx.lineTo(headX, laneY);
    ctx.stroke();

    // 折返连接（折叠 / 筒织）：从上一纬槽道在折边弯到本纬槽道
    if (sec.turnAt && sec.pick > 0) {
      const prevLane = dl().pickLayer[sec.pick - 1] ? 1 : 0;
      if (prevLane !== sec.lane) {
        const py = prevLane === 0 ? yTop : yBottom;
        const cx = sec.turnAt === 'R' ? x0 + laneW : x0;
        ctx.strokeStyle = '#9c4a2f'; ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(cx, py);
        ctx.quadraticCurveTo(cx + (sec.turnAt === 'R' ? 16 : -16), (py + laneY) / 2, cx, laneY);
        ctx.stroke();
      } else {
        // 同层连续：折边断点，画红叉
        const cx = sec.turnAt === 'R' ? x0 + laneW - 4 : x0 + 4;
        ctx.strokeStyle = '#d23b2f'; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx - 5, laneY - 8); ctx.lineTo(cx + 5, laneY + 8);
        ctx.moveTo(cx + 5, laneY - 8); ctx.lineTo(cx - 5, laneY + 8);
        ctx.stroke();
      }
    }

    // 梭头
    ctx.fillStyle = '#1d6f8e';
    ctx.beginPath();
    if (enter === 'L') {
      ctx.moveTo(headX + 7, laneY); ctx.lineTo(headX - 6, laneY - 6); ctx.lineTo(headX - 6, laneY + 6);
    } else {
      ctx.moveTo(headX - 7, laneY); ctx.lineTo(headX + 6, laneY - 6); ctx.lineTo(headX + 6, laneY + 6);
    }
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /* ------------------------------- 播放 -------------------------------- */
  function startPlay() {
    if (S.playing) { stopPlay(); return; }
    if (!dl().enabled) { toast('请先启用双层校核'); return; }
    S.playing = true; S._stepHold = false;
    S.pick = clamp(S.pick, 0, draft().picks - 1);
    $('#dlPlay').textContent = '⏸ 暂停';
    updatePlayInfo();
    scheduleStep();
    animate();
  }

  function stopPlay() {
    S.playing = false; S._stepHold = false;
    clearTimeout(S.timer);
    $('#dlPlay').textContent = '▶ 播放';
    drawMergedBase();
    updatePlayInfo();
  }

  function scheduleStep() {
    clearTimeout(S.timer);
    const interval = 1300 / Number($('#dlSpeed').value || 3);
    S.timer = setTimeout(() => {
      if (!S.playing || S._stepHold) return;
      S.pick++;
      if (S.pick >= draft().picks) { stopPlay(); return; }
      drawMergedBase();
      updatePlayInfo();
      scheduleStep();
    }, interval);
  }

  let rafOn = false;
  function animate() {
    if (!rafOn) {
      rafOn = true;
      const loop = (now) => {
        if (!S.open || !S.playing) { rafOn = false; drawSection(now); return; }
        drawSection(now);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
  }

  function stepPick(delta) {
    clearTimeout(S.timer);
    S._stepHold = true; S.playing = true;
    S.pick = clamp(S.pick + delta, 0, draft().picks - 1);
    $('#dlPlay').textContent = '▶ 播放';
    drawMergedBase();
    drawSection(performance.now());
    updatePlayInfo();
  }

  function updatePlayInfo() {
    const d = draft(), m = S.model;
    if (!m) { $('#dlPlayInfo').textContent = '—'; return; }
    const p = S.pick, cell0 = m.grid[p] && m.grid[p][0];
    const tr = m.grid[p].find(c => true)?.trace;
    const lay = dl().pickLayer[p] ? '下层' : '上层';
    const path = m.path;
    const lifted = new Set();
    for (let e = 0; e < d.ends; e++) if (m.grid[p][e].v === 1) lifted.add(m.grid[p][e].trace.shaft);
    const shafts = [...lifted].filter(s => s >= 0).map(s => s + 1).join('、') || '无';
    $('#dlPlayInfo').innerHTML =
      `第 <b>${p + 1}</b>/${d.picks} 纬 · <b>${lay}</b> · ` +
      (tr.dobbyOn ? '多臂升综' : `踏板 ${tr.treadle + 1}`) +
      ` · 升起综框 <b>${shafts}</b> · 梭 ${path.enters[p] === 'L' ? '左→右' : '右→左'}` +
      (path.turnAt[p] ? `，在${path.turnAt[p] === 'L' ? '左' : '右'}边折返` : '');
  }

  /* ------------------------------- 悬停信息 ---------------------------- */
  function mergedCellFromEvent(ev) {
    const cvs = $('#dlMergedBase');
    const rect = cvs.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    const d = draft();
    const e = Math.floor((x - MLEFT) / MERGED_CELL);
    const p = Math.floor((y - MTOP) / MERGED_CELL);
    if (p < 0 || e < 0 || p >= d.picks || e >= d.ends) return null;
    return { p, e, x, y };
  }

  function updateHoverInfo() {
    const h = S.hover, d = draft(), m = S.model;
    const el = $('#dlHoverInfo');
    if (!h || !m) { if (!h) el.textContent = '点格追溯经线 / 纬次 / 综框 / 升综；异常红框可点“定位”。'; return; }
    const cell = m.grid[h.p][h.e];
    const t = cell.trace;
    const shaftTxt = t.shaft >= 0 ? `综框 ${t.shaft + 1}` : '穿综越界';
    const vTxt = cell.v === null ? '缺失' :
      cell.same ? (cell.v === 1 ? '经在上' : '纬在上')
        : cell.stitch ? '接结（合规跨层交织）'
          : cell.wrong ? (cell.inZone ? '区内反向跨层' : '越序跨层') : '跨层';
    el.innerHTML =
      `第 <b>${h.p + 1}</b> 纬（${t.pickLayer ? '下' : '上'}层` +
      (t.dobbyOn ? '，多臂' : `，踏${t.treadle + 1}`) + `）× 第 <b>${h.e + 1}</b> 经` +
      `（${t.warpLayer ? '下' : '上'}层，${shaftTxt}，该经<b>${t.lifted ? '升起' : '落下'}</b>）：${vTxt}` +
      (dl().lockedCells.some(([r, c]) => r === h.p && c === h.e) ? '　🔒已锁定' : '');
  }

  /* ------------------------------- 打印 -------------------------------- */
  function doPrint() {
    if (!dl().enabled) { toast('请先启用双层校核再打印'); return; }
    const d = draft(), m = S.model, cfg = dl();
    $('#dlPrintTitle').textContent = `${$('#draftName').value} — 双层织物校核`;
    $('#dlPrintMeta').innerHTML =
      `打印时间：${new Date().toLocaleString()}<br>` +
      `结构：${DC().STRUCT_NAMES[cfg.structure]}` +
      (cfg.structure === 'fold' ? `（${cfg.foldSide === 'R' ? '右' : '左'}边折回）` : '') +
      `　上层经 ${m.topEnds.length} 根 / 下层经 ${m.bottomEnds.length} 根` +
      `　上层纬 ${m.topPicks.length} / 下层纬 ${m.bottomPicks.length}` +
      `　接结区 ${cfg.zones.length} 块 / 合规接结 ${m.stitches.length} 点<br>` +
      `分层最长浮线：上层 经${m.floats.top.warp.max}·纬${m.floats.top.weft.max}` +
      `　下层 经${m.floats.bottom.warp.max}·纬${m.floats.bottom.weft.max}` +
      `　校核：错误 ${m.errors}　警告 ${m.warns}`;

    // 合并表面打印图（放大重绘）
    const PC = 16, PL = 30, PT = 18;
    const W = PL + d.ends * PC + 8, H = PT + d.picks * PC + 8;
    const cvs = $('#dlPrintCanvas');
    cvs.width = W; cvs.height = H;
    const c = cvs.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
    for (let p = 0; p < d.picks; p++)
      for (let e = 0; e < d.ends; e++) {
        c.fillStyle = MERGE_COLORS[m.merged[p][e]] || '#ccc';
        c.fillRect(PL + e * PC, PT + p * PC, PC, PC);
      }
    c.strokeStyle = 'rgba(107,100,87,.3)';
    c.beginPath();
    for (let e = 0; e <= d.ends; e++) {
      const x = PL + e * PC + .5; c.moveTo(x, PT); c.lineTo(x, PT + d.picks * PC);
    }
    for (let p = 0; p <= d.picks; p++) {
      const y = PT + p * PC + .5; c.moveTo(PL, y); c.lineTo(PL + d.ends * PC, y);
    }
    c.stroke();
    c.save();
    c.strokeStyle = '#2f6b3e'; c.lineWidth = 2; c.setLineDash([6, 3]);
    cfg.zones.forEach(([r0, c0, r1, c1]) =>
      c.strokeRect(PL + c0 * PC + 1, PT + r0 * PC + 1, (c1 - c0 + 1) * PC - 2, (r1 - r0 + 1) * PC - 2));
    c.restore();
    if (cfg.structure !== 'open') {
      c.fillStyle = 'rgba(41,82,140,.6)';
      const sides = cfg.structure === 'tube' ? [PL, PL + d.ends * PC - 4]
        : [cfg.foldSide === 'R' ? PL + d.ends * PC - 4 : PL];
      sides.forEach(x => c.fillRect(x, PT, 4, d.picks * PC));
    }
    c.font = '7px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#333';
    for (let e = 0; e < d.ends; e += d.ends > 80 ? 5 : 1)
      c.fillText(String(e + 1), PL + e * PC + PC / 2, PT - 6);
    for (let p = 0; p < d.picks; p += d.picks > 80 ? 5 : 1)
      c.fillText(String(p + 1), PL - 9, PT + p * PC + PC / 2);

    // 问题明细
    let html = '<b>分层：</b>上层经 [' + m.topEnds.slice(0, 40).map(e => e + 1).join(' ') +
      (m.topEnds.length > 40 ? ' …' : '') + ']　下层经 [' +
      m.bottomEnds.slice(0, 40).map(e => e + 1).join(' ') + (m.bottomEnds.length > 40 ? ' …' : '') + ']<br>' +
      '<b>纬次：</b>上层 ' + m.topPicks.slice(0, 40).map(p => p + 1).join(' ') +
      '　下层 ' + m.bottomPicks.slice(0, 40).map(p => p + 1).join(' ') + '<br>';
    html += m.issues.length
      ? '<b>校核问题：</b><br>' + m.issues.map(i =>
        `${i.level === 'warn' ? '⚠' : '✗'} ${escapeHtml(i.msg)}`).join('<br>')
      : '<b>校核问题：</b>无';
    $('#dlPrintLegend').innerHTML = html;

    document.body.classList.add('dl-printing');
    setTimeout(() => {
      window.print();
      setTimeout(() => document.body.classList.remove('dl-printing'), 600);
    }, 120);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, ch =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  /* ------------------------------- 事件绑定 ---------------------------- */
  function bind() {
    $('#btnDouble').addEventListener('click', openModal);
    $$('[data-close-dl]').forEach(b => b.addEventListener('click', closeModal));
    $('#doubleModal').addEventListener('click', (e) => {
      if (e.target.id === 'doubleModal') closeModal();
    });

    $('#dlEnabled').addEventListener('change', e => setEnabled(e.target.checked));
    $('#dlWarpApply').addEventListener('click', assignWarp);
    $('#dlPickApply').addEventListener('click', assignPick);
    $('#dlWarpSplit').addEventListener('click', warpSplit);
    $('#dlPickAlt').addEventListener('click', pickAlternate);
    $('#dlPickSplit').addEventListener('click', pickSplit);
    $$('input[name="dlStruct"]').forEach(r =>
      r.addEventListener('change', () => setStruct(r.value)));
    $$('input[name="dlFoldSide"]').forEach(r =>
      r.addEventListener('change', () => setFoldSide(r.value)));

    $('#dlSearch').addEventListener('click', runSearch);
    $('#dlAdopt').addEventListener('click', adoptCandidate);
    $('#dlPrint').addEventListener('click', doPrint);

    $('#dlPlay').addEventListener('click', startPlay);
    $('#dlNext').addEventListener('click', () => stepPick(1));
    $('#dlPrev').addEventListener('click', () => stepPick(-1));

    // 合并表面：圈区 / 锁格 / 擦除（左键拖），右键擦除
    const base = $('#dlMergedBase');
    base.addEventListener('contextmenu', e => e.preventDefault());
    base.addEventListener('pointerdown', (ev) => {
      if (!dl().enabled) return;
      const hit = mergedCellFromEvent(ev);
      if (!hit) return;
      base.setPointerCapture(ev.pointerId);
      const mode = ev.button === 2 ? 'erase' : paintMode();
      S.gesture = {
        mode, pointerId: ev.pointerId,
        p0: hit.p, e0: hit.e, p1: hit.p, e1: hit.e,
        value: null, painted: false,
      };
      loom().pushHistory();
      if (mode === 'lock' || mode === 'erase') {
        applyPaintAt(hit.p, hit.e, mode, S.gesture);
        S.gesture.painted = true;
      }
      S.hover = hit;
    });
    base.addEventListener('pointermove', (ev) => {
      const hit = mergedCellFromEvent(ev);
      S.hover = hit;
      updateHoverInfo();
      const g = S.gesture;
      if (!g || g.pointerId !== ev.pointerId || !hit) { drawMergedOverlay(); return; }
      g.p1 = hit.p; g.e1 = hit.e;
      if (g.mode === 'lock' || g.mode === 'erase') {
        const key = `${hit.p},${hit.e}`;
        if (!g.done) g.done = new Set();
        if (!g.done.has(key)) {
          g.done.add(key);
          applyPaintAt(hit.p, hit.e, g.mode, g);
          g.painted = true;
        }
      }
      drawMergedOverlay();
    });
    window.addEventListener('pointerup', (ev) => {
      const g = S.gesture;
      if (!g || g.pointerId !== ev.pointerId) return;
      let msg = null;
      if (g.mode === 'zone' && (g.p0 !== g.p1 || g.e0 !== g.e1 || ev.detail === 0)) {
        // 单击也允许点出 1×1 接结区
        msg = commitRect(g);
      } else if (g.mode === 'zone') {
        msg = commitRect(g);
      } else if (g.painted) {
        msg = g.mode === 'lock' ? '锁定格已更新（搜索不会改动这些组织格）' : '已擦除接结区 / 锁定格';
      }
      S.gesture = null;
      if (g.painted || g.mode === 'zone') {
        loom().afterEdit();
        S.candidates = []; S.selected = -1; S.diff = null;
        renderCandidates();
        if (msg) toast(msg);
      }
      drawMergedOverlay();
    });
    base.addEventListener('pointerleave', () => {
      if (!S.gesture) { S.hover = null; drawMergedOverlay(); updateHoverInfo(); }
    });

    window.addEventListener('keydown', (ev) => {
      if (!S.open) return;
      if (ev.key === 'Escape') closeModal();
      if (ev.target && /INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
      if (ev.key === 'ArrowRight') stepPick(1);
      if (ev.key === 'ArrowLeft') stepPick(-1);
    });
  }

  /* ------------------------------- 初始化 ------------------------------ */
  function init() {
    if (!$('#btnDouble') || !$('#doubleModal')) return false;
    bind();
    // 主应用 afterEdit / afterStructural 回调：弹窗打开时同步重绘
    window.__dlRefresh = renderAll;
    // 测试钩子
    window.__dlAPI = {
      open: openModal, close: closeModal, isOpen: () => S.open,
      state: S,
      setEnabled, assignWarp, assignPick, warpSplit, pickAlternate, pickSplit,
      setStruct, setFoldSide, runSearch, adoptCandidate,
      locateIssue, stepPick, startPlay, stopPlay, doPrint, renderAll,
      addZone: (r, c, r1, c1) => mutate(() => dl().zones.push([r, c, r1 ?? r, c1 ?? c])),
      toggleLockCell: (p, e) => mutate(() => {
        const has = dl().lockedCells.some(([r, c]) => r === p && c === e);
        if (has) dl().lockedCells = dl().lockedCells.filter(([r, c]) => !(r === p && c === e));
        else dl().lockedCells.push([p, e]);
      }),
      model: () => S.model,
    };
    return true;
  }

  if (!init() && typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => init());
  }
})();
