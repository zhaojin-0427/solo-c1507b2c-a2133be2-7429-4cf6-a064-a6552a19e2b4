/* =====================================================================
 * dobby-ui.js — 多臂织机升综计划模块（原生 DOM + Canvas，无外部依赖）
 *
 * 通过 window.__loom 与主应用通信（state / Engine / pushHistory / afterEdit）。
 * 所有矩阵修改统一走 mutate()：先压入撤销历史，再变更，最后级联刷新，
 * 因此模块内一切操作（含批量工具与生成）都可被 Ctrl+Z 撤销。
 *
 * 升综矩阵随草稿保存（draft.dobby）；启用后替代 联结×踩踏 驱动组织图，
 * 正反面预览 / 浮线检查 / 逐纬播放随之同步。还原为踏板方案时另存为新草稿。
 * ===================================================================== */
'use strict';

(function () {

  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const CELL = 18, LEFT = 48, TOP = 22;

  const S = {
    open: false,
    reduce: null,      // 最近一次还原预览 { combos, treadles, keep:Set }
    hover: null,       // {s, p}
    gesture: null,     // 涂绘手势 { pointerId, value, last }
    locate: null,      // { pick, until }
  };

  let cvs, ov, ctx, octx;
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  const loom = () => window.__loom;
  const draft = () => loom().state.draft;
  const db = () => draft().dobby;
  const DC = () => window.DobbyCore;
  const Engine = () => loom().Engine;

  function toast(msg, ms) { if (window.toast) window.toast(msg, ms); }

  /** 统一修改入口：压历史 → 变更 → 级联（afterEdit 会回调 __dobbyRefresh 重绘） */
  function mutate(fn) {
    const L = loom();
    L.pushHistory();
    fn();
    L.afterEdit();
  }

  /* ------------------------------- 打开 / 关闭 ------------------------- */
  function openModal() {
    // 兜底：旧数据未经 normalize 时补一份默认升综计划（不进历史）
    if (!draft().dobby) {
      draft().dobby = Engine().defaultDobby(draft().picks, draft().shafts);
    }
    S.open = true;
    S.reduce = null;
    $('#dobbyModal').classList.remove('hidden');
    syncDeviceInputs();
    $('#dbTreadles').value = draft().treadles;
    renderAll();
  }

  function closeModal() {
    S.open = false;
    $('#dobbyModal').classList.add('hidden');
  }

  function renderAll() {
    if (!S.open) return;
    resizeGrid();
    renderStatus();
    renderIssues();
    renderReduce();
    updateGridInfo();
  }

  /* ------------------------------- ① 设备与限制 ------------------------ */
  function syncDeviceInputs() {
    const d = db();
    $('#dbDeviceShafts').value = d.deviceShafts;
    $('#dbMaxLift').value = d.maxLift;
    $('#dbMaxSwitch').value = d.maxSwitch;
    const P = draft().picks;
    $('#dbFrom').max = P; $('#dbTo').max = P; $('#dbTarget').max = P;
    if (!$('#dbTo').value || Number($('#dbTo').value) > P) $('#dbTo').value = P;
  }

  function setDevice(key, lo, hi) {
    const ids = { deviceShafts: '#dbDeviceShafts', maxLift: '#dbMaxLift', maxSwitch: '#dbMaxSwitch' };
    const v = clamp(parseInt($(ids[key]).value, 10) || lo, lo, hi);
    $(ids[key]).value = v;
    if (db()[key] === v) return;
    mutate(() => { db()[key] = v; });
    const names = { deviceShafts: '设备综框数', maxLift: '单纬最大升综', maxSwitch: '相邻纬最大切换' };
    toast(`${names[key]} → ${v}`);
  }

  /* ------------------------------- ② 生成 / 启停 ----------------------- */
  function generate() {
    mutate(() => {
      const d = draft();
      d.dobby.cells = DC().cellsFromDraft(d);
      d.dobby.enabled = true;
    });
    S.reduce = null;
    toast('已从当前穿综·联结·踩踏生成升综矩阵（可撤销）');
  }

  function toggleEnabled() {
    const turningOn = !db().enabled;
    mutate(() => { db().enabled = !db().enabled; });
    toast(turningOn
      ? '升综矩阵已启用：组织图由升综计划驱动'
      : '已停用：组织图恢复由联结·踩踏驱动');
  }

  function renderStatus() {
    const d = draft(), dbb = db();
    const same = JSON.stringify(dbb.cells) === JSON.stringify(DC().cellsFromDraft(d));
    $('#dbToggle').textContent = dbb.enabled ? '停用升综驱动' : '启用升综驱动';
    $('#dbStatus').textContent = dbb.enabled
      ? '升综矩阵正在驱动组织图（主图板联结·踩踏的修改暂不影响组织）' +
        (same ? '：矩阵与当前联结·踩踏一致。' : '：矩阵已自定义，与联结·踩踏不一致。')
      : '升综计划未启用：组织图由联结·踩踏驱动。' +
        (same ? '' : '矩阵已编辑，点击“启用升综驱动”后生效。');
  }

  /* ------------------------------- ③ 批量工具 -------------------------- */
  function rangeInputs() {
    const P = draft().picks;
    const from = clamp(parseInt($('#dbFrom').value, 10) || 1, 1, P);
    const to = clamp(parseInt($('#dbTo').value, 10) || from, 1, P);
    return { from: from - 1, to: to - 1 };   // 0 基
  }

  function applyCells(cells, msg) {
    mutate(() => {
      db().cells = cells;
      db().enabled = true;
    });
    S.reduce = null;   // 矩阵已变，旧还原预览失效
    toast(msg + '（可撤销）');
  }

  function batchCopy() {
    const { from, to } = rangeInputs();
    const target = clamp(parseInt($('#dbTarget').value, 10) || 1, 1, draft().picks) - 1;
    applyCells(DC().copyRange(db().cells, from, to, target),
      `已复制第 ${from + 1}–${to + 1} 纬 → 第 ${target + 1} 纬起`);
  }

  function batchCycle() {
    const { from, to } = rangeInputs();
    applyCells(DC().cycleFill(db().cells, from, to),
      `已按第 ${from + 1}–${to + 1} 纬循环填充至末尾`);
  }

  function batchMirror() {
    const { from, to } = rangeInputs();
    applyCells(DC().mirrorRange(db().cells, from, to),
      `已镜像第 ${from + 1}–${to + 1} 纬（纬次倒序）`);
  }

  function batchShift() {
    const { from, to } = rangeInputs();
    const k = clamp(parseInt($('#dbShift').value, 10) || 0, -200, 200);
    if (!k) { toast('平移量为 0，未改动'); return; }
    applyCells(DC().shiftRange(db().cells, from, to, k),
      `已把第 ${from + 1}–${to + 1} 纬平移 ${k > 0 ? '+' : ''}${k} 纬`);
  }

  function batchClear() {
    const { from, to } = rangeInputs();
    applyCells(DC().clearRange(db().cells, from, to),
      `已清空第 ${from + 1}–${to + 1} 纬`);
  }

  /* ------------------------------- ④ 设备校验 -------------------------- */
  function currentIssues() {
    const d = draft();
    return DC().validateDobby(db(), d.picks, d.shafts);
  }

  function renderIssues() {
    const issues = currentIssues();
    const box = $('#dbIssueList');
    $('#dbIssueCount').textContent = issues.length;
    box.innerHTML = '';
    if (!issues.length) {
      box.innerHTML = '<p class="hint">✓ 没有越界、超限或切换过大的纬次。</p>';
      return;
    }
    issues.forEach((iss) => {
      const row = document.createElement('div');
      row.className = 'db-issue' + (iss.level === 'warn' ? ' warn' : '');
      const tag = iss.level === 'warn' ? '⚠' : '✗';
      const txt = document.createElement('span');
      txt.className = 'db-issue-msg';
      txt.textContent = `${tag} ${iss.msg}`;
      const btn = document.createElement('button');
      btn.className = 'btn tiny';
      btn.textContent = '定位';
      btn.title = '在升综网格中高亮该纬';
      btn.addEventListener('click', () => locatePick(iss.pick));
      row.append(txt, btn);
      box.appendChild(row);
    });
  }

  function locatePick(p) {
    S.locate = { pick: p, until: Date.now() + 2400 };
    const wrap = $('#dbGridWrap');
    const y = TOP + p * CELL;
    if (wrap && wrap.scrollTo) {
      try { wrap.scrollTo({ top: Math.max(0, y - wrap.clientHeight / 2), behavior: 'smooth' }); }
      catch (e) { wrap.scrollTop = Math.max(0, y - 120); }
    } else if (wrap) {
      wrap.scrollTop = Math.max(0, y - 120);
    }
    drawOverlay();
    setTimeout(() => {
      if (S.locate && Date.now() >= S.locate.until) { S.locate = null; drawOverlay(); }
    }, 2500);
  }

  /* ------------------------------- ⑤ 还原为踏板方案 --------------------- */
  function computeReduction() {
    const d = draft();
    const combos = DC().liftCombos(db().cells);
    const treadles = clamp(parseInt($('#dbTreadles').value, 10) || d.treadles, 1, 24);
    S.reduce = { combos, treadles, keep: DC().defaultKeep(combos, treadles) };
    renderReduce();
    if (!combos.length) { toast('升综矩阵为空'); return; }
    toast(combos.length <= treadles
      ? `共 ${combos.length} 种升综组合，${treadles} 踏板可容纳`
      : `共 ${combos.length} 种升综组合，超出 ${treadles} 踏板：请勾选保留组合`, 2600);
  }

  /** 当前还原预览对应的新草稿（不改动任何状态） */
  function reducedDraft() {
    const r = S.reduce;
    const keepIdx = DC().keptOrder(r.combos, r.keep);
    return DC().applyReduction(Engine(), draft(), db().cells, r.combos, keepIdx);
  }

  function renderReduce() {
    const box = $('#dbComboList');
    const r = S.reduce;
    if (!r) {
      box.innerHTML = '<p class="hint">相同升综组合共用踏板；组合数超过可用踏板时按频次取舍。</p>';
      $('#dbDiffBox').classList.add('hidden');
      $('#dbApply').disabled = true;
      return;
    }
    const { combos, treadles } = r;
    const overflow = combos.length > treadles;
    const keepIdx = DC().keptOrder(combos, r.keep);
    const treadleOf = new Map(keepIdx.map((ci, t) => [ci, t]));

    let html = `<div class="db-reduce-head">${combos.length} 种升综组合 / 可用踏板 ${treadles}` +
      (overflow ? `　<span class="db-over">超出 ${combos.length - treadles} 个，勾选保留（已舍 ${combos.length - r.keep.size} 个）</span>`
                : '　✓ 全部容纳') + '</div>';
    box.innerHTML = html;

    // 展示顺序：频次降序 → 首现纬升序
    const order = combos.map((c, i) => i)
      .sort((a, b) => combos[b].count - combos[a].count || combos[a].first - combos[b].first);
    order.forEach(ci => {
      const c = combos[ci];
      const row = document.createElement('label');
      row.className = 'db-combo-row' + (r.keep.has(ci) ? ' keep' : ' drop');
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = r.keep.has(ci);
      chk.disabled = !overflow;
      chk.title = overflow ? '勾选 = 为该组合分配踏板' : '组合数未超踏板，全部保留';
      chk.addEventListener('change', () => {
        if (chk.checked) {
          if (r.keep.size >= treadles) {
            chk.checked = false;
            toast(`最多保留 ${treadles} 个组合（可用踏板数）`);
            return;
          }
          r.keep.add(ci);
        } else {
          r.keep.delete(ci);
        }
        renderReduce();
      });

      const tNo = document.createElement('span');
      tNo.className = 'db-combo-t';
      tNo.textContent = treadleOf.has(ci) ? `踏${treadleOf.get(ci) + 1}` : '舍弃';

      const shafts = document.createElement('span');
      shafts.className = 'db-combo-shafts';
      shafts.textContent = c.shafts.length
        ? `升 ${c.shafts.map(s => s + 1).join('、')}`
        : '（空：无综升起）';

      const freq = document.createElement('span');
      freq.className = 'db-combo-freq';
      freq.textContent = `×${c.count}`;

      const picks = document.createElement('span');
      picks.className = 'db-combo-picks';
      const show = c.picks.slice(0, 10).map(p => p + 1).join('、');
      picks.textContent = `纬 ${show}${c.picks.length > 10 ? ` …共 ${c.picks.length} 纬` : ''}`;
      picks.title = c.picks.map(p => p + 1).join('、');

      row.append(chk, tNo, shafts, freq, picks);
      box.appendChild(row);
    });

    renderDiff();
    $('#dbApply').disabled = !keepIdx.length;
  }

  /** 叠加比较：升综计划组织 vs 还原方案组织（红 = 差异格） */
  function renderDiff() {
    const d = draft();
    const { draft: nd, reduction } = reducedDraft();
    const liftDerived = DC().weaveWithCells(Engine(), d, db().cells);
    const redDerived = Engine().derive(nd);
    const diff = DC().diffDrawdowns(liftDerived.drawdown, redDerived.drawdown);

    $('#dbDiffBox').classList.remove('hidden');
    const cvsD = $('#dbDiffCanvas');
    const maxW = 300, maxH = 220;
    const sc = Math.max(1, Math.floor(Math.min(maxW / d.ends, maxH / d.picks)));
    cvsD.width = d.ends * sc;
    cvsD.height = d.picks * sc;
    const c2 = cvsD.getContext('2d');
    c2.imageSmoothingEnabled = false;
    const cg = Engine().colorGrid(d, liftDerived, 'front');
    const off = document.createElement('canvas');
    off.width = d.ends; off.height = d.picks;
    const o = off.getContext('2d');
    for (let p = 0; p < d.picks; p++) {
      for (let e = 0; e < d.ends; e++) {
        if (diff.grid[p] && diff.grid[p][e]) o.fillStyle = '#e0352a';
        else o.fillStyle = cg[p][e] || '#ddd';
        o.fillRect(e, p, 1, 1);
      }
    }
    c2.clearRect(0, 0, cvsD.width, cvsD.height);
    c2.drawImage(off, 0, 0, cvsD.width, cvsD.height);

    const total = d.ends * d.picks;
    const dropTxt = reduction.dropped.length
      ? `　${reduction.dropped.length} 纬未分配踏板（${reduction.dropped.slice(0, 8).map(p => p + 1).join('、')}${reduction.dropped.length > 8 ? '…' : ''}）`
      : '';
    $('#dbDiffText').textContent = diff.count === 0
      ? `✓ 还原方案与升综计划组织完全一致（${reduction.treadles} 踏板）。`
      : `差异 ${diff.count} / ${total} 格，涉及 ${diff.picks.length} 纬。${dropTxt}`;
  }

  function applyReduction() {
    if (!S.reduce) return;
    const { draft: nd, reduction } = reducedDraft();
    const baseName = ($('#draftName') && $('#draftName').value.trim()) || '未命名草稿';
    const name = `${baseName} 踏板方案`;
    // 主应用提供 loadDraft(draft, name, id=null)；id 置 null 即另存为新草稿
    window.loadDraft(nd, name, null);
    toast(`已还原为 ${reduction.treadles} 踏板并应用为新草稿「${name}」，原稿未改动；确认后请手动保存。`, 3200);
    closeModal();
  }

  /* ------------------------------- ⑥ 升综网格 -------------------------- */
  function gridSize() {
    const d = draft();
    return { W: LEFT + d.shafts * CELL + 4, H: TOP + d.picks * CELL + 4 };
  }

  function resizeGrid() {
    const { W, H } = gridSize();
    const sizer = $('#dbGridSizer');
    if (sizer) { sizer.style.width = W + 'px'; sizer.style.height = H + 'px'; }
    for (const c of [cvs, ov]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = W + 'px';
      c.style.height = H + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGrid();
    drawOverlay();
  }

  function drawGrid() {
    const d = draft(), dbb = db();
    const { W, H } = gridSize();
    const issues = currentIssues();
    const errRows = new Set(), warnRows = new Set();
    issues.forEach(i => (i.level === 'error' ? errRows : warnRows).add(i.pick));

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fffdf7';
    ctx.fillRect(0, 0, W, H);

    // 行底色：问题纬
    for (let p = 0; p < d.picks; p++) {
      if (errRows.has(p)) {
        ctx.fillStyle = 'rgba(179,53,42,.10)';
        ctx.fillRect(LEFT, TOP + p * CELL, d.shafts * CELL, CELL);
      } else if (warnRows.has(p)) {
        ctx.fillStyle = 'rgba(184,134,47,.10)';
        ctx.fillRect(LEFT, TOP + p * CELL, d.shafts * CELL, CELL);
      }
    }
    // 设备外综框列底色
    if (dbb.deviceShafts < d.shafts) {
      ctx.fillStyle = 'rgba(107,100,87,.12)';
      ctx.fillRect(LEFT + dbb.deviceShafts * CELL, TOP,
        (d.shafts - dbb.deviceShafts) * CELL, d.picks * CELL);
    }

    // 升综格
    ctx.fillStyle = '#2d2a24';
    for (let p = 0; p < d.picks; p++) {
      const row = dbb.cells[p] || [];
      for (let s = 0; s < d.shafts; s++) {
        if (!row[s]) continue;
        ctx.fillRect(LEFT + s * CELL + 2.5, TOP + p * CELL + 2.5, CELL - 5, CELL - 5);
      }
    }

    // 网格线
    ctx.strokeStyle = '#e4dcc9';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let s = 0; s <= d.shafts; s++) {
      const x = LEFT + s * CELL + .5;
      ctx.moveTo(x, TOP); ctx.lineTo(x, TOP + d.picks * CELL);
    }
    for (let p = 0; p <= d.picks; p++) {
      const y = TOP + p * CELL + .5;
      ctx.moveTo(LEFT, y); ctx.lineTo(LEFT + d.shafts * CELL, y);
    }
    ctx.stroke();
    ctx.strokeStyle = '#b9ae94';
    ctx.strokeRect(LEFT + .5, TOP + .5, d.shafts * CELL - 1, d.picks * CELL - 1);

    // 表头：综框编号（设备外灰色）
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let s = 0; s < d.shafts; s++) {
      ctx.fillStyle = s >= dbb.deviceShafts ? '#b0a891' : '#6b6457';
      ctx.fillText(String(s + 1), LEFT + s * CELL + CELL / 2, TOP / 2 + 1);
    }
    // 左侧：纬线色条 + 纬号（问题纬着色）
    for (let p = 0; p < d.picks; p++) {
      const wc = d.palette[d.weftColor[p]];
      ctx.fillStyle = wc ? wc.hex : '#888';
      ctx.fillRect(0, TOP + p * CELL, 8, CELL);
      ctx.fillStyle = errRows.has(p) ? '#b3352a' : warnRows.has(p) ? '#b8862f' : '#6b6457';
      ctx.fillText(String(p + 1), 28, TOP + p * CELL + CELL / 2 + .5);
    }
    ctx.strokeStyle = '#b9ae94';
    ctx.strokeRect(.5, TOP + .5, 8, d.picks * CELL - 1);
  }

  function drawOverlay() {
    const d = draft();
    const { W, H } = gridSize();
    octx.clearRect(0, 0, W, H);

    // 定位闪烁（静态高亮，定时清除）
    if (S.locate && Date.now() < S.locate.until) {
      const p = S.locate.pick;
      octx.fillStyle = 'rgba(41,82,140,.18)';
      octx.fillRect(LEFT, TOP + p * CELL, d.shafts * CELL, CELL);
      octx.strokeStyle = '#29528c';
      octx.lineWidth = 2;
      octx.strokeRect(LEFT + 1, TOP + p * CELL + 1, d.shafts * CELL - 2, CELL - 2);
    }

    // 悬停格
    if (S.hover) {
      octx.fillStyle = 'rgba(217,164,65,.3)';
      octx.fillRect(LEFT + S.hover.s * CELL, TOP + S.hover.p * CELL, CELL, CELL);
      octx.strokeStyle = '#9c6b1f';
      octx.lineWidth = 1.5;
      octx.strokeRect(LEFT + S.hover.s * CELL + .75, TOP + S.hover.p * CELL + .75, CELL - 1.5, CELL - 1.5);
    }
  }

  function eventCell(ev) {
    const rect = cvs.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    const d = draft();
    const s = Math.floor((x - LEFT) / CELL), p = Math.floor((y - TOP) / CELL);
    if (s < 0 || p < 0 || s >= d.shafts || p >= d.picks) return null;
    return { s, p };
  }

  function paintCell(cell, value) {
    if (!cell) return;
    const row = db().cells[cell.p];
    if (!row || !!row[cell.s] === value) return;
    row[cell.s] = value;
    db().enabled = true;      // 手动编辑即启用升综驱动
    S.reduce = null;          // 矩阵已变，旧还原预览失效
    loom().afterEdit();
  }

  function updateGridInfo() {
    const d = draft(), dbb = db();
    const combos = DC().liftCombos(dbb.cells).length;
    let txt = `共 ${d.picks} 纬 × ${d.shafts} 综框 · ${combos} 种升综组合`;
    if (S.hover) {
      const lifts = DC().liftCounts(dbb.cells)[S.hover.p];
      const sw = DC().switchCounts(dbb.cells)[S.hover.p];
      txt += `　｜　第 ${S.hover.p + 1} 纬 · 综框 ${S.hover.s + 1}：` +
        `${dbb.cells[S.hover.p][S.hover.s] ? '升起' : '落下'}　本纬升 ${lifts} 综 · 切换 ${sw}`;
    }
    $('#dbGridInfo').textContent = txt;
  }

  /* ------------------------------- 打印 -------------------------------- */
  function doPrint() {
    const d = draft(), dbb = db();
    const issues = currentIssues();
    const lifts = DC().liftCounts(dbb.cells);
    const switches = DC().switchCounts(dbb.cells);
    const errs = issues.filter(i => i.level === 'error');

    $('#dbPrintTitle').textContent = `${$('#draftName').value} — 多臂织机升综计划`;
    $('#dbPrintMeta').innerHTML =
      `打印时间：${new Date().toLocaleString()}<br>` +
      `综框 ${d.shafts}（设备 ${dbb.deviceShafts}）　纬数 ${d.picks}　` +
      `单纬最大升综 ${dbb.maxLift}　相邻纬最大切换 ${dbb.maxSwitch}　` +
      `升综组合 ${DC().liftCombos(dbb.cells).length} 种<br>` +
      `状态：${dbb.enabled ? '升综矩阵驱动组织图' : '未启用（组织图由联结·踩踏驱动）'}　` +
      `校验：错误 ${errs.length}　警告 ${issues.length - errs.length}`;

    // 打印矩阵：综框编号在上、纬号在左、问题纬着色
    const PC = 12, PL = 34, PT = 16;
    const W = PL + d.shafts * PC + 6, H = PT + d.picks * PC + 6;
    const pc = $('#dbPrintCanvas');
    pc.width = W; pc.height = H;
    const c = pc.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, W, H);
    const errRows = new Set(), warnRows = new Set();
    issues.forEach(i => (i.level === 'error' ? errRows : warnRows).add(i.pick));
    for (let p = 0; p < d.picks; p++) {
      if (errRows.has(p)) { c.fillStyle = 'rgba(179,53,42,.12)'; c.fillRect(PL, PT + p * PC, d.shafts * PC, PC); }
      else if (warnRows.has(p)) { c.fillStyle = 'rgba(184,134,47,.12)'; c.fillRect(PL, PT + p * PC, d.shafts * PC, PC); }
    }
    if (dbb.deviceShafts < d.shafts) {
      c.fillStyle = 'rgba(107,100,87,.14)';
      c.fillRect(PL + dbb.deviceShafts * PC, PT, (d.shafts - dbb.deviceShafts) * PC, d.picks * PC);
    }
    c.fillStyle = '#222';
    for (let p = 0; p < d.picks; p++)
      for (let s = 0; s < d.shafts; s++)
        if (dbb.cells[p] && dbb.cells[p][s])
          c.fillRect(PL + s * PC + 1.5, PT + p * PC + 1.5, PC - 3, PC - 3);
    c.strokeStyle = '#bbb';
    c.lineWidth = 1;
    c.beginPath();
    for (let s = 0; s <= d.shafts; s++) {
      const x = PL + s * PC + .5;
      c.moveTo(x, PT); c.lineTo(x, PT + d.picks * PC);
    }
    for (let p = 0; p <= d.picks; p++) {
      const y = PT + p * PC + .5;
      c.moveTo(PL, y); c.lineTo(PL + d.shafts * PC, y);
    }
    c.stroke();
    c.strokeStyle = '#666';
    c.strokeRect(PL + .5, PT + .5, d.shafts * PC - 1, d.picks * PC - 1);
    c.font = '7px sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let s = 0; s < d.shafts; s++) {
      c.fillStyle = s >= dbb.deviceShafts ? '#a09880' : '#333';
      c.fillText(String(s + 1), PL + s * PC + PC / 2, PT / 2);
    }
    for (let p = 0; p < d.picks; p++) {
      c.fillStyle = errRows.has(p) ? '#b3352a' : warnRows.has(p) ? '#b8862f' : '#333';
      c.fillText(String(p + 1), PL / 2, PT + p * PC + PC / 2 + .5);
    }

    // 逐纬动作 + 警告
    const issByPick = new Map();
    issues.forEach(i => {
      if (!issByPick.has(i.pick)) issByPick.set(i.pick, []);
      issByPick.get(i.pick).push(i.msg);
    });
    let html = '';
    for (let p = 0; p < d.picks; p++) {
      const up = [];
      for (let s = 0; s < d.shafts; s++) if (dbb.cells[p] && dbb.cells[p][s]) up.push(s + 1);
      const warn = issByPick.get(p);
      html += `<div class="db-print-row${warn ? ' warn' : ''}">` +
        `<b>第 ${p + 1} 纬</b>：升 ${up.length ? up.join('、') : '—'}（${lifts[p]} 综）` +
        (p > 0 ? ` · 切换 ${switches[p]}` : '') +
        (warn ? `<br><span class="db-print-warn">${warn.map(escapeHtml).join('<br>')}</span>` : '') +
        '</div>';
    }
    $('#dbPrintLegend').innerHTML = html ||
      '<p>升综矩阵为空。</p>';

    document.body.classList.add('db-printing');
    setTimeout(() => {
      window.print();
      setTimeout(() => document.body.classList.remove('db-printing'), 600);
    }, 120);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, ch =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  /* ------------------------------- 事件绑定 ---------------------------- */
  function bind() {
    $('#btnDobby').addEventListener('click', openModal);
    document.querySelectorAll('[data-close-db]').forEach(b =>
      b.addEventListener('click', closeModal));
    $('#dobbyModal').addEventListener('click', (e) => {
      if (e.target.id === 'dobbyModal') closeModal();
    });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && S.open) closeModal();
    });

    $('#dbDeviceShafts').addEventListener('change', () => setDevice('deviceShafts', 1, 24));
    $('#dbMaxLift').addEventListener('change', () => setDevice('maxLift', 1, 24));
    $('#dbMaxSwitch').addEventListener('change', () => setDevice('maxSwitch', 1, 24));
    $('#dbGenerate').addEventListener('click', generate);
    $('#dbToggle').addEventListener('click', toggleEnabled);
    $('#dbCopy').addEventListener('click', batchCopy);
    $('#dbCycle').addEventListener('click', batchCycle);
    $('#dbMirror').addEventListener('click', batchMirror);
    $('#dbShiftApply').addEventListener('click', batchShift);
    $('#dbClearRange').addEventListener('click', batchClear);
    $('#dbReduce').addEventListener('click', computeReduction);
    $('#dbApply').addEventListener('click', applyReduction);
    $('#dbPrint').addEventListener('click', doPrint);

    cvs.addEventListener('pointerdown', (ev) => {
      const cell = eventCell(ev);
      if (!cell) return;
      if (cvs.setPointerCapture) cvs.setPointerCapture(ev.pointerId);
      loom().pushHistory();
      const value = ev.button === 2 ? false : !db().cells[cell.p][cell.s];
      S.gesture = { pointerId: ev.pointerId, value, last: cell };
      paintCell(cell, value);
      updateGridInfo();
    });
    cvs.addEventListener('pointermove', (ev) => {
      const cell = eventCell(ev);
      S.hover = cell;
      drawOverlay();
      updateGridInfo();
      const g = S.gesture;
      if (!g || g.pointerId !== ev.pointerId || !cell) return;
      if (g.last.s === cell.s && g.last.p === cell.p) return;
      g.last = cell;
      paintCell(cell, g.value);
    });
    window.addEventListener('pointerup', (ev) => {
      if (S.gesture && S.gesture.pointerId === ev.pointerId) S.gesture = null;
    });
    cvs.addEventListener('pointerleave', () => {
      if (!S.gesture) { S.hover = null; drawOverlay(); updateGridInfo(); }
    });
    cvs.addEventListener('contextmenu', e => e.preventDefault());
  }

  /* ------------------------------- 初始化 ------------------------------ */
  function init() {
    if (!$('#btnDobby') || !$('#dobbyModal')) return false;
    cvs = $('#dbCanvas'); ov = $('#dbOverlay');
    ctx = cvs.getContext('2d'); octx = ov.getContext('2d');
    bind();
    // 主应用 afterEdit / afterStructural 回调：模态打开时同步重绘
    window.__dobbyRefresh = renderAll;
    // 测试钩子
    window.__dobbyAPI = {
      open: openModal,
      close: closeModal,
      isOpen: () => S.open,
      state: S,
      generate, toggleEnabled, computeReduction, applyReduction, doPrint,
      batchCopy, batchCycle, batchMirror, batchShift, batchClear,
      locatePick, renderAll,
    };
    return true;
  }

  if (!init() && typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => init());
  }
})();
