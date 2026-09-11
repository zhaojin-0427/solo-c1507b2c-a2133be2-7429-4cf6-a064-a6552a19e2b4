/* =====================================================================
 * defect-ui.js — 试织缺陷回标模块（原生 DOM + Canvas，无外部依赖）
 *
 * 通过 window.__loom 读取当前草稿 / Engine / loadDraft；
 * 批次、标记、修订记录全部经 /api/batches* 持久化到 SQLite。
 * 归档批次不可改写：画布不能再加点 / 拖动，备注与删除禁用，修订只能另存于开放批次。
 * ===================================================================== */
'use strict';

(function () {

  const $ = (s) => document.querySelector(s);
  const DC = () => window.DefectCore;
  const Engine = () => window.__loom.Engine;
  const deepClone = (o) => JSON.parse(JSON.stringify(o));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

  const RULER_T = 26, RULER_L = 42;   // 上 / 左标尺宽（px）

  const S = {
    open: false,
    list: [],
    fullCache: new Map(),    // id -> 完整批次（含快照 / 标记），跨批次分析复用
    current: null,
    activeType: 'miss',
    hiddenTypes: new Set(),
    selectedMarkId: null,
    tab: 'marks',
    zoomUser: 1,
    scaleFit: 3,
    showHeat: true,
    showGrid: true,
    drag: null,
    pending: null,
    hover: null,
    recurrence: null,
    rev: null,               // 修订构建器状态
  };

  function toast(msg, ms) { if (window.toast) window.toast(msg, ms); }
  function snap() { return S.current && S.current.snapshot; }
  function params() {
    const b = S.current;
    return b ? DC().normalizeParams({
      warpDensity: b.warpDensity, weftDensity: b.weftDensity,
      warpShrink: b.warpShrink, weftShrink: b.weftShrink,
      originX: b.originX, originY: b.originY,
    }) : DC().normalizeParams({});
  }
  const archived = () => !!(S.current && S.current.status === 'archived');

  async function req(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    return res.status === 204 ? null : res.json();
  }

  /* ============================== 打开 / 关闭 ========================== */
  function openModal() {
    S.open = true;
    $('#defectModal').classList.remove('hidden');
    setupCanvasOnce();
    switchTab('marks');
    refreshList().then(() => {
      if (S.list.length) openBatch(S.list[0].id).catch(() => {});
      fitZoom();
    });
  }
  function closeModal() {
    S.open = false;
    $('#defectModal').classList.add('hidden');
  }

  /* ============================== 批次列表 ============================ */
  async function refreshList() {
    let rows;
    try { rows = await req('GET', '/api/batches'); }
    catch (e) { $('#dfBatchList').innerHTML = '<p class="hint">无法读取批次：' + e.message + '</p>'; S.list = []; return; }
    S.list = rows;
    const statusF = $('#dfStatusFilter').value;
    const sourceF = $('#dfSourceFilter').value;
    const cur = window.__loom.state;
    const box = $('#dfBatchList');
    box.innerHTML = '';
    const visible = rows.filter(b => {
      if (statusF && b.status !== statusF) return false;
      if (sourceF === 'current' && cur.savedId != null && b.draftId !== cur.savedId) return false;
      return true;
    });
    if (!visible.length) {
      box.innerHTML = '<p class="hint">还没有试织批次。</p>';
    }
    visible.forEach(b => {
      const row = document.createElement('div');
      row.className = 'df-batch' + (S.current && S.current.id === b.id ? ' sel' : '') +
                      (b.status === 'archived' ? ' arch' : '');
      const typeCount = {};
      row.innerHTML =
        `<div class="df-batch-name">${escapeHtml(b.name)}
           ${b.status === 'archived' ? '<span class="df-tag df-tag-arch">已归档</span>' : '<span class="df-tag df-tag-open">试织中</span>'}
         </div>
         <div class="df-batch-meta">${escapeHtml(b.draftName)} · ${b.markCount} 处标记 ·
           ${String(b.createdAt || '').replace('T', ' ').slice(0, 16)}</div>`;
      row.addEventListener('click', () => openBatch(b.id));
      box.appendChild(row);
    });
    $('#dfMarkCount').textContent = S.current ? S.current.marks.length : 0;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ============================== 建立批次 ============================ */
  function showCreateForm() {
    const d = window.__loom.state.draft;
    $('#dfCreateForm').classList.remove('hidden');
    $('#dfBatchName').value = $('#draftName').value.replace(/\S+/, m => m) + ' 试织 ' +
      new Date().toISOString().slice(5, 10);
    updateClothSizeHint();
  }
  function hideCreateForm() { $('#dfCreateForm').classList.add('hidden'); }

  function updateClothSizeHint() {
    const d = window.__loom.state.draft;
    const wd = parseFloat($('#dfWarpDensity').value) || 10;
    const fd = parseFloat($('#dfWeftDensity').value) || 10;
    const ws = parseFloat($('#dfWarpShrink').value) || 0;
    const fs = parseFloat($('#dfWeftShrink').value) || 0;
    const ox = parseFloat($('#dfOriginX').value) || 0;
    const oy = parseFloat($('#dfOriginY').value) || 0;
    const wMm = d.ends * 10 / wd, hMm = d.picks * 10 / fd;
    $('#dfClothSize').textContent =
      `快照 ${d.ends} 经 × ${d.picks} 纬；预计成品布面 ${fmt1(wMm)} × ${fmt1(hMm)} mm；` +
      `原点距左 ${fmt1(ox)} mm、距布首 ${fmt1(oy)} mm。` +
      `上机尺寸（按缩率还原）约 ${fmt1(wMm / (1 - ws / 100))} × ${fmt1(hMm / (1 - fs / 100))} mm。`;
  }

  async function submitCreate() {
    const cur = window.__loom.state;
    const name = ($('#dfBatchName').value || '').trim() || '未命名批次';
    const payload = {
      name,
      snapshot: deepClone(cur.draft),
      draftId: cur.savedId,
      draftName: $('#draftName').value || '未保存草稿',
      warpDensity: parseFloat($('#dfWarpDensity').value),
      weftDensity: parseFloat($('#dfWeftDensity').value),
      warpShrink: parseFloat($('#dfWarpShrink').value),
      weftShrink: parseFloat($('#dfWeftShrink').value),
      originX: parseFloat($('#dfOriginX').value),
      originY: parseFloat($('#dfOriginY').value),
    };
    if (![payload.warpDensity, payload.weftDensity].every(v => v > 0)) { toast('经纬密度需大于 0'); return; }
    try {
      const b = await req('POST', '/api/batches', payload);
      hideCreateForm();
      toast(`批次「${name}」已建立（快照已冻结）`);
      await refreshList();
      await openBatch(b.id);
    } catch (e) { toast('建立失败：' + e.message, 3000); }
  }

  /* ============================== 打开批次 ============================ */
  async function openBatch(id) {
    let b;
    try { b = await req('GET', `/api/batches/${id}`); }
    catch (e) { toast('读取批次失败：' + e.message, 3000); return; }
    // 旧快照补字段（多梭等），保证分析口径与当前应用一致
    b.snapshot = window.__loom.normalizeDraft(b.snapshot);
    // 用完整推导口径覆盖仅由穿综/踩踏周期得到的循环
    const rep = DC().snapshotRepeats(Engine(), b.snapshot);
    b.repeatWarp = rep.warp; b.repeatWeft = rep.weft;
    S.current = b;
    S.fullCache.set(id, b);
    S.selectedMarkId = null;
    S.recurrence = null;
    S.rev = null;
    renderMeta();
    refreshList();
    resizeBoard();
    redraw();
    renderMarkList();
    renderRevList();
    renderSideViews();
    renderReviseBox(null);
    fitZoom();
  }

  function renderMeta() {
    const b = S.current;
    const el = $('#dfBatchMeta');
    if (!b) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML =
      `<div class="df-bm-title">${escapeHtml(b.name)}</div>
       <table class="df-bm-table">
         <tr><td>来源草稿</td><td>${escapeHtml(b.draftName)}${b.draftId != null ? ` (#${b.draftId})` : '（未保存）'}</td></tr>
         <tr><td>快照尺寸</td><td>${b.snapshot.ends} 经 × ${b.snapshot.picks} 纬 · ${b.snapshot.shafts} 综框 / ${b.snapshot.treadles} 踏板</td></tr>
         <tr><td>实测密度</td><td>经 ${b.warpDensity} /cm　纬 ${b.weftDensity} /cm（间距 ${fmt1(10 / b.warpDensity)} × ${fmt1(10 / b.weftDensity)} mm）</td></tr>
         <tr><td>缩率 / 原点</td><td>经 ${b.warpShrink}% 纬 ${b.weftShrink}%　原点 (${fmt1(b.originX)}, ${fmt1(b.originY)}) mm</td></tr>
         <tr><td>最小循环</td><td>经 ${b.repeatWarp} × 纬 ${b.repeatWeft}</td></tr>
         <tr><td>状态</td><td>${b.status === 'archived' ? '已归档（不可改写）' : '试织中（可增改标记）'}</td></tr>
       </table>`;
    $('#dfArchive').disabled = b.status === 'archived';
    $('#dfArchive').textContent = b.status === 'archived' ? '✓ 已归档' : '📦 归档批次';
    $('#dfTypeRow').classList.toggle('disabled', archived());
    $('#dfPrint').disabled = false;
  }

  async function archiveCurrent() {
    const b = S.current;
    if (!b || archived()) return;
    if (!confirm(`归档批次「${b.name}」？归档后标记与修订记录均不可再改写。`)) return;
    try {
      await req('POST', `/api/batches/${b.id}/archive`);
      toast('批次已归档');
      await refreshList();
      await openBatch(b.id);
    } catch (e) { toast('归档失败：' + e.message, 3000); }
  }

  /* ============================== 画布几何 ============================ */
  let baseCvs, ovCvs, baseCtx, ovCtx, inited = false;
  const dpr = () => Math.max(1, window.devicePixelRatio || 1);

  function setupCanvasOnce() {
    if (inited) return;
    baseCvs = $('#dfBase'); ovCvs = $('#dfOverlay');
    baseCtx = baseCvs.getContext('2d'); ovCtx = ovCvs.getContext('2d');
    ovCvs.addEventListener('pointerdown', onPointerDown);
    ovCvs.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    ovCvs.addEventListener('contextmenu', e => e.preventDefault());
    inited = true;
  }

  function world() {
    const b = S.current;
    if (!b) return { xMin: 0, xMax: 100, yMin: 0, yMax: 100, cloth: null };
    const q = params();
    const p = DC().pitch(q);
    const clothW = b.snapshot.ends * p.x, clothH = b.snapshot.picks * p.y;
    const xMin = Math.min(-20, q.originX - 30);
    const yMin = Math.min(-20, q.originY - 30);
    const xMax = Math.max(q.originX + clothW + 40, 60);
    const yMax = Math.max(q.originY + clothH + 40, 60);
    return { xMin, xMax, yMin, yMax, clothW, clothH, q, pitch: p };
  }

  const scale = () => S.scaleFit * S.zoomUser;
  const sx = (xMm) => RULER_L + (xMm - world().xMin) * scale();
  const sy = (yMm) => RULER_T + (yMm - world().yMin) * scale();

  function resizeBoard() {
    if (!inited || !S.current) return;
    const w = world();
    const Wpx = RULER_L + (w.xMax - w.xMin) * scale();
    const Hpx = RULER_T + (w.yMax - w.yMin) * scale();
    for (const [cvs, ctx] of [[baseCvs, baseCtx], [ovCvs, ovCtx]]) {
      cvs.width = Math.round(Wpx * dpr());
      cvs.height = Math.round(Hpx * dpr());
      cvs.style.width = Wpx + 'px';
      cvs.style.height = Hpx + 'px';
      ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    }
  }

  function fitZoom() {
    if (!S.current) return;
    const vp = $('#dfViewport');
    const w = world();
    const mmW = w.xMax - w.xMin, mmH = w.yMax - w.yMin;
    S.scaleFit = clamp(Math.min((vp.clientWidth - 20 - RULER_L) / mmW,
                                (vp.clientHeight - 20 - RULER_T) / mmH), 0.6, 12);
    S.zoomUser = 1;
    $('#dfZoomLabel').textContent = '100%';
    resizeBoard();
    redraw();
  }

  function setZoom(factor) {
    S.zoomUser = clamp(S.zoomUser * factor, 0.35, 8);
    $('#dfZoomLabel').textContent = Math.round(S.zoomUser * 100) + '%';
    resizeBoard(); redraw();
  }

  function eventMm(ev) {
    const rect = ovCvs.getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    const w = world();
    return { x: w.xMin + (px - RULER_L) / scale(), y: w.yMin + (py - RULER_T) / scale(), px, py };
  }

  /* ============================== 绘制：底图 ========================== */
  function redraw() {
    if (!inited || !S.current) return;
    drawBase();
    drawOverlay();
  }

  function drawBase() {
    const b = S.current, ctx = baseCtx, w = world();
    const Wpx = parseFloat(baseCvs.style.width), Hpx = parseFloat(baseCvs.style.height);
    ctx.clearRect(0, 0, Wpx, Hpx);

    // 工作区底
    ctx.fillStyle = '#f6f1e7';
    ctx.fillRect(RULER_L, RULER_T, Wpx - RULER_L, Hpx - RULER_T);

    drawRulers(ctx, w, Wpx, Hpx);
    drawCloth(ctx, b, w);
    if (S.showHeat) drawHeat(ctx, b, w);
    drawTiles(ctx, b, w);
  }

  function drawRulers(ctx, w, Wpx, Hpx) {
    // 尺带
    ctx.fillStyle = '#fffdf7';
    ctx.fillRect(0, 0, Wpx, RULER_T);
    ctx.fillRect(0, 0, RULER_L, Hpx);
    ctx.strokeStyle = '#b9ae94';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_T + .5); ctx.lineTo(Wpx, RULER_T + .5);
    ctx.moveTo(RULER_L + .5, 0); ctx.lineTo(RULER_L + .5, Hpx);
    ctx.stroke();

    const s = scale();
    ctx.font = '9px ui-monospace, Menlo, monospace';
    ctx.fillStyle = '#6b6457';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const x0 = Math.ceil(w.xMin / 10) * 10;
    for (let mm = x0; mm <= w.xMax; mm += 10) {
      const x = sx(mm);
      ctx.strokeStyle = '#8d8572';
      ctx.beginPath(); ctx.moveTo(x, RULER_T); ctx.lineTo(x, RULER_T - 7); ctx.stroke();
      ctx.fillText(String(mm), x, 2);
      // 半刻度（5 mm）与毫米网格
      ctx.strokeStyle = '#d8cfba';
      ctx.beginPath(); ctx.moveTo(x + 5 * s, RULER_T); ctx.lineTo(x + 5 * s, RULER_T - 4); ctx.stroke();
      if (S.showGrid) {
        ctx.strokeStyle = 'rgba(185,174,148,.28)';
        ctx.beginPath(); ctx.moveTo(x, RULER_T); ctx.lineTo(x, Hpx); ctx.stroke();
      }
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const y0 = Math.ceil(w.yMin / 10) * 10;
    for (let mm = y0; mm <= w.yMax; mm += 10) {
      const y = sy(mm);
      ctx.strokeStyle = '#8d8572';
      ctx.beginPath(); ctx.moveTo(RULER_L, y); ctx.lineTo(RULER_L - 7, y); ctx.stroke();
      ctx.fillText(String(mm), RULER_L - 9, y);
      ctx.strokeStyle = '#d8cfba';
      ctx.beginPath(); ctx.moveTo(RULER_L - 4, y + 5 * s); ctx.lineTo(RULER_L, y + 5 * s); ctx.stroke();
      if (S.showGrid) {
        ctx.strokeStyle = 'rgba(185,174,148,.28)';
        ctx.beginPath(); ctx.moveTo(RULER_L, y); ctx.lineTo(Wpx, y); ctx.stroke();
      }
    }
    // 坐标 0 轴（布边 / 布首基准）
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#9c4a2f';
    ctx.lineWidth = 1.2;
    if (0 >= w.xMin && 0 <= w.xMax) {
      ctx.beginPath(); ctx.moveTo(sx(0), RULER_T); ctx.lineTo(sx(0), Hpx); ctx.stroke();
    }
    if (0 >= w.yMin && 0 <= w.yMax) {
      ctx.beginPath(); ctx.moveTo(RULER_L, sy(0)); ctx.lineTo(Wpx, sy(0)); ctx.stroke();
    }
    ctx.restore();
  }

  function drawCloth(ctx, b, w) {
    const q = w.q, p = w.pitch;
    const x0 = q.originX, y0 = q.originY, cw = w.clothW, ch = w.clothH;
    const px0 = sx(x0), py0 = sy(y0), pw = cw * scale(), ph = ch * scale();

    // 布面
    ctx.fillStyle = '#fffdf7';
    ctx.fillRect(px0, py0, pw, ph);

    // 经 / 纬间距细线
    if (S.showGrid && scale() * Math.min(p.x, p.y) >= 2) {
      ctx.strokeStyle = 'rgba(180,168,140,.55)';
      ctx.lineWidth = .5;
      ctx.beginPath();
      for (let e = 1; e < b.snapshot.ends; e++) {
        const x = px0 + e * p.x * scale();
        ctx.moveTo(x, py0); ctx.lineTo(x, py0 + ph);
      }
      for (let k = 1; k < b.snapshot.picks; k++) {
        const y = py0 + k * p.y * scale();
        ctx.moveTo(px0, y); ctx.lineTo(px0 + pw, y);
      }
      ctx.stroke();
    }

    // 原点标记
    ctx.strokeStyle = '#2d2a24';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(px0 + .5, py0 + .5, pw - 1, ph - 1);
    ctx.fillStyle = '#2d2a24';
    ctx.beginPath(); ctx.arc(px0, py0, 3, 0, Math.PI * 2); ctx.fill();
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(`原点 (${fmt1(x0)}, ${fmt1(y0)})`, px0 + 5, py0 - 4);

    // 布面外提示色边（幅外区域）
    ctx.save();
    ctx.strokeStyle = 'rgba(156,74,47,.35)';
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(px0 - .5, py0 - .5, pw + 1, ph + 1);
    ctx.restore();
  }

  /** 按缺陷类型叠加半透明热区，反复出现处颜色自然加深 */
  function drawHeat(ctx, b, w) {
    const q = w.q, p = w.pitch;
    const rMm = Math.max(2.2 * Math.max(p.x, p.y), 2.5);
    ctx.save();
    for (const m of visibleMarks()) {
      const x = sx(m.mmX), y = sy(m.mmY);
      const r = rMm * scale();
      const color = DC().TYPE_COLORS[m.type] || '#888';
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, hexA(color, .28));
      g.addColorStop(.6, hexA(color, .12));
      g.addColorStop(1, hexA(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /** 最小循环砖线 */
  function drawTiles(ctx, b, w) {
    const q = w.q, p = w.pitch;
    const rw = b.repeatWarp, rh = b.repeatWeft;
    if (!rw || !rh) return;
    const px0 = sx(q.originX), py0 = sy(q.originY);
    const tw = rw * p.x * scale(), th = rh * p.y * scale();
    ctx.save();
    ctx.strokeStyle = 'rgba(41,82,140,.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = px0 + tw; x < px0 + w.clothW * scale(); x += tw) {
      ctx.moveTo(x, py0); ctx.lineTo(x, py0 + w.clothH * scale());
    }
    for (let y = py0 + th; y < py0 + w.clothH * scale(); y += th) {
      ctx.moveTo(px0, y); ctx.lineTo(px0 + w.clothW * scale(), y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  }

  /* ============================== 绘制：标记层 ======================== */
  function visibleMarks() {
    if (!S.current) return [];
    return S.current.marks.filter(m => !S.hiddenTypes.has(m.type));
  }

  function groupOf(mark) {
    if (!S.recurrence) return null;
    return S.recurrence.markGroup.get(`${S.current.id}:${mark.id}`) || null;
  }

  function drawOverlay() {
    const b = S.current, ctx = ovCtx;
    const Wpx = parseFloat(ovCvs.style.width), Hpx = parseFloat(ovCvs.style.height);
    ctx.clearRect(0, 0, Wpx, Hpx);
    if (!b) return;
    const loc = S.drag && S.drag.mm ? S.drag.mm : null;

    for (const m of visibleMarks()) {
      const x = sx(m.mmX), y = sy(m.mmY);
      const g = groupOf(m);
      const selected = m.id === S.selectedMarkId;
      const color = DC().TYPE_COLORS[m.type];

      // 跨循环：虚线外环；跨批次：红色双星外环
      ctx.save();
      if (g && (g.crossCycle || g.crossBatch)) {
        ctx.strokeStyle = g.crossBatch ? '#b3352a' : '#29528c';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([3, 2]);
        ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        if (g.crossBatch) {
          ctx.fillStyle = '#b3352a';
          ctx.font = 'bold 9px sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('↔', x + 11, y - 10);
        }
      }
      // 针点
      ctx.beginPath();
      ctx.arc(x, y, selected ? 10 : 8.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = selected ? 2.5 : 1.2;
      ctx.strokeStyle = selected ? '#2d2a24' : 'rgba(45,42,36,.7)';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(DC().TYPE_GLYPHS[m.type], x, y + .5);
      ctx.restore();
    }

    // 拖动中的新位置虚影
    if (loc) {
      ctx.save();
      ctx.strokeStyle = DC().TYPE_COLORS[S.activeType];
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx(loc.x), sy(loc.y), 9, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // 悬停坐标十字
    if (S.hover && !S.drag) {
      const { px, py } = S.hover;
      ctx.save();
      ctx.strokeStyle = 'rgba(45,42,36,.35)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(RULER_L, py); ctx.lineTo(Wpx, py);
      ctx.moveTo(px, RULER_T); ctx.lineTo(px, Hpx);
      ctx.stroke();
      ctx.restore();
    }
  }

  function hitMark(px, py) {
    let best = null, bd = 12 * 12;
    for (const m of visibleMarks()) {
      const dx = px - sx(m.mmX), dy = py - sy(m.mmY);
      const d = dx * dx + dy * dy;
      if (d <= bd) { best = m; bd = d; }
    }
    return best;
  }

  /* ============================== 指针交互 ============================ */
  function onPointerDown(ev) {
    if (!S.current) return;
    const pos = eventMm(ev);
    const hit = hitMark(pos.px, pos.py);

    // 右键：切换该类型显隐（点空白时）或删除标记（Alt+右键）
    if (ev.button === 2) {
      if (!hit) {
        if (S.hiddenTypes.has(S.activeType)) S.hiddenTypes.delete(S.activeType);
        else S.hiddenTypes.add(S.activeType);
        redraw(); renderMarkList();
        toast(`「${DC().TYPE_NAMES[S.activeType]}」标记${S.hiddenTypes.has(S.activeType) ? '已隐藏' : '已显示'}`);
      }
      return;
    }
    if (ev.button !== 0) return;

    if (hit) {
      selectMark(hit.id, false);
      if (!archived()) {
        ovCvs.setPointerCapture(ev.pointerId);
        S.drag = { id: hit.id, pointerId: ev.pointerId, startX: pos.px, startY: pos.py, moved: false, mm: null };
      }
    } else {
      if (archived()) { toast('批次已归档，不能新增标记'); return; }
      if (pos.px < RULER_L || pos.py < RULER_T) return;
      ovCvs.setPointerCapture(ev.pointerId);
      S.pending = { pointerId: ev.pointerId, mm: { x: pos.x, y: pos.y }, moved: false };
      S.drag = { id: null, pointerId: ev.pointerId, startX: pos.px, startY: pos.py, moved: false, mm: { x: pos.x, y: pos.y } };
    }
  }

  function onPointerMove(ev) {
    const pos = eventMm(ev);
    S.hover = pos;
    updateCoordReadout(pos);
    const g = S.drag;
    if (!g || g.pointerId !== ev.pointerId) { redraw(); return; }
    if (Math.hypot(pos.px - g.startX, pos.py - g.startY) > 3) g.moved = true;
    if (g.moved) {
      g.mm = { x: pos.x, y: pos.y };
      if (S.pending) S.pending.mm = { x: pos.x, y: pos.y };
    }
    redraw();
  }

  async function onPointerUp(ev) {
    const g = S.drag;
    S.drag = null;
    if (!g || g.pointerId !== ev.pointerId) { redraw(); return; }
    if (S.pending) {
      const pend = S.pending; S.pending = null;
      if (!g.moved) await createMark(pend.mm.x, pend.mm.y);
      redraw();
      return;
    }
    if (g.id != null && g.moved && g.mm) {
      await moveMark(g.id, g.mm.x, g.mm.y);
    }
    redraw();
  }

  function updateCoordReadout(pos) {
    if (!S.current) { $('#dfCoord').textContent = '实物坐标 —'; return; }
    const q = params();
    const loc = DC().locate(pos.x, pos.y, q, S.current.snapshot);
    const endTxt = loc.inWarp ? `经 ${loc.end + 1}` : (loc.end >= 0 ? `经 ${loc.end + 1}（幅外）` : '布边外');
    const pickTxt = loc.inWeft ? `纬 ${loc.pick + 1}` : (loc.pick >= 0 ? `纬 ${loc.pick + 1}（幅外）` : '布首外');
    $('#dfCoord').textContent =
      `实物 (${fmt1(pos.x)}, ${fmt1(pos.y)}) mm → ${endTxt}，${pickTxt}　上机 (${fmt1(loc.loomX)}, ${fmt1(loc.loomY)}) mm`;
  }

  /* ============================== 标记增改删 ========================== */
  async function createMark(mmX, mmY) {
    try {
      const m = await req('POST', `/api/batches/${S.current.id}/marks`, {
        type: S.activeType, mmX: +mmX.toFixed(2), mmY: +mmY.toFixed(2), note: '',
      });
      S.current.marks.push(m);
      S.selectedMarkId = m.id;
      afterMarksChanged();
      const loc = DC().locate(mmX, mmY, params(), S.current.snapshot);
      toast(`已标记${DC().TYPE_NAMES[m.type]}：${loc.inCloth ? `经 ${loc.end + 1} × 纬 ${loc.pick + 1}` : '（位置在设计幅外）'}`);
    } catch (e) { toast('标记失败：' + e.message, 3000); }
  }

  async function moveMark(id, mmX, mmY) {
    const m = S.current.marks.find(x => x.id === id);
    if (!m) return;
    try {
      const updated = await req('PUT', `/api/batches/${S.current.id}/marks/${id}`, {
        mmX: +mmX.toFixed(2), mmY: +mmY.toFixed(2),
      });
      Object.assign(m, updated);
      afterMarksChanged();
    } catch (e) { toast('移动失败：' + e.message, 3000); await openBatch(S.current.id); }
  }

  async function patchMark(id, patch) {
    const m = S.current.marks.find(x => x.id === id);
    if (!m) return;
    try {
      const updated = await req('PUT', `/api/batches/${S.current.id}/marks/${id}`, patch);
      Object.assign(m, updated);
      afterMarksChanged();
    } catch (e) { toast('保存失败：' + e.message, 3000); }
  }

  async function deleteMark(id) {
    if (!confirm('删除该缺陷标记？')) return;
    try {
      await req('DELETE', `/api/batches/${S.current.id}/marks/${id}`);
      S.current.marks = S.current.marks.filter(m => m.id !== id);
      if (S.selectedMarkId === id) S.selectedMarkId = null;
      afterMarksChanged();
      toast('标记已删除');
    } catch (e) { toast('删除失败：' + e.message, 3000); }
  }

  /** 标记数据变化后：重绘 / 列表 / 反复分析失效 / 并排图 / 批次计数 */
  function afterMarksChanged() {
    S.recurrence = null;
    S.fullCache.set(S.current.id, S.current);
    redraw();
    renderMarkList();
    renderSideViews();
    refreshList();
    $('#dfMarkCount').textContent = S.current.marks.length;
  }

  function selectMark(id, center) {
    S.selectedMarkId = id;
    redraw(); renderMarkList();
    if (center) centerOnMark(id);
    const m = S.current.marks.find(x => x.id === id);
    if (m) {
      const loc = DC().locate(m.mmX, m.mmY, params(), S.current.snapshot);
      updateCoordReadout({ x: m.mmX, y: m.mmY });
    }
  }

  function centerOnMark(id) {
    const m = S.current.marks.find(x => x.id === id);
    if (!m) return;
    const vp = $('#dfViewport');
    vp.scrollTo({
      left: sx(m.mmX) * 1 - vp.clientWidth / 2,
      top: sy(m.mmY) * 1 - vp.clientHeight / 2,
      behavior: 'smooth',
    });
  }

  /* ============================== 标记列表 ============================ */
  function analysisOf(snapshot) {
    return Engine().analyze(snapshot);
  }

  function renderMarkList() {
    const box = $('#dfMarkList');
    const b = S.current;
    if (!b) { box.innerHTML = '<p class="hint">先建立或打开一个试织批次。</p>'; return; }
    if (!b.marks.length) {
      box.innerHTML = `<p class="hint">${archived() ? '该批次没有标记。' :
        '在布面上点击实物位置即可打点；右键空白可隐藏某类标记。拖动针点可修正位置。'}</p>`;
      return;
    }
    const A = analysisOf(b.snapshot);
    box.innerHTML = '';
    const order = { miss: 0, mistread: 1, broken: 2, float: 3 };
    b.marks.slice().sort((a, b2) => a.id - b2.id).forEach(m => {
      const loc = DC().locate(m.mmX, m.mmY, params(), b.snapshot);
      const rel = DC().relate(m, b.snapshot, A.derived);
      const g = (S.recurrence && S.recurrence.markGroup.get(`${b.id}:${m.id}`)) || null;
      const cp = DC().cyclePosition(m, b.repeatWarp, b.repeatWeft);
      const item = document.createElement('div');
      item.className = 'df-mark' + (m.id === S.selectedMarkId ? ' sel' : '');
      const tieTxt = rel.tiePoints.length ? '联结 ' + rel.tiePoints.map(s => s + 1).join('、') : '';
      const shTxt = rel.shuttle ? `梭${rel.shuttle.s + 1}` : '';
      const badges = [];
      if (g && g.crossCycle) badges.push('<span class="df-tag df-tag-cycle">跨循环</span>');
      if (g && g.crossBatch) badges.push('<span class="df-tag df-tag-batch">跨批次</span>');
      if (!loc.inCloth) badges.push('<span class="df-tag df-tag-out">幅外</span>');
      item.innerHTML = `
        <div class="df-mark-head">
          <span class="df-type-badge" style="background:${DC().TYPE_COLORS[m.type]}">${DC().TYPE_NAMES[m.type]}</span>
          <span class="df-mark-no">#${m.id}</span>
          <span class="df-mark-pos">(${fmt1(m.mmX)}, ${fmt1(m.mmY)}) mm</span>
          ${badges.join(' ')}
          <button class="btn tiny df-del" title="删除标记">✕</button>
        </div>
        <div class="df-mark-loc">
          经 <b>${loc.end >= 0 ? loc.end + 1 : '—'}</b> × 纬 <b>${loc.pick >= 0 ? loc.pick + 1 : '—'}</b>
          ｜循环位 (${cp.cx + 1}, ${cp.cy + 1})，砖 (${cp.tileX}, ${cp.tileY})
          ${rel.shaft != null ? `｜综框 <b>${rel.shaft + 1}</b>` : ''}
          ${rel.treadle != null ? `｜踏板 <b>${rel.treadle + 1}</b>` : ''}
          ${tieTxt ? '｜' + tieTxt : ''}
          ${shTxt ? `｜${shTxt}` : ''}
        </div>
        <div class="df-locate-row"></div>
        <textarea class="df-note" rows="2" maxlength="500"
          placeholder="备注：现场观察、纱线批次、修织方式…">${escapeHtml(m.note || '')}</textarea>`;
      item.querySelector('.df-mark-head').addEventListener('click', (e) => {
        if (e.target.closest('.df-del')) return;
        selectMark(m.id, true);
      });

      // 定位按钮
      const locRow = item.querySelector('.df-locate-row');
      const addLocate = (txt, grid, r, c, enabled) => {
        const btn = document.createElement('button');
        btn.className = 'btn tiny'; btn.textContent = txt; btn.disabled = !enabled;
        btn.addEventListener('click', () => {
          closeModal();
          window.locateCell({ grid, r, c });
        });
        locRow.appendChild(btn);
      };
      addLocate('→穿综', 'threading', rel.shaft ?? 0, m.end, rel.shaft != null && m.end >= 0);
      addLocate('→联结', 'tieup', rel.shaft ?? 0, rel.treadle ?? 0, rel.shaft != null && rel.treadle != null);
      addLocate('→踩踏', 'treadling', m.pick, rel.treadle ?? 0, rel.treadle != null && m.pick >= 0);
      addLocate('→组织格', 'drawdown', m.pick, m.end, loc.inCloth);
      // 梭次：在主图板整纬高亮（梭道在组织图左侧）
      if (rel.shuttle && m.pick >= 0) {
        const shuttleBtn = document.createElement('button');
        shuttleBtn.className = 'btn tiny';
        shuttleBtn.textContent = `→梭${rel.shuttle.s + 1}`;
        shuttleBtn.title = '定位到该纬的梭次';
        shuttleBtn.addEventListener('click', () => {
          closeModal();
          window.locateCell({ grid: 'treadling', r: m.pick, c: -1 });
        });
        locRow.appendChild(shuttleBtn);
      }
      // 修订快捷
      ['threading', 'tieup', 'treadling'].forEach(kind => {
        const btn = document.createElement('button');
        btn.className = 'btn tiny df-rev-quick';
        btn.textContent = { threading: '修订穿综', tieup: '修订联结', treadling: '修订踩踏' }[kind];
        btn.disabled = archived() ||
          (kind === 'threading' && rel.shaft == null) ||
          (kind === 'treadling' && rel.treadle == null) ||
          (kind === 'tieup' && (rel.shaft == null || rel.treadle == null));
        btn.addEventListener('click', () => { startReviseFromMark(kind, m, rel); });
        locRow.appendChild(btn);
      });

      const note = item.querySelector('.df-note');
      note.disabled = archived();
      note.addEventListener('input', () => {
        clearTimeout(note._t);
        note._t = setTimeout(() => patchMark(m.id, { note: note.value }), 500);
      });
      item.querySelector('.df-del').addEventListener('click', () => deleteMark(m.id));
      if (item.querySelector('.df-del')) item.querySelector('.df-del').disabled = archived();
      box.appendChild(item);
    });
  }

  /* ============================== 反复出现分析 ======================== */
  async function ensureRecurrence() {
    if (S.recurrence) return S.recurrence;
    // 拉取全部批次快照（缓存），跨批次判定需要同源设计
    await Promise.all(S.list.map(async (meta) => {
      if (!S.fullCache.has(meta.id)) {
        try {
          const full = await req('GET', `/api/batches/${meta.id}`);
          full.snapshot = window.__loom.normalizeDraft(full.snapshot);
          const rep = DC().snapshotRepeats(Engine(), full.snapshot);
          full.repeatWarp = rep.warp; full.repeatWeft = rep.weft;
          S.fullCache.set(meta.id, full);
        } catch (e) { /* 忽略无法读取的批次 */ }
      }
    }));
    S.recurrence = DC().analyzeRecurrence([...S.fullCache.values()]);
    return S.recurrence;
  }

  async function renderRepeat() {
    const box = $('#dfRepeatList');
    box.innerHTML = '<p class="hint">分析中…</p>';
    const R = await ensureRecurrence();
    const groups = R.groups.filter(g => g.count > 1 || g.crossCycle || g.crossBatch);
    $('#dfRepeatCount').textContent = groups.length;
    if (!groups.length) {
      box.innerHTML = '<p class="hint">✓ 所有标记均为单次出现，暂无跨循环 / 跨批次反复问题。</p>';
      return;
    }
    box.innerHTML = '';
    groups.forEach((g, gi) => {
      const card = document.createElement('div');
      card.className = 'df-rep' + (g.crossBatch ? ' crossbatch' : g.crossCycle ? ' crosscycle' : '');
      const members = g.members.map(mm => {
        const b = S.fullCache.get(mm.batchId);
        const mk = b && b.marks.find(x => x.id === mm.markId);
        return `<span class="df-rep-mem">${escapeHtml(b ? b.name : '#' + mm.batchId)} #${mm.markId}
          （${mk ? fmt1(mk.mmX) : '?'}，${mk ? fmt1(mk.mmY) : '?'} mm）</span>`;
      }).join(' ');
      card.innerHTML = `
        <div class="df-rep-head">
          <span class="df-type-badge" style="background:${DC().TYPE_COLORS[g.type]}">${DC().TYPE_NAMES[g.type]}</span>
          ${g.crossBatch ? '<span class="df-tag df-tag-batch">跨批次反复</span>' : ''}
          ${g.crossCycle ? '<span class="df-tag df-tag-cycle">跨循环反复</span>' : ''}
          <span class="df-rep-count">${g.count} 处</span>
        </div>
        <div class="df-rep-body">
          最小循环位置：<b>(${g.cx + 1}, ${g.cy + 1})</b><br>
          需核查综框：<b>${g.shafts.length ? g.shafts.map(s => s + 1).join('、') : '—'}</b>
          ｜踏板：<b>${g.treadles.length ? g.treadles.map(t => t + 1).join('、') : '—'}</b><br>
          联结点：<b>${g.tiePoints.length ? g.tiePoints.join('、') : '—'}</b>
          <div class="df-rep-members">${members}</div>
          <div class="df-rep-actions"></div>
        </div>`;
      const acts = card.querySelector('.df-rep-actions');
      ['threading', 'tieup', 'treadling'].forEach(kind => {
        const btn = document.createElement('button');
        btn.className = 'btn tiny btn-primary';
        btn.textContent = { threading: '逐项修订穿综', tieup: '逐项修订联结', treadling: '逐项修订踩踏' }[kind];
        btn.disabled = archived();
        btn.addEventListener('click', () => { startReviseFromGroup(kind, g); switchTab('revs'); });
        acts.appendChild(btn);
      });
      // 点击成员：若在当前批次则选中，否则打开其批次
      card.querySelectorAll('.df-rep-mem').forEach((el, i) => {
        el.style.cursor = 'pointer';
        el.title = '点击定位到该标记';
        el.addEventListener('click', async () => {
          const mm = g.members[i];
          if (S.current && S.current.id === mm.batchId) { selectMark(mm.markId, true); switchTab('marks'); }
          else { await openBatch(mm.batchId); selectMark(mm.markId, true); switchTab('marks'); }
        });
      });
      box.appendChild(card);
    });
  }

  /* ============================== 修订构建器 ========================== */
  function startReviseFromMark(kind, m, rel) {
    const b = S.current;
    // 穿综默认改挂到相邻的另一个综框（取当前所穿综框会零差异）
    const altShaft = rel.shaft == null ? 0
      : (rel.shaft + 1 < b.snapshot.shafts ? rel.shaft + 1 : rel.shaft - 1);
    // 踩踏默认改踩相邻踏板
    const altTreadle = rel.treadle == null ? 0
      : (rel.treadle + 1 < b.snapshot.treadles ? rel.treadle + 1 : rel.treadle - 1);
    S.rev = {
      kind, sourceMarkId: m.id, group: null,
      threading: { end: m.end, shaft: altShaft, applyCycle: false, rw: b.repeatWarp },
      tieup: { shaft: rel.shaft ?? 0, treadle: rel.treadle ?? 0,
               value: !(rel.treadle != null && rel.shaft != null && b.snapshot.tieup[rel.shaft][rel.treadle]) },
      treadling: { pick: m.pick, treadle: altTreadle, applyCycle: false, rh: b.repeatWeft },
      diff: null, after: null, meta: null,
    };
    switchTab('revs');
    renderReviseBox();
  }

  function startReviseFromGroup(kind, g) {
    const b = S.current;
    const mm = g.members.find(x => x.batchId === b.id) || g.members[0];
    // 默认改挂目标：第一个不在“需核查综框”清单中的综框（取当前所穿综框会零差异）
    let altShaft = 0;
    while (g.shafts.includes(altShaft) && altShaft < b.snapshot.shafts - 1) altShaft++;
    let altTreadle = 0;
    while (g.treadles.includes(altTreadle) && altTreadle < b.snapshot.treadles - 1) altTreadle++;
    S.rev = {
      kind, sourceMarkId: mm.markId, group: g,
      threading: { end: g.cx, shaft: altShaft, applyCycle: true, rw: b.repeatWarp },
      tieup: {
        shaft: g.shafts[0] ?? 0, treadle: g.treadles[0] ?? 0,
        // 默认翻转当前联结状态
        value: !(g.shafts.length && g.treadles.length && b.snapshot.tieup[g.shafts[0]][g.treadles[0]]),
      },
      treadling: { pick: g.cy, treadle: altTreadle, applyCycle: true, rh: b.repeatWeft },
      diff: null, after: null, meta: null,
    };
    renderReviseBox();
  }

  function currentAction() {
    const r = S.rev; if (!r) return null;
    if (r.kind === 'threading')
      return { action: 'threading', end: +r.threading.end, shaft: +r.threading.shaft,
               applyCycle: r.threading.applyCycle, rw: r.threading.rw };
    if (r.kind === 'tieup')
      return { action: 'tieup', shaft: +r.tieup.shaft, treadle: +r.tieup.treadle, value: r.tieup.value };
    return { action: 'treadling', pick: +r.treadling.pick, treadle: +r.treadling.treadle,
             applyCycle: r.treadling.applyCycle, rh: r.treadling.rh };
  }

  function renderReviseBox() {
    const box = $('#dfReviseBox');
    const r = S.rev, b = S.current;
    if (!r || !b) {
      box.innerHTML = '<p class="hint">在“标记 / 反复”中点选问题后，可选择修订穿综、联结或踩踏。</p>';
      return;
    }
    const d = b.snapshot;
    const sel = (values, chosen) => values.map(([v, label]) =>
      `<option value="${v}"${v === chosen ? ' selected' : ''}>${label}</option>`).join('');
    const shaftOpts = Array.from({ length: d.shafts }, (_, i) => [i, '综框 ' + (i + 1)]);
    const treadleOpts = Array.from({ length: d.treadles }, (_, i) => [i, '踏板 ' + (i + 1)]);

    let form = '';
    if (r.kind === 'threading') {
      form = `
        <label class="field"><span>锚定经线（0 基序号，循环模式下取其循环位）</span>
          <input type="number" min="0" max="${d.ends - 1}" value="${r.threading.end}" id="rvEnd"></label>
        <label class="field"><span>改挂到综框</span>
          <select id="rvShaft">${sel(shaftOpts, r.threading.shaft)}</select></label>
        <label class="check"><input type="checkbox" id="rvCycleW" ${r.threading.applyCycle ? 'checked' : ''}>
          应用到同循环位的全部经线（${DC().sameCycleEnds(d.ends, +r.threading.end, b.repeatWarp).length} 根）</label>`;
    } else if (r.kind === 'tieup') {
      form = `
        <label class="field"><span>综框</span><select id="rvShaft">${sel(shaftOpts, r.tieup.shaft)}</select></label>
        <label class="field"><span>踏板</span><select id="rvTreadle">${sel(treadleOpts, r.tieup.treadle)}</select></label>
        <label class="check"><input type="checkbox" id="rvValue" ${r.tieup.value ? 'checked' : ''}>
          联结（不勾选为脱开）</label>`;
    } else {
      form = `
        <label class="field"><span>锚定纬次</span>
          <input type="number" min="0" max="${d.picks - 1}" value="${r.treadling.pick}" id="rvPick"></label>
        <label class="field"><span>改踩踏板</span>
          <select id="rvTreadle">${sel(treadleOpts, r.treadling.treadle)}</select></label>
        <label class="check"><input type="checkbox" id="rvCycleH" ${r.treadling.applyCycle ? 'checked' : ''}>
          应用到同循环位的全部纬次（${DC().sameCyclePicks(d.picks, +r.treadling.pick, b.repeatWeft).length} 纬）</label>`;
    }
    box.innerHTML = `
      <div class="df-rev-title">修订：${{ threading: '穿综', tieup: '联结', treadling: '踩踏' }[r.kind]}
        ${r.group ? (r.group.crossBatch ? '<span class="df-tag df-tag-batch">跨批次组</span>' : '<span class="df-tag df-tag-cycle">跨循环组</span>') : '<span class="df-tag">单点</span>'}</div>
      ${form}
      <div class="grid-2">
        <button id="rvPreview" class="btn tiny">预览组织差异</button>
        <button id="rvApply" class="btn tiny btn-primary" disabled>应用并另存为新草稿</button>
      </div>
      <div id="rvDiff" class="df-diff"></div>
      <canvas id="rvDiffCanvas" width="300" height="180"></canvas>`;

    const readForm = () => {
      if (r.kind === 'threading') {
        r.threading.end = clamp(parseInt($('#rvEnd').value, 10) || 0, 0, d.ends - 1);
        r.threading.shaft = parseInt($('#rvShaft').value, 10);
        r.threading.applyCycle = $('#rvCycleW').checked;
      } else if (r.kind === 'tieup') {
        r.tieup.shaft = parseInt($('#rvShaft').value, 10);
        r.tieup.treadle = parseInt($('#rvTreadle').value, 10);
        r.tieup.value = $('#rvValue').checked;
      } else {
        r.treadling.pick = clamp(parseInt($('#rvPick').value, 10) || 0, 0, d.picks - 1);
        r.treadling.treadle = parseInt($('#rvTreadle').value, 10);
        r.treadling.applyCycle = $('#rvCycleH').checked;
      }
      r.diff = null; $('#rvApply').disabled = true; $('#rvDiff').innerHTML = '';
    };
    box.querySelectorAll('input,select').forEach(el => el.addEventListener('change', readForm));
    $('#rvPreview').addEventListener('click', () => { readForm(); previewRev(); });
    $('#rvApply').addEventListener('click', applyRev);
    if (r.diff) drawRevDiff();
  }

  function previewRev() {
    const b = S.current, action = currentAction();
    const { draft: after, meta } = DC().applyRevision(b.snapshot, action);
    const diff = DC().diffDraft(Engine(), b.snapshot, after, meta);
    S.rev.after = after; S.rev.meta = meta; S.rev.diff = diff;
    $('#rvApply').disabled = false;
    drawRevDiff();
  }

  function drawRevDiff() {
    const r = S.rev, diff = r.diff, box = $('#rvDiff');
    const better = (a, b2) => b2 < a ? `<b style="color:var(--ok)">${b2}</b>` : (b2 > a ? `<b style="color:var(--bad)">${b2}</b>` : b2);
    box.innerHTML =
      `组织差异：<b>${diff.changed}</b> / ${diff.total} 格（${(diff.changeRate * 100).toFixed(1)}%）<br>` +
      `最长经浮 ${diff.maxWarpBefore} → ${better(diff.maxWarpBefore, diff.maxWarpAfter)}　` +
      `最长纬浮 ${diff.maxWeftBefore} → ${better(diff.maxWeftBefore, diff.maxWeftAfter)}<br>` +
      `缺失格 ${diff.nullsBefore} → ${diff.nullsAfter}　` +
      (diff.changed === 0 ? '<span style="color:var(--warn)">该修订不改变组织（可能已是目标状态）。</span>' : '');

    // 差异小图：修订后组织，差异格标红，修订列/纬描蓝边
    const d = S.current.snapshot;
    const cvs = $('#rvDiffCanvas');
    const ctx = cvs.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    const sc = Math.max(1, Math.floor(Math.min(cvs.width / d.ends, cvs.height / d.picks)));
    const cg = Engine().colorGrid(r.after, Engine().derive(r.after), 'front');
    const changeSet = new Set(diff.changes.map(c => c.end + ':' + c.pick));
    for (let p = 0; p < d.picks; p++)
      for (let e = 0; e < d.ends; e++) {
        ctx.fillStyle = changeSet.has(e + ':' + p) ? '#e0352a' : (cg[p][e] || '#e9e2d2');
        ctx.fillRect(e * sc, p * sc, sc, sc);
      }
    ctx.strokeStyle = '#29528c';
    ctx.lineWidth = 1;
    (diff.revEnds || []).forEach(e => ctx.strokeRect(e * sc + .5, .5, sc - 1, d.picks * sc - 1));
    (diff.revPicks || []).forEach(p => ctx.strokeRect(.5, p * sc + .5, d.ends * sc - 1, sc - 1));
    (diff.revCells || []).forEach(() => {});
  }

  async function applyRev() {
    const b = S.current, r = S.rev;
    if (!r.diff) { toast('请先预览组织差异'); return; }
    const kindName = { threading: '穿综', tieup: '联结', treadling: '踩踏' }[r.kind];
    const name = `${b.name} - 修订${kindName} ${new Date().toISOString().slice(5, 10)}`;
    let saved;
    try {
      saved = await req('POST', '/api/drafts', { name, data: r.after });
    } catch (e) { toast('新草稿保存失败：' + e.message, 3000); return; }
    const action = currentAction();
    const summary = DC().revisionSummary(r.kind, action, r.diff);
    try {
      await req('POST', `/api/batches/${b.id}/revisions`, {
        action: r.kind, summary, newDraftId: saved.id,
        detail: { action, changed: r.diff.changed, total: r.diff.total,
                  maxWarpAfter: r.diff.maxWarpAfter, maxWeftAfter: r.diff.maxWeftAfter,
                  groupMembers: r.group ? r.group.count : 1 },
      });
    } catch (e) { toast('修订记录写入失败（草稿已保存）：' + e.message, 4000); }
    toast(`已另存为新草稿「${name}」并记录修订`);
    // 载入主应用（不覆盖原稿）
    window.loadDraft(r.after, name, saved.id);
    closeModal();
    await openBatch(b.id);
    renderRevList();
  }

  function renderRevList() {
    const box = $('#dfRevList');
    const b = S.current;
    if (!b) { box.innerHTML = ''; return; }
    if (!b.revisions.length) { box.innerHTML = '<p class="hint">本批次尚无修订记录。</p>'; return; }
    box.innerHTML = '';
    b.revisions.forEach(rv => {
      const div = document.createElement('div');
      div.className = 'df-rev-item';
      div.innerHTML =
        `<div><b>${{ threading: '修订穿综', tieup: '修订联结', treadling: '修订踩踏' }[rv.action]}</b>
           ${rv.newDraftId != null ? `→ 新草稿 #${rv.newDraftId}` : ''}</div>
         <div class="hint">${escapeHtml(rv.summary)}</div>
         <div class="hint">${String(rv.createdAt || '').replace('T', ' ').slice(0, 16)}</div>`;
      box.appendChild(div);
    });
  }

  /* ============================== 并排视图 ============================ */
  function fillColorCanvas(cvs, snapshot, side, repeat) {
    const ctx = cvs.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    const A = Engine().analyze(snapshot);
    const W = repeat ? A.rep.warp : snapshot.ends;
    const H = repeat ? A.rep.weft : snapshot.picks;
    const cg = Engine().colorGrid(snapshot, A.derived, side);
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const o = off.getContext('2d');
    for (let p = 0; p < H; p++)
      for (let e = 0; e < W; e++) {
        o.fillStyle = cg[p % snapshot.picks][e % snapshot.ends] || '#e9e2d2';
        o.fillRect(e, p, 1, 1);
      }
    const sc = Math.max(1, Math.floor(Math.min(cvs.width / W, cvs.height / H)));
    ctx.drawImage(off, 0, 0, W * sc, H * sc);
    return { sc, W, H };
  }

  function renderSideViews() {
    const b = S.current;
    if (!b) return;
    // 设计组织（正面）+ 标记定位
    const cvs = $('#dfViewDesign');
    const info = fillColorCanvas(cvs, b.snapshot, 'front', false);
    const ctx = cvs.getContext('2d');
    const miniHit = [];
    b.marks.forEach(m => {
      const loc = DC().locate(m.mmX, m.mmY, params(), b.snapshot);
      if (!loc.inCloth) return;
      const x = (loc.end + .5) * info.sc, y = (loc.pick + .5) * info.sc;
      ctx.fillStyle = DC().TYPE_COLORS[m.type];
      ctx.beginPath(); ctx.arc(x, y, Math.max(3, info.sc * .7), 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.stroke();
      miniHit.push({ id: m.id, x, y, r: 6 });
    });
    cvs.onclick = (ev) => {
      const rect = cvs.getBoundingClientRect();
      const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
      const h = miniHit.find(m => Math.hypot(m.x - x, m.y - y) <= m.r + 2);
      if (h) { selectMark(h.id, true); switchTab('marks'); }
    };
    fillColorCanvas($('#dfViewFront'), b.snapshot, 'front', true);
    fillColorCanvas($('#dfViewBack'), b.snapshot, 'back', true);
    drawMiniCloth($('#dfViewMarks'));
  }

  /** 回标结果小图：布面 + 针点 */
  function drawMiniCloth(cvs) {
    const b = S.current, w = world();
    const ctx = cvs.getContext('2d');
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    const xMin = w.xMin, xRange = w.xMax - w.xMin, yRange = w.yMax - w.yMin;
    const s = Math.min(cvs.width / xRange, cvs.height / yRange);
    const X = (mm) => (mm - xMin) * s;
    const Y = (mm) => (mm - w.yMin) * s;
    ctx.fillStyle = '#fffdf7';
    ctx.strokeStyle = '#8d8572';
    ctx.fillRect(X(w.q.originX), Y(w.q.originY), w.clothW * s, w.clothH * s);
    ctx.strokeRect(X(w.q.originX) + .5, Y(w.q.originY) + .5, w.clothW * s - 1, w.clothH * s - 1);
    const hits = [];
    b.marks.forEach(m => {
      const x = X(m.mmX), y = Y(m.mmY);
      ctx.fillStyle = DC().TYPE_COLORS[m.type];
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
      hits.push({ id: m.id, x, y, r: 5 });
    });
    cvs.onclick = (ev) => {
      const rect = cvs.getBoundingClientRect();
      const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
      const h = hits.find(m => Math.hypot(m.x - x, m.y - y) <= m.r + 2);
      if (h) { selectMark(h.id, true); switchTab('marks'); }
    };
  }

  /* ============================== 打印 ================================ */
  function doPrint() {
    const b = S.current;
    if (!b) { toast('请先打开批次'); return; }
    const w = world(), A = analysisOf(b.snapshot);
    const PRINT_W = 1000;
    const s = Math.min((PRINT_W - 80) / (w.xMax - w.xMin), 30);
    const PW = PRINT_W, PH = RULER_T + 30 + (w.yMax - w.yMin) * s;
    const cvs = $('#dfPrintCanvas');
    cvs.width = PW; cvs.height = PH;
    const ctx = cvs.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, PW, PH);
    const X = (mm) => RULER_L + (mm - w.xMin) * s;
    const Y = (mm) => RULER_T + (mm - w.yMin) * s;

    // 尺带
    ctx.fillStyle = '#f6f1e7';
    ctx.fillRect(RULER_L, RULER_T, PW - RULER_L, PH - RULER_T);
    ctx.strokeStyle = '#555'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, RULER_T + .5); ctx.lineTo(PW, RULER_T + .5);
    ctx.moveTo(RULER_L + .5, 0); ctx.lineTo(RULER_L + .5, PH); ctx.stroke();
    ctx.fillStyle = '#333'; ctx.font = '9px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let mm = Math.ceil(w.xMin / 10) * 10; mm <= w.xMax; mm += 10) {
      ctx.beginPath(); ctx.moveTo(X(mm), RULER_T); ctx.lineTo(X(mm), RULER_T - 6); ctx.stroke();
      ctx.fillText(String(mm), X(mm), 3);
      ctx.strokeStyle = 'rgba(120,110,90,.4)';
      ctx.beginPath(); ctx.moveTo(X(mm), RULER_T); ctx.lineTo(X(mm), PH); ctx.stroke();
      ctx.strokeStyle = '#555';
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let mm = Math.ceil(w.yMin / 10) * 10; mm <= w.yMax; mm += 10) {
      ctx.beginPath(); ctx.moveTo(RULER_L, Y(mm)); ctx.lineTo(RULER_L - 6, Y(mm)); ctx.stroke();
      ctx.fillText(String(mm), RULER_L - 8, Y(mm));
      ctx.strokeStyle = 'rgba(120,110,90,.4)';
      ctx.beginPath(); ctx.moveTo(RULER_L, Y(mm)); ctx.lineTo(PW, Y(mm)); ctx.stroke();
      ctx.strokeStyle = '#555';
    }
    // 布面
    const px0 = X(w.q.originX), py0 = Y(w.q.originY);
    ctx.fillStyle = '#fffdf7';
    ctx.fillRect(px0, py0, w.clothW * s, w.clothH * s);
    ctx.strokeStyle = '#2d2a24'; ctx.lineWidth = 1.4;
    ctx.strokeRect(px0 + .5, py0 + .5, w.clothW * s - 1, w.clothH * s - 1);
    // 循环砖
    ctx.strokeStyle = 'rgba(41,82,140,.6)';
    const tw = b.repeatWarp * w.pitch.x * s, th = b.repeatWeft * w.pitch.y * s;
    ctx.beginPath();
    for (let x = px0 + tw; x < px0 + w.clothW * s; x += tw) { ctx.moveTo(x, py0); ctx.lineTo(x, py0 + w.clothH * s); }
    for (let y = py0 + th; y < py0 + w.clothH * s; y += th) { ctx.moveTo(px0, y); ctx.lineTo(px0 + w.clothW * s, y); }
    ctx.stroke();
    // 针点 + 编号
    b.marks.forEach((m, i) => {
      const x = X(m.mmX), y = Y(m.mmY);
      ctx.fillStyle = DC().TYPE_COLORS[m.type];
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#222'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 8px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(DC().TYPE_GLYPHS[m.type], x, y + .5);
      ctx.fillStyle = '#222'; ctx.font = 'bold 8px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(String(i + 1), x + 8, y - 7);
    });

    $('#dfPrintTitle').textContent = `${b.name} — 试织缺陷回标图`;
    $('#dfPrintMeta').innerHTML =
      `打印时间：${new Date().toLocaleString()}　状态：${b.status === 'archived' ? '已归档' : '试织中'}<br>` +
      `来源草稿：${escapeHtml(b.draftName)}${b.draftId != null ? ` (#${b.draftId})` : ''}（快照已冻结）<br>` +
      `快照 ${b.snapshot.ends} 经 × ${b.snapshot.picks} 纬，${b.snapshot.shafts} 综框 / ${b.snapshot.treadles} 踏板；最小循环 经${b.repeatWarp} × 纬${b.repeatWeft}<br>` +
      `实测经密 ${b.warpDensity}/cm（间距 ${fmt1(10 / b.warpDensity)}mm）、纬密 ${b.weftDensity}/cm（间距 ${fmt1(10 / b.weftDensity)}mm）；` +
      `缩率 经${b.warpShrink}% / 纬${b.weftShrink}%；对齐原点 (${fmt1(b.originX)}, ${fmt1(b.originY)}) mm；标尺单位 mm`;

    // 明细表
    let html = '<table class="df-print-table"><thead><tr>' +
      '<th>#</th><th>类型</th><th>实物 X (mm)</th><th>实物 Y (mm)</th><th>上机 X</th><th>上机 Y</th>' +
      '<th>经线</th><th>纬次</th><th>循环位</th><th>综框</th><th>踏板</th><th>联结点</th><th>梭次</th><th>备注</th>' +
      '</tr></thead><tbody>';
    b.marks.forEach((m, i) => {
      const loc = DC().locate(m.mmX, m.mmY, params(), b.snapshot);
      const rel = DC().relate(m, b.snapshot, A.derived);
      const cp = DC().cyclePosition(m, b.repeatWarp, b.repeatWeft);
      const tie = rel.tiePoints.length ? rel.tiePoints.map(x => x + 1).join('、') : '—';
      html += `<tr>
        <td>${i + 1}</td>
        <td>${DC().TYPE_NAMES[m.type]}</td>
        <td>${fmt1(m.mmX)}</td><td>${fmt1(m.mmY)}</td>
        <td>${fmt1(loc.loomX)}</td><td>${fmt1(loc.loomY)}</td>
        <td>${loc.end >= 0 ? loc.end + 1 + (loc.inWarp ? '' : '(幅外)') : '—'}</td>
        <td>${loc.pick >= 0 ? loc.pick + 1 + (loc.inWeft ? '' : '(幅外)') : '—'}</td>
        <td>(${cp.cx + 1},${cp.cy + 1}) 砖(${cp.tileX},${cp.tileY})</td>
        <td>${rel.shaft != null ? rel.shaft + 1 : '—'}</td>
        <td>${rel.treadle != null ? rel.treadle + 1 : '—'}</td>
        <td>${tie}</td>
        <td>${rel.shuttle ? '梭' + (rel.shuttle.s + 1) : '—'}</td>
        <td>${escapeHtml(m.note || '')}</td>
      </tr>`;
    });
    html += '</tbody></table>';
    if (b.revisions.length) {
      html += '<br><b>修订记录：</b><br>';
      b.revisions.forEach(rv => {
        html += `· ${{ threading: '穿综', tieup: '联结', treadling: '踩踏' }[rv.action]}：${escapeHtml(rv.summary)}<br>`;
      });
    }
    $('#dfPrintLegend').innerHTML = html;

    document.body.classList.add('df-printing');
    setTimeout(() => {
      window.print();
      setTimeout(() => document.body.classList.remove('df-printing'), 600);
    }, 120);
  }

  /* ============================== Tab 切换 ============================ */
  function switchTab(tab) {
    S.tab = tab;
    document.querySelectorAll('.df-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.df-tabpane').forEach(p =>
      p.classList.toggle('hidden', p.dataset.pane !== tab));
    if (tab === 'repeat') renderRepeat();
    if (tab === 'view') renderSideViews();
    if (tab === 'revs') renderReviseBox();
  }

  /* ============================== 事件绑定 ============================ */
  function bind() {
    $('#btnDefect').addEventListener('click', openModal);
    document.querySelectorAll('[data-close-df]').forEach(b => b.addEventListener('click', closeModal));
    $('#defectModal').addEventListener('click', (e) => { if (e.target.id === 'defectModal') closeModal(); });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && S.open) closeModal();
    });

    $('#dfNewBatch').addEventListener('click', () => {
      $('#dfCreateForm').classList.contains('hidden') ? showCreateForm() : hideCreateForm();
    });
    $('#dfCreateCancel').addEventListener('click', hideCreateForm);
    $('#dfCreateSubmit').addEventListener('click', submitCreate);
    ['dfWarpDensity', 'dfWeftDensity', 'dfWarpShrink', 'dfWeftShrink', 'dfOriginX', 'dfOriginY']
      .forEach(id => $('#' + id).addEventListener('input', updateClothSizeHint));
    $('#dfStatusFilter').addEventListener('change', refreshList);
    $('#dfSourceFilter').addEventListener('change', refreshList);

    document.querySelectorAll('.df-type').forEach(btn => {
      btn.addEventListener('click', () => {
        S.activeType = btn.dataset.type;
        document.querySelectorAll('.df-type').forEach(b => b.classList.toggle('active', b === btn));
      });
    });
    $('#dfZoomIn').addEventListener('click', () => setZoom(1.25));
    $('#dfZoomOut').addEventListener('click', () => setZoom(1 / 1.25));
    $('#dfZoomFit').addEventListener('click', fitZoom);
    $('#dfHeat').addEventListener('change', e => { S.showHeat = e.target.checked; redraw(); });
    $('#dfGrid').addEventListener('change', e => { S.showGrid = e.target.checked; redraw(); });
    $('#dfViewport').addEventListener('wheel', (ev) => {
      if (ev.ctrlKey || ev.metaKey) { ev.preventDefault(); setZoom(ev.deltaY < 0 ? 1.12 : 1 / 1.12); }
    }, { passive: false });

    document.querySelectorAll('.df-tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $('#dfArchive').addEventListener('click', archiveCurrent);
    $('#dfPrint').addEventListener('click', doPrint);
    window.addEventListener('resize', () => { if (S.open) { resizeBoard(); redraw(); } });
  }

  /* ============================== 初始化 / 测试钩子 ==================== */
  function init() {
    if (!$('#btnDefect') || !$('#defectModal')) return false;
    bind();
    window.__defectAPI = {
      open: openModal, close: closeModal, isOpen: () => S.open,
      state: S,
      refreshList, openBatch, submitCreate, archiveCurrent,
      createMark, moveMark, patchMark, deleteMark, selectMark,
      ensureRecurrence, renderRepeat, startReviseFromMark, startReviseFromGroup,
      previewRev: () => previewRev(), applyRev,
      fitZoom, setZoom, redraw, world,
      doPrint,
    };
    return true;
  }

  if (!init() && typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => init());
  }
})();
