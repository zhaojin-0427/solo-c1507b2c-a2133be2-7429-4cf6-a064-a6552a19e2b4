/* =====================================================================
 * reed-ui.js — 分区变筘编辑器（原生 DOM + Canvas，无外部依赖）
 *
 * 在经线尺上拖出区段，为每段设置目标上机经密 / 每筘上限（0–4 根，0 = 空筘）
 * / 连续空筘上限 / 中心镜像，并可锁定布边或已确认区段；
 * 边界按 lcm(穿综周期, 色经周期) 校正；搜索整幅穿筘序列并定位
 * 漏穿 / 重穿 / 区段宽度偏差 / 空筘超限 / 镜像破坏；
 * 预览按实际筘位拉伸组织图（疏密与开缝），候选可叠加比较，
 * 采纳时经 loom-ui 另存为工艺单新版本。
 * ===================================================================== */
'use strict';

(function () {

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const RC = () => window.ReedCore;
  const Engine = () => window.__loom.Engine;
  const deepClone = (o) => JSON.parse(JSON.stringify(o));
  const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const fmt2 = (v) => String(Math.round(v * 100) / 100);

  const ZONE_COLORS = ['#29528c', '#b3352a', '#4a7c59', '#b8862f',
    '#5b3a5e', '#7a4d1f', '#2f6f6f', '#8c3a68'];
  const zoneColor = (i) => ZONE_COLORS[i % ZONE_COLORS.length];

  const S = {
    open: false,
    ctx: null,          // loomSheetAPI.reedContext()
    zones: [],
    dents: null,        // 当前预览的整幅筘序列（候选或基线）
    cands: [],
    sel: -1,            // 主选候选
    cmp: -1,            // 叠加比较候选
    issues: [],
    selZone: -1,        // 经线尺上选中的区段
    dentW: 6,           // 预览每筘像素宽（缩放 3–16）
    drag: null,         // {mode:'create'|'bound', ...}
    flash: null,        // {dent0, dent1, until}
    alignU: 1,
  };

  function toast(msg, ms) { if (window.toast) window.toast(msg, ms); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ============================== 打开 / 关闭 ========================== */
  function open() {
    const api = window.__loomSheetAPI;
    if (!api) { toast('请先打开上机工艺单'); return; }
    S.ctx = api.reedContext();
    const ctx = S.ctx;
    S.alignU = RC().alignUnit(ctx.plan.threadingP || 1, ctx.plan.warpColorP || 1);

    // 初始区段：已冻结分区单 → 其区段（已确认段锁定）；否则整幅一段
    if (ctx.baselinePlan && ctx.baselinePlan.mode === 'zoned' &&
        Array.isArray(ctx.baselinePlan.zones) && ctx.baselinePlan.zones.length) {
      S.zones = RC().normalizeZones(deepClone(ctx.baselinePlan.zones),
        ctx.plan.totalEnds, ctx.plan.loomDensity);
      (ctx.confirmed || []).forEach(zi => {
        if (S.zones[zi]) {
          S.zones[zi].locked = true;
          S.zones[zi].fixedSeq = RC().sliceZoneSeq(ctx.baselineDents, S.zones, zi);
        }
      });
      S.dents = (ctx.baselineDents || []).slice();
    } else {
      S.zones = [RC().defaultSpec(ctx.plan.loomDensity, 1, ctx.plan.totalEnds)];
      S.dents = ctx.baselineDents ? ctx.baselineDents.slice() : null;
    }
    S.cands = []; S.sel = -1; S.cmp = -1; S.selZone = -1;
    S.open = true;
    $('#reedModal').classList.remove('hidden');
    $('#rdCtxInfo').textContent =
      `整经 ${ctx.plan.totalEnds} 根 · 筘 ${ctx.params.reedDents} 筘/cm` +
      (ctx.sheetName ? ` · 基线「${ctx.sheetName}」` : ' · 未冻结');
    $('#rdAlignHint').textContent = `边界校正单位 ${S.alignU} 根（穿综 × 色经循环）`;
    recheck();
    renderZones();
    renderCands();
    layoutCanvases();
  }

  function close() {
    S.open = false;
    $('#reedModal').classList.add('hidden');
  }

  /* ============================== 问题复核 ============================ */
  function recheck() {
    if (!S.ctx) return;
    S.issues = S.dents && S.dents.length
      ? RC().checkPlan(S.zones, S.dents, S.ctx.plan.totalEnds, S.ctx.params.reedDents)
      : [];
    renderIssues();
    updateAdoptBtn();
  }

  function updateAdoptBtn() {
    const errs = S.issues.filter(i => i.level === 'error').length;
    const btn = $('#rdAdopt');
    btn.disabled = !(S.sel >= 0 && S.dents && S.dents.length && errs === 0);
    btn.textContent = S.sel >= 0
      ? (errs ? `采纳并另存工艺单版本（${errs} 个错误待解决）` : '采纳并另存工艺单版本')
      : '采纳并另存工艺单版本';
  }

  /* ============================== 区段列表 ============================ */
  function renderZones() {
    const box = $('#rdZoneList');
    box.innerHTML = '';
    S.zones.forEach((z, zi) => {
      const card = document.createElement('div');
      card.className = 'rd-zone' + (zi === S.selZone ? ' sel' : '') + (z.locked ? ' locked' : '');
      card.innerHTML =
        `<div class="rd-zone-head">
           <i class="rd-zone-chip" style="background:${zoneColor(zi)}"></i>
           <b>区段${zi + 1}</b>
           <span class="rd-zone-range">第 ${z.from}–${z.to} 根（${z.to - z.from + 1} 根）</span>
           <button class="btn tiny rd-z-lock" title="${z.locked ? '解锁（允许搜索改动本段）' : '锁定（布边 / 已确认段，搜索不改动）'}">${z.locked ? '🔒' : '🔓'}</button>
           <button class="btn tiny rd-z-del" title="删除本段（缺口以默认段补齐）" ${S.zones.length <= 1 ? 'disabled' : ''}>✕</button>
         </div>
         <div class="rd-zone-form">
           <label>目标经密<input type="number" class="rd-z-td" min="0.1" max="200" step="0.1" value="${z.targetDensity}"> 根/cm</label>
           <label>每筘上限<input type="number" class="rd-z-mpd" min="1" max="4" step="1" value="${z.maxPerDent}"> 根</label>
           <label>连续空筘≤<input type="number" class="rd-z-mer" min="0" max="64" step="1" value="${z.maxEmptyRun}"></label>
           <label class="check"><input type="checkbox" class="rd-z-mir" ${z.mirror ? 'checked' : ''}> 中心镜像</label>
         </div>`;
      card.querySelector('.rd-z-lock').addEventListener('click', () => toggleLock(zi));
      card.querySelector('.rd-z-del').addEventListener('click', () => removeZone(zi));
      card.querySelector('.rd-z-td').addEventListener('change', (e) => {
        z.targetDensity = Math.max(0.1, Math.min(200, parseFloat(e.target.value) || z.targetDensity));
        e.target.value = z.targetDensity;
        zonesChanged();
      });
      card.querySelector('.rd-z-mpd').addEventListener('change', (e) => {
        z.maxPerDent = Math.max(1, Math.min(4, Math.round(parseFloat(e.target.value) || z.maxPerDent)));
        e.target.value = z.maxPerDent;
        zonesChanged();
      });
      card.querySelector('.rd-z-mer').addEventListener('change', (e) => {
        z.maxEmptyRun = Math.max(0, Math.min(64, Math.round(parseFloat(e.target.value) || 0)));
        e.target.value = z.maxEmptyRun;
        zonesChanged();
      });
      card.querySelector('.rd-z-mir').addEventListener('change', (e) => {
        z.mirror = !!e.target.checked;
        zonesChanged();
      });
      card.addEventListener('click', (ev) => {
        if (ev.target.closest('button') || ev.target.closest('input')) return;
        S.selZone = zi;
        renderZones();
        drawRuler();
      });
      box.appendChild(card);
    });
  }

  /** 区段参数或结构变化：候选作废，复核当前序列 */
  function zonesChanged() {
    S.cands = []; S.sel = -1; S.cmp = -1;
    renderCands();
    recheck();
    drawRuler();
    drawPreview();
    $('#rdSearchHint').textContent = '区段已修改，请重新搜索。';
  }

  /** 锁定 / 解锁：锁定时捕获固定筘序列（当前显示序列或现场最佳） */
  function toggleLock(zi) {
    const z = S.zones[zi];
    if (!z.locked) {
      const len = z.to - z.from + 1;
      let seq = null;
      if (S.dents && S.dents.length) {
        const sub = RC().sliceZoneSeq(S.dents, S.zones, zi);
        if (sub.length && sub.reduce((s, v) => s + v, 0) === len) seq = sub;
      }
      if (!seq) {
        const { cands } = RC().zoneCandidates(len, z, S.ctx.params.reedDents, 1);
        seq = cands.length ? cands[0].seq : null;
      }
      if (!seq) { toast(`区段 ${zi + 1} 无可行筘序列，无法锁定`); return; }
      z.locked = true;
      z.fixedSeq = seq;
      toast(`区段 ${zi + 1} 已锁定（固定 [${seq.length > 8 ? seq.slice(0, 8).join(' ') + ' …' : seq.join(' ')}]）`);
    } else {
      z.locked = false;
      delete z.fixedSeq;
    }
    zonesChanged();
    renderZones();
  }

  function removeZone(zi) {
    if (S.zones.length <= 1) return;
    const z = S.zones[zi];
    if (z.locked) { toast('锁定区段不能删除，请先解锁'); return; }
    S.zones.splice(zi, 1);
    S.zones = RC().normalizeZones(S.zones, S.ctx.plan.totalEnds, S.ctx.plan.loomDensity);
    RC().correctBoundaries(S.zones, S.alignU, S.ctx.plan.totalEnds);
    if (S.selZone >= S.zones.length) S.selZone = -1;
    zonesChanged();
    renderZones();
  }

  /** 锁定布边：第一段与最后一段 */
  function lockEdges() {
    if (!S.zones.length) return;
    [0, S.zones.length - 1].forEach(zi => {
      if (!S.zones[zi].locked) {
        const len = S.zones[zi].to - S.zones[zi].from + 1;
        let seq = null;
        if (S.dents && S.dents.length) {
          const sub = RC().sliceZoneSeq(S.dents, S.zones, zi);
          if (sub.length && sub.reduce((s, v) => s + v, 0) === len) seq = sub;
        }
        if (!seq) {
          const { cands } = RC().zoneCandidates(len, S.zones[zi], S.ctx.params.reedDents, 1);
          seq = cands.length ? cands[0].seq : null;
        }
        if (seq) { S.zones[zi].locked = true; S.zones[zi].fixedSeq = seq; }
      }
    });
    toast('布边区段已锁定');
    zonesChanged();
    renderZones();
  }

  function resetZones() {
    S.zones = [RC().defaultSpec(S.ctx.plan.loomDensity, 1, S.ctx.plan.totalEnds)];
    S.selZone = -1;
    zonesChanged();
    renderZones();
  }

  /* ============================== 搜索 ================================ */
  function doSearch() {
    const r = RC().searchZonedPlans(S.zones, S.ctx.params.reedDents,
      S.ctx.baselineDents, { maxCombos: 48, topK: 6 });
    if (!r.ok) {
      S.cands = []; S.sel = -1; S.cmp = -1;
      renderCands();
      const z = S.zones[r.zone];
      $('#rdSearchHint').textContent =
        `区段 ${r.zone + 1}（第 ${z.from}–${z.to} 根）在当前限制下无可行序列：` +
        `请放宽每筘上限 / 连续空筘上限${z.mirror ? '，或检查镜像与根数奇偶' : ''}。`;
      toast(`区段 ${r.zone + 1} 无可行穿筘序列`, 2600);
      return;
    }
    S.cands = r.plans;
    S.sel = 0; S.cmp = -1;
    S.dents = r.plans[0].seq.slice();
    $('#rdSearchHint').textContent = `共 ${r.plans.length} 个候选。`;
    renderCands();
    recheck();
    drawPreview();
  }

  function renderCands() {
    const box = $('#rdCandList');
    box.innerHTML = '';
    if (!S.cands.length) {
      box.innerHTML = '<p class="hint">设置区段后点击“搜索整幅穿筘序列”。</p>';
      updateAdoptBtn();
      return;
    }
    S.cands.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'rd-cand' + (i === S.sel ? ' sel' : '');
      const zoneBits = c.metrics.map((m, zi) =>
        `<span class="rd-cand-zone" style="border-color:${zoneColor(zi)}">段${zi + 1} ${fmt2(m.density)}</span>`).join('');
      row.innerHTML =
        `<label class="rd-cand-main"><input type="radio" name="rdCand" ${i === S.sel ? 'checked' : ''}>
           <b>候选${i + 1}</b></label>
         <span class="rd-cand-meta">密度误差 ${fmt2(c.densityErr)} 根/cm · 共 ${c.totalDents} 筘 · 空筘 ${c.emptyDents} · 改动 ${c.changes} 根</span>
         <label class="rd-cand-cmp" title="与主选候选叠加比较"><input type="checkbox" ${i === S.cmp ? 'checked' : ''} ${i === S.sel ? 'disabled' : ''}> 对比</label>
         <div class="rd-cand-zones">${zoneBits}</div>`;
      row.querySelector('input[type=radio]').addEventListener('change', () => {
        S.sel = i;
        if (S.cmp === i) S.cmp = -1;
        S.dents = c.seq.slice();
        renderCands();
        recheck();
        drawPreview();
      });
      const cmpBox = row.querySelector('.rd-cand-cmp input');
      cmpBox.addEventListener('change', () => {
        S.cmp = cmpBox.checked ? i : -1;
        renderCands();
        drawPreview();
      });
      box.appendChild(row);
    });
    updateAdoptBtn();
  }

  /* ============================== 问题列表 ============================ */
  const ISSUE_NAMES = {
    miss: '漏穿', over: '重穿', cap: '每筘超限', span: '跨区段筘',
    width: '宽度偏差', 'empty-run': '空筘超限', mirror: '镜像破坏',
  };

  function renderIssues() {
    const box = $('#rdIssueList');
    $('#rdIssueCount').textContent = S.issues.length;
    box.innerHTML = '';
    if (!S.dents || !S.dents.length) {
      box.innerHTML = '<p class="hint">搜索候选后在此复核问题。</p>';
      return;
    }
    if (!S.issues.length) {
      box.innerHTML = '<p class="hint ok-hint">✓ 未发现漏穿 / 重穿 / 宽度偏差 / 空筘超限 / 镜像破坏。</p>';
      return;
    }
    S.issues.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'rd-issue ' + (it.level === 'error' ? 'err' : 'warn');
      row.innerHTML =
        `<span class="rd-issue-code">${ISSUE_NAMES[it.code] || it.code}</span>` +
        `<span class="rd-issue-msg">${escapeHtml(it.msg)}</span>` +
        `<button class="btn tiny">定位</button>`;
      row.querySelector('button').addEventListener('click', () => locateIssue(it));
      box.appendChild(row);
    });
  }

  /** 点选异常 → 追到经线、筘号与区段 */
  function locateIssue(it) {
    let dent = it.dent;
    if (!dent && it.endFrom != null && S.dents) {
      const arr = RC().endToDentArr(S.dents);
      dent = (arr[it.endFrom - 1] != null ? arr[it.endFrom - 1] : 0) + 1;
    }
    if (dent) {
      flashDents(dent, dent);
      scrollPreviewToDent(dent);
      const walk = RC().dentWalkFull(S.dents);
      const w = walk[dent - 1];
      const zi = zoneOfDent(dent);
      $('#rdTrace').textContent =
        `第 ${dent} 筘（${w && w.take ? `第 ${w.from}–${w.to} 根` : '空筘'}）` +
        (zi >= 0 ? ` · 区段 ${zi + 1}` : '') + ` · ${it.msg}`;
    } else if (it.endFrom != null) {
      $('#rdTrace').textContent = `第 ${it.endFrom}–${it.endTo} 根 · ${it.msg}`;
    }
  }

  function zoneOfDent(dent) {
    const ranges = RC().zoneDentRanges(S.zones, S.dents || []);
    for (let i = 0; i < ranges.length; i++) {
      if (dent - 1 >= ranges[i].d0 && dent - 1 <= ranges[i].d1) return i;
    }
    return -1;
  }

  /* ============================== 采纳 ================================ */
  async function adopt() {
    if (S.sel < 0 || !S.dents) return;
    const errs = S.issues.filter(i => i.level === 'error').length;
    if (errs) { toast(`仍有 ${errs} 个错误，不能采纳`); return; }
    const warns = S.issues.filter(i => i.level !== 'error');
    const cand = S.cands[S.sel];
    const zoned = {
      zones: deepClone(S.zones),
      dents: S.dents.slice(),
      metrics: cand ? cand.metrics : RC().zoneMetrics(S.zones, S.dents, S.ctx.params.reedDents),
      emptyDents: S.dents.reduce((s, v) => s + (v === 0 ? 1 : 0), 0),
      changes: cand ? cand.changes : RC().changesVs(S.dents, S.ctx.baselineDents),
      note: warns.length ? warns.map(w => w.msg).join('；') : null,
    };
    try {
      await window.__loomSheetAPI.adoptZonedPlan(zoned);
      close();
    } catch (e) {
      toast('采纳失败：' + (e.message || e), 3000);
    }
  }

  /* ============================== 经线尺 ============================== */
  const R_PADL = 40, R_PADR = 10, R_PADT = 16, R_BANDH = 26, R_H = 64;
  let rulerCvs, rulerCtx, rulerW = 0;
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  function layoutCanvases() {
    rulerCvs = $('#rdRuler');
    const wrap = rulerCvs.parentElement;
    rulerW = Math.max(300, wrap.clientWidth - 2);
    rulerCvs.width = Math.round(rulerW * dpr);
    rulerCvs.height = Math.round(R_H * dpr);
    rulerCvs.style.width = rulerW + 'px';
    rulerCvs.style.height = R_H + 'px';
    rulerCtx = rulerCvs.getContext('2d');
    rulerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRuler();
    drawPreview();
  }

  const endX = (e) => R_PADL + (e - 1) / Math.max(1, S.ctx.plan.totalEnds) * (rulerW - R_PADL - R_PADR);
  const xToEnd = (x) => Math.max(1, Math.min(S.ctx.plan.totalEnds,
    Math.round((x - R_PADL) / (rulerW - R_PADL - R_PADR) * S.ctx.plan.totalEnds) + 1));

  function drawRuler() {
    if (!rulerCtx || !S.ctx) return;
    const ctx = rulerCtx;
    const E = S.ctx.plan.totalEnds;
    ctx.clearRect(0, 0, rulerW, R_H);
    // 底尺
    ctx.fillStyle = '#fffdf7';
    ctx.fillRect(R_PADL, R_PADT, rulerW - R_PADL - R_PADR, R_BANDH);
    // 校正单位刻度
    ctx.strokeStyle = '#e4dcc9';
    ctx.fillStyle = '#8a8272';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    const step = Math.max(S.alignU, Math.ceil(E / 40));
    for (let e = 0; e <= E; e += step) {
      const x = endX(e + 1);
      ctx.beginPath(); ctx.moveTo(x, R_PADT); ctx.lineTo(x, R_PADT + 4); ctx.stroke();
    }
    // 端号
    ctx.fillText('1', endX(1), R_PADT - 4);
    ctx.fillText(String(E), Math.min(endX(E), rulerW - 14), R_PADT - 4);
    // 区段带
    S.zones.forEach((z, zi) => {
      const x0 = endX(z.from), x1 = endX(z.to + 1);
      ctx.fillStyle = zoneColor(zi) + '55';
      ctx.fillRect(x0, R_PADT, x1 - x0, R_BANDH);
      if (z.locked) {
        ctx.save();
        ctx.beginPath(); ctx.rect(x0, R_PADT, x1 - x0, R_BANDH); ctx.clip();
        ctx.strokeStyle = zoneColor(zi);
        ctx.lineWidth = 1;
        for (let x = x0 - R_BANDH; x < x1 + R_BANDH; x += 6) {
          ctx.beginPath(); ctx.moveTo(x, R_PADT + R_BANDH); ctx.lineTo(x + R_BANDH, R_PADT); ctx.stroke();
        }
        ctx.restore();
      }
      ctx.strokeStyle = zoneColor(zi);
      ctx.lineWidth = zi === S.selZone ? 2 : 1;
      ctx.strokeRect(x0 + 0.5, R_PADT + 0.5, x1 - x0 - 1, R_BANDH - 1);
      // 段号标签
      ctx.fillStyle = zoneColor(zi);
      ctx.font = 'bold 10px sans-serif';
      if (x1 - x0 > 14) ctx.fillText(String(zi + 1), (x0 + x1) / 2, R_PADT + R_BANDH / 2 + 3);
      // 边界手柄（非末段）
      if (zi < S.zones.length - 1) {
        const lockedB = z.locked || S.zones[zi + 1].locked;
        ctx.fillStyle = lockedB ? '#b9ae94' : '#23211d';
        ctx.beginPath();
        ctx.moveTo(x1 - 4, R_PADT + R_BANDH + 3); ctx.lineTo(x1 + 4, R_PADT + R_BANDH + 3);
        ctx.lineTo(x1, R_PADT + R_BANDH + 10); ctx.closePath(); ctx.fill();
      }
    });
    // 拖选预览
    if (S.drag && S.drag.mode === 'create' && S.drag.cur != null) {
      const a = Math.min(S.drag.start, S.drag.cur), b = Math.max(S.drag.start, S.drag.cur);
      ctx.fillStyle = 'rgba(156,74,47,.25)';
      ctx.fillRect(endX(a), R_PADT, endX(b + 1) - endX(a), R_BANDH);
      ctx.fillStyle = '#9c4a2f';
      ctx.font = '10px sans-serif';
      ctx.fillText(`${a}–${b}`, (endX(a) + endX(b + 1)) / 2, R_PADT + R_BANDH + 12);
    }
    if (S.drag && S.drag.mode === 'bound') {
      const x = endX(S.drag.cur);
      ctx.strokeStyle = '#9c4a2f';
      ctx.beginPath(); ctx.moveTo(x, R_PADT - 2); ctx.lineTo(x, R_PADT + R_BANDH + 10); ctx.stroke();
      ctx.fillStyle = '#9c4a2f';
      ctx.font = '10px sans-serif';
      ctx.fillText(String(S.drag.cur), x, R_PADT - 5);
    }
  }

  function rulerPointerPos(ev) {
    const rect = rulerCvs.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function onRulerDown(ev) {
    if (!S.ctx) return;
    const { x, y } = rulerPointerPos(ev);
    const E = S.ctx.plan.totalEnds;
    // 边界手柄命中（±6px，手柄行或段带内）
    for (let zi = 0; zi < S.zones.length - 1; zi++) {
      const bx = endX(S.zones[zi].to + 1);
      if (Math.abs(x - bx) <= 6 && y >= R_PADT - 2) {
        if (S.zones[zi].locked || S.zones[zi + 1].locked) {
          toast('锁定区段的边界不可调整');
          return;
        }
        S.drag = { mode: 'bound', zi, cur: S.zones[zi].to, moved: false };
        ev.preventDefault();
        return;
      }
    }
    if (x < R_PADL || x > rulerW - R_PADR) return;
    const e = xToEnd(x);
    S.drag = { mode: 'create', start: e, cur: e, moved: false };
    ev.preventDefault();
  }

  function onRulerMove(ev) {
    if (!S.drag) return;
    const { x } = rulerPointerPos(ev);
    const e = xToEnd(x);
    if (S.drag.mode === 'create') {
      if (e !== S.drag.start) S.drag.moved = true;
      S.drag.cur = e;
    } else if (S.drag.mode === 'bound') {
      const zi = S.drag.zi;
      const lo = S.zones[zi].from;
      const hi = S.zones[zi + 1].to - 1;
      const cur = Math.max(lo, Math.min(hi, e));
      if (cur !== S.drag.cur) S.drag.moved = true;
      S.drag.cur = cur;
    }
    drawRuler();
  }

  function onRulerUp() {
    if (!S.drag) return;
    const d = S.drag;
    S.drag = null;
    if (d.mode === 'create') {
      if (!d.moved) {
        // 单击：选中区段
        const zi = S.zones.findIndex(z => d.start >= z.from && d.start <= z.to);
        if (zi >= 0) { S.selZone = zi; renderZones(); drawRuler(); }
        return;
      }
      const a = Math.min(d.start, d.cur), b = Math.max(d.start, d.cur);
      const spec = RC().defaultSpec(S.ctx.plan.loomDensity, a, b);
      const out = RC().carveZone(S.zones, a, b, spec);
      if (!out) { toast('拖选范围落入锁定区段'); drawRuler(); return; }
      S.zones = RC().normalizeZones(out, S.ctx.plan.totalEnds, S.ctx.plan.loomDensity);
      const moved = RC().correctBoundaries(S.zones, S.alignU, S.ctx.plan.totalEnds);
      S.selZone = S.zones.findIndex(z => z.from <= b && z.to >= a);
      zonesChanged();
      renderZones();
      toast(`已建立区段 ${S.selZone + 1}` +
        (moved.length ? `；${moved.length} 处边界已按 ${S.alignU} 根单位校正` : ''));
    } else if (d.mode === 'bound') {
      if (!d.moved) { drawRuler(); return; }
      const zi = d.zi;
      S.zones[zi].to = d.cur;
      S.zones[zi + 1].from = d.cur + 1;
      const moved = RC().correctBoundaries(S.zones, S.alignU, S.ctx.plan.totalEnds);
      zonesChanged();
      renderZones();
      toast(moved.length ? `边界已按 ${S.alignU} 根单位校正到第 ${S.zones[zi].to} 根` : '边界已调整');
    }
  }

  /* ============================== 筘位预览 ============================ */
  const P_PADL = 46, P_PADT = 6, P_ZH = 16, P_GAP = 3, P_ROWH = 4, P_DH = 20, P_PADB = 4;
  let pvCvs, pvCtx;

  function currentRows() {
    const d = S.ctx.snapshot;
    return Math.max(1, Math.min(d.picks || 1, 48));
  }

  function drawPreview() {
    pvCvs = $('#rdPreview');
    if (!pvCvs || !S.ctx) return;
    const dents = S.dents || [];
    const dentW = S.dentW;
    const rows = currentRows();
    const fabricH = rows * P_ROWH;
    const H = P_PADT + P_ZH + P_GAP + fabricH + P_GAP + P_DH + P_PADB;
    const W = P_PADL + Math.max(1, dents.length) * dentW + 8;
    pvCvs.width = Math.round(W * dpr);
    pvCvs.height = Math.round(H * dpr);
    pvCvs.style.width = W + 'px';
    pvCvs.style.height = H + 'px';
    pvCtx = pvCvs.getContext('2d');
    pvCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ctx = pvCtx;
    ctx.clearRect(0, 0, W, H);

    if (!dents.length) {
      ctx.fillStyle = '#8a8272';
      ctx.font = '12px sans-serif';
      ctx.fillText('搜索候选后在此预览筘位。', P_PADL, P_PADT + 20);
      return;
    }

    const snap = S.ctx.snapshot;
    const derived = Engine().derive(snap);
    const cg = Engine().colorGrid(snap, derived, 'front');
    const E0 = snap.ends || 1, P0 = snap.picks || 1;
    const ranges = RC().zoneDentRanges(S.zones, dents);
    const zoneTop = P_PADT, fabricTop = P_PADT + P_ZH + P_GAP, densTop = fabricTop + fabricH + P_GAP;

    // ① 区段条
    S.zones.forEach((z, zi) => {
      const r = ranges[zi];
      if (!r || r.d1 < r.d0) return;
      const x0 = P_PADL + r.d0 * dentW, x1 = P_PADL + (r.d1 + 1) * dentW;
      ctx.fillStyle = zoneColor(zi) + '66';
      ctx.fillRect(x0, zoneTop, x1 - x0, P_ZH);
      if (z.locked) {
        ctx.save();
        ctx.beginPath(); ctx.rect(x0, zoneTop, x1 - x0, P_ZH); ctx.clip();
        ctx.strokeStyle = zoneColor(zi);
        for (let x = x0 - P_ZH; x < x1 + P_ZH; x += 5) {
          ctx.beginPath(); ctx.moveTo(x, zoneTop + P_ZH); ctx.lineTo(x + P_ZH, zoneTop); ctx.stroke();
        }
        ctx.restore();
      }
      ctx.strokeStyle = zoneColor(zi);
      ctx.strokeRect(x0 + 0.5, zoneTop + 0.5, x1 - x0 - 1, P_ZH - 1);
      ctx.fillStyle = '#23211d';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'left';
      if (x1 - x0 > 30) ctx.fillText(`段${zi + 1}`, x0 + 3, zoneTop + 11);
    });

    // ② 组织图（按实际筘位拉伸；空筘 = 开缝）
    let end = 0;
    for (let i = 0; i < dents.length; i++) {
      const take = dents[i];
      const x0 = P_PADL + i * dentW;
      if (take === 0) {
        ctx.fillStyle = '#f3e9e6';
        ctx.fillRect(x0, fabricTop, dentW, fabricH);
        ctx.strokeStyle = '#d8b9b0';
        ctx.beginPath();
        ctx.moveTo(x0, fabricTop + fabricH); ctx.lineTo(x0 + dentW, fabricTop);
        ctx.stroke();
        continue;
      }
      const sub = dentW / take;
      for (let k = 0; k < take; k++) {
        const col = (end + k) % E0;
        for (let r = 0; r < rows; r++) {
          const hex = cg[r % P0][col] || '#e9e2d2';
          ctx.fillStyle = hex;
          ctx.fillRect(x0 + k * sub, fabricTop + r * P_ROWH, Math.ceil(sub * 10) / 10, P_ROWH);
        }
      }
      end += take;
    }

    // ③ 密度条（每筘根数 0–4 → 灰度条；空筘红 tick）
    for (let i = 0; i < dents.length; i++) {
      const take = dents[i];
      const x0 = P_PADL + i * dentW;
      if (take === 0) {
        ctx.fillStyle = '#b3352a';
        ctx.fillRect(x0, densTop + P_DH - 3, Math.max(1, dentW - 0.5), 3);
      } else {
        const h = Math.round(take / 4 * (P_DH - 4));
        ctx.fillStyle = '#6b6455';
        ctx.fillRect(x0, densTop + (P_DH - 2) - h, Math.max(1, dentW - 0.5), h);
      }
    }
    ctx.strokeStyle = '#b9ae94';
    ctx.beginPath(); ctx.moveTo(P_PADL, densTop + P_DH - 1.5);
    ctx.lineTo(P_PADL + dents.length * dentW, densTop + P_DH - 1.5); ctx.stroke();

    // ④ 对比候选叠加（筘边界 tick：红 = 与主选不同）
    if (S.cmp >= 0 && S.cands[S.cmp]) {
      const cd = S.cands[S.cmp].seq;
      const n = Math.min(cd.length, dents.length);
      for (let i = 0; i < n; i++) {
        const x0 = P_PADL + i * dentW;
        ctx.fillStyle = cd[i] !== dents[i] ? 'rgba(179,53,42,.9)' : 'rgba(35,33,29,.25)';
        ctx.fillRect(x0, zoneTop - 4, Math.max(1, dentW - 0.5), 3);
      }
      ctx.fillStyle = '#b3352a';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`对比候选${S.cmp + 1}（${cd.length} 筘）`, 4, zoneTop - 1);
    }

    // ⑤ 问题标记
    S.issues.forEach(it => {
      if (!it.dent) return;
      const x0 = P_PADL + (it.dent - 1) * dentW;
      ctx.fillStyle = it.level === 'error' ? '#b3352a' : '#b8862f';
      ctx.beginPath();
      ctx.moveTo(x0 + dentW / 2, fabricTop - 3);
      ctx.lineTo(x0 + dentW / 2 - 3, fabricTop - 8);
      ctx.lineTo(x0 + dentW / 2 + 3, fabricTop - 8);
      ctx.closePath(); ctx.fill();
    });

    // ⑥ 闪烁定位
    if (S.flash && performance.now() < S.flash.until) {
      const x0 = P_PADL + (S.flash.dent0 - 1) * dentW;
      const x1 = P_PADL + S.flash.dent1 * dentW;
      ctx.strokeStyle = '#e07b39';
      ctx.lineWidth = 2;
      ctx.strokeRect(x0 - 1, fabricTop - 2, x1 - x0 + 2, fabricH + 4);
    }

    // 轴标签
    ctx.fillStyle = '#8a8272';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('区段', P_PADL - 4, zoneTop + 11);
    ctx.fillText('组织', P_PADL - 4, fabricTop + 10);
    ctx.fillText('根/筘', P_PADL - 4, densTop + 12);
  }

  function flashDents(d0, d1) {
    S.flash = { dent0: d0, dent1: d1, until: performance.now() + 2400 };
    drawPreview();
    setTimeout(() => { if (S.flash && performance.now() >= S.flash.until) { S.flash = null; drawPreview(); } }, 2500);
  }

  function scrollPreviewToDent(dent) {
    const wrap = $('#rdPreviewWrap');
    const x = P_PADL + (dent - 1) * S.dentW;
    wrap.scrollTo({ left: x - wrap.clientWidth / 2, behavior: 'smooth' });
  }

  function onPreviewClick(ev) {
    if (!S.dents || !S.dents.length) return;
    const rect = pvCvs.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const dent = Math.floor((x - P_PADL) / S.dentW) + 1;
    if (dent < 1 || dent > S.dents.length) return;
    const walk = RC().dentWalkFull(S.dents);
    const w = walk[dent - 1];
    const zi = zoneOfDent(dent);
    const z = zi >= 0 ? S.zones[zi] : null;
    $('#rdTrace').textContent = w.take === 0
      ? `第 ${dent} 筘：空筘（开缝）` + (z ? ` · 区段 ${zi + 1}（第 ${z.from}–${z.to} 根）` : '')
      : `第 ${dent} 筘：第 ${w.from}–${w.to} 根（${w.take} 根）` +
        (z ? ` · 区段 ${zi + 1}（目标 ${fmt2(z.targetDensity)} 根/cm）` : '');
    flashDents(dent, dent);
    if (zi >= 0) { S.selZone = zi; renderZones(); drawRuler(); }
  }

  /* ============================== 打印分区图 ========================== */
  /** 打印稿分区图：区段边界 / 空筘 / 锁定区段（供 loom-ui 打印调用） */
  function drawPrintMap(cvs, sheet) {
    const rp = sheet.reedPlan || {};
    const zones = rp.zones || [];
    const dents = rp.dents || [];
    if (!zones.length || !dents.length) { cvs.classList.add('hidden'); return; }
    const W = 760, ZH = 22, DH = 14, LH = 14;
    const H = 8 + ZH + 4 + DH + 4 + LH + 6;
    cvs.width = W; cvs.height = H;
    cvs.style.width = '100%';
    cvs.style.maxWidth = W + 'px';
    const ctx = cvs.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const padL = 8, innerW = W - padL * 2;
    const dentW = innerW / dents.length;
    const ranges = RC().zoneDentRanges(zones, dents);
    const zoneTop = 8, dentTop = zoneTop + ZH + 4, labTop = dentTop + DH + 4;

    // 区段带 + 边界
    zones.forEach((z, zi) => {
      const r = ranges[zi];
      if (!r || r.d1 < r.d0) return;
      const x0 = padL + r.d0 * dentW, x1 = padL + (r.d1 + 1) * dentW;
      ctx.fillStyle = zoneColor(zi) + '55';
      ctx.fillRect(x0, zoneTop, x1 - x0, ZH);
      if (z.locked) {
        ctx.save();
        ctx.beginPath(); ctx.rect(x0, zoneTop, x1 - x0, ZH); ctx.clip();
        ctx.strokeStyle = zoneColor(zi);
        for (let x = x0 - ZH; x < x1 + ZH; x += 6) {
          ctx.beginPath(); ctx.moveTo(x, zoneTop + ZH); ctx.lineTo(x + ZH, zoneTop); ctx.stroke();
        }
        ctx.restore();
        ctx.fillStyle = '#23211d';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('锁', x1 - 3, zoneTop + 10);
      }
      ctx.strokeStyle = '#23211d';
      ctx.lineWidth = zi === 0 ? 1 : 1.5;
      ctx.strokeRect(x0 + 0.5, zoneTop + 0.5, x1 - x0 - 1, ZH - 1);
      ctx.fillStyle = '#23211d';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`段${zi + 1}（${z.from}–${z.to}）`, x0 + 3, zoneTop + ZH - 7);
    });
    // 筘条：实筘灰格、空筘红圈
    for (let i = 0; i < dents.length; i++) {
      const x0 = padL + i * dentW;
      if (dents[i] === 0) {
        ctx.strokeStyle = '#b3352a';
        ctx.beginPath();
        ctx.arc(x0 + dentW / 2, dentTop + DH / 2, Math.min(3, dentW / 2), 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#6b6455';
        ctx.fillRect(x0, dentTop + DH - dents[i] * 2.5, Math.max(0.6, dentW - 0.4), dents[i] * 2.5);
      }
    }
    ctx.strokeStyle = '#888';
    ctx.beginPath(); ctx.moveTo(padL, dentTop + DH + 0.5); ctx.lineTo(padL + innerW, dentTop + DH + 0.5); ctx.stroke();
    // 底部标注
    ctx.fillStyle = '#444';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`共 ${dents.length} 筘 · 空筘 ${dents.filter(v => v === 0).length}（红圈）· 斜纹 = 锁定区段`, padL, labTop + 9);
  }

  /* ============================== 事件绑定 ============================ */
  function bind() {
    $$('[data-close-rd]').forEach(b => b.addEventListener('click', close));
    $('#reedModal').addEventListener('click', (e) => { if (e.target.id === 'reedModal') close(); });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && S.open) close();
    });
    $('#rdLockEdges').addEventListener('click', lockEdges);
    $('#rdResetZones').addEventListener('click', resetZones);
    $('#rdSearch').addEventListener('click', doSearch);
    $('#rdAdopt').addEventListener('click', adopt);
    $('#rdZoomIn').addEventListener('click', () => {
      S.dentW = Math.min(16, S.dentW + 1); drawPreview();
    });
    $('#rdZoomOut').addEventListener('click', () => {
      S.dentW = Math.max(3, S.dentW - 1); drawPreview();
    });

    rulerCvs = $('#rdRuler');
    rulerCvs.addEventListener('pointerdown', onRulerDown);
    rulerCvs.addEventListener('pointermove', onRulerMove);
    window.addEventListener('pointerup', onRulerUp);
    pvCvs = $('#rdPreview');
    pvCvs.addEventListener('click', onPreviewClick);
    window.addEventListener('resize', () => { if (S.open) layoutCanvases(); });
  }

  /* ============================== 初始化 ============================== */
  function init() {
    if (!$('#reedModal')) return false;
    bind();
    window.__reedAPI = { open, close, isOpen: () => S.open, drawPrintMap, state: S };
    return true;
  }

  if (!init() && typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => init());
  }
})();
