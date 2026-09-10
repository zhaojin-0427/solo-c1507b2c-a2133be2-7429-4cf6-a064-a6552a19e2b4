/* =====================================================================
 * reverse-ui.js — 目标组织反推模块界面（原生 Canvas，无外部依赖）
 *
 * 状态独立于主图板 state，仅通过 window.__loom / 全局 Engine、Reverse 与
 * 主应用通信；“应用为新草稿”时调用全局 loadDraft()，不覆盖原数据。
 * ===================================================================== */
'use strict';

(function () {

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const CELL = 26;

  const R = {
    target: null,
    tool: 1,
    result: null,
    selected: null,   // 选中的候选（包装对象）
    explain: null,
    gesture: null,
    hover: null,
  };

  let cvs, ov, ctx, octx;
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  /* ------------------------------- 目标图 ------------------------------- */
  function syncDimsInputs() {
    $('#revEnds').value = R.target.ends;
    $('#revPicks').value = R.target.picks;
    const d = window.__loom ? window.__loom.state.draft : null;
    $('#revShafts').value = clamp(d ? d.shafts : 4, 2, 8);
    $('#revTreadles').value = clamp(d ? d.treadles : 4, 2, 8);
    $('#revMaxFloat').value = d ? d.maxFloat : 3;
  }

  function resizeBoards() {
    if (!R.target) return;
    const W = R.target.ends * CELL, H = R.target.picks * CELL;
    // 占位元素撑起滚动容器，绝对定位的两张画布才能完整显示与点击
    const sizer = $('#revBoardSizer');
    if (sizer) { sizer.style.width = W + 'px'; sizer.style.height = H + 'px'; }
    for (const c of [cvs, ov]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = W + 'px';
      c.style.height = H + 'px';
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    drawTarget();
    drawOverlay();
  }

  function drawTarget() {
    const t = R.target;
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    // 底格
    for (let p = 0; p < t.picks; p++) {
      for (let e = 0; e < t.ends; e++) {
        const v = t.grid[p][e];
        const x = e * CELL, y = p * CELL;
        if (v === 1) ctx.fillStyle = '#274060';        // 经在上：靛蓝
        else if (v === 0) ctx.fillStyle = '#c8784f';   // 纬在上：赭橙
        else ctx.fillStyle = '#f2ecdd';                // 不限：纸白
        ctx.fillRect(x, y, CELL, CELL);
        if (v === -1) {
          ctx.fillStyle = 'rgba(107,100,87,.55)';
          ctx.beginPath();
          ctx.arc(x + CELL / 2, y + CELL / 2, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    // 网格线
    ctx.strokeStyle = '#b9ae94';
    ctx.lineWidth = 1;
    ctx.strokeRect(.5, .5, t.ends * CELL - 1, t.picks * CELL - 1);
    ctx.strokeStyle = 'rgba(185,174,148,.65)';
    ctx.beginPath();
    for (let e = 1; e < t.ends; e++) {
      const x = e * CELL + .5;
      ctx.moveTo(x, 0); ctx.lineTo(x, t.picks * CELL);
    }
    for (let p = 1; p < t.picks; p++) {
      const y = p * CELL + .5;
      ctx.moveTo(0, y); ctx.lineTo(t.ends * CELL, y);
    }
    ctx.stroke();
  }

  /* 叠加层：悬停、冲突格、“不限”实现标记 */
  function drawOverlay() {
    const t = R.target;
    octx.clearRect(0, 0, ov.width, ov.height);

    // 冲突叠色
    if (R.explain) {
      for (const m of R.explain.mismatches) {
        const x = m.e * CELL, y = m.p * CELL;
        octx.fillStyle = 'rgba(179,53,42,.55)';
        octx.fillRect(x, y, CELL, CELL);
        octx.strokeStyle = '#8e2419';
        octx.lineWidth = 2;
        octx.beginPath();
        octx.moveTo(x + 5, y + 5); octx.lineTo(x + CELL - 5, y + CELL - 5);
        octx.moveTo(x + CELL - 5, y + 5); octx.lineTo(x + 5, y + CELL - 5);
        octx.stroke();
      }
      // “不限”格的实现角标
      octx.fillStyle = 'rgba(45,42,36,.6)';
      for (const rl of R.explain.realized) {
        const cx = rl.e * CELL + CELL / 2, cy = rl.p * CELL + CELL / 2;
        octx.beginPath();
        octx.arc(cx, cy, 3.4, 0, Math.PI * 2);
        octx.fill();
      }
      // 冲突涉及的经列 / 纬行描边
      const endSet = new Set(), pickSet = new Set();
      R.explain.warpConflicts.forEach(c => { endSet.add(c.a); endSet.add(c.b); });
      R.explain.weftConflicts.forEach(c => { pickSet.add(c.a); pickSet.add(c.b); });
      octx.strokeStyle = 'rgba(179,53,42,.9)';
      octx.lineWidth = 2.5;
      endSet.forEach(e => octx.strokeRect(e * CELL + 1.5, 1.5, CELL - 3, t.picks * CELL - 3));
      pickSet.forEach(p => octx.strokeRect(1.5, p * CELL + 1.5, t.ends * CELL - 3, CELL - 3));

      // 超长浮线格：橙色实框（与冲突红叉区分）
      if (R.explain.floatViolations && R.explain.floatViolations.length) {
        octx.strokeStyle = 'rgba(184,134,47,.95)';
        octx.lineWidth = 2;
        for (const f of R.explain.floatViolations)
          octx.strokeRect(f.e * CELL + 2.5, f.p * CELL + 2.5, CELL - 5, CELL - 5);
      }
    }

    // 悬停
    if (R.hover) {
      octx.fillStyle = 'rgba(217,164,65,.25)';
      octx.fillRect(R.hover.e * CELL, R.hover.p * CELL, CELL, CELL);
    }
  }

  function eventCell(ev) {
    const rect = cvs.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    const e = Math.floor(x / CELL), p = Math.floor(y / CELL);
    if (e < 0 || p < 0 || e >= R.target.ends || p >= R.target.picks) return null;
    return { e, p };
  }

  function paintCell(cell, value) {
    if (!cell) return;
    if (R.target.grid[cell.p][cell.e] !== value) {
      R.target.grid[cell.p][cell.e] = value;
      // 目标一变，旧候选与叠色失效
      invalidateResults();
    }
  }

  function invalidateResults() {
    R.result = null; R.selected = null; R.explain = null;
    $('#revCandidates').innerHTML = '<p class="hint">目标已修改，请重新搜索。</p>';
    $('#revExplain').classList.add('hidden');
    $('#revSummary').classList.add('hidden');
    $('#revApply').disabled = true;
    drawOverlay();
  }

  /* ------------------------------- 搜索 ------------------------------- */
  function setStatus(html, running) {
    const el = $('#revStatus');
    el.innerHTML = html || '';
    el.classList.toggle('running', !!running);
  }

  function readConditions() {
    const draft = window.__loom.state.draft;
    return {
      base: draft,
      shafts: clamp(parseInt($('#revShafts').value, 10) || 4, 2, 8),
      treadles: clamp(parseInt($('#revTreadles').value, 10) || 4, 2, 8),
      maxFloat: clamp(parseInt($('#revMaxFloat').value, 10) || 3, 1, 64),
      lockThreading: $('#revLockThreading').checked,
      lockTieup: $('#revLockTieup').checked,
      lockTreadling: $('#revLockTreadling').checked,
    };
  }

  /** 锁定项在目标尺寸下是否可用（越界给出明确提示）。 */
  function precheckLocks(cond) {
    const b = cond.base;
    if (cond.lockThreading) {
      for (let e = 0; e < R.target.ends; e++) {
        const v = b.threading[e % b.ends];
        if (!(v >= 0 && v < cond.shafts))
          return `锁定穿综不可用：第 ${e + 1} 根经穿在综框 ${v + 1}，超出可用综框数 ${cond.shafts}。可取消锁定或增加可用综框。`;
      }
    }
    if (cond.lockTreadling) {
      for (let p = 0; p < R.target.picks; p++) {
        const v = b.treadling[p % b.picks];
        if (!(v >= 0 && v < cond.treadles))
          return `锁定踩踏不可用：第 ${p + 1} 纬踩踏板 ${v + 1}，超出可用踏板数 ${cond.treadles}。可取消锁定或增加可用踏板。`;
      }
    }
    if (cond.lockTieup && (b.shafts < cond.shafts || b.treadles < cond.treadles))
      return `锁定联结不可用：当前联结为 ${b.shafts} 综框 × ${b.treadles} 踏板，小于所需 ${cond.shafts} × ${cond.treadles}。`;
    return null;
  }

  function runSearch() {
    const cond = readConditions();
    const err = precheckLocks(cond);
    if (err) { setStatus('<span style="color:var(--bad)">' + err + '</span>'); return; }

    $('#revSearch').disabled = true;
    setStatus('正在搜索候选…（交叉块计数 + 回溯剪枝）', true);
    R.selected = null; R.explain = null;
    $('#revExplain').classList.add('hidden');
    $('#revSummary').classList.add('hidden');
    $('#revApply').disabled = true;

    // 让状态文字先绘制，再执行同步搜索（最坏约 200–300ms）
    setTimeout(() => {
      let res;
      try {
        res = Reverse.search(R.target, cond);
      } catch (e) {
        setStatus('<span style="color:var(--bad)">搜索失败：' + (e.message || e) + '</span>');
        $('#revSearch').disabled = false;
        return;
      }
      $('#revSearch').disabled = false;
      if (!res.ok) { setStatus('<span style="color:var(--bad)">' + res.msg + '</span>'); return; }
      R.result = res;
      renderCandidates(res, cond);
    }, 30);
  }

  /* ------------------------------- 候选 UI ------------------------------- */
  function renderCandidates(res, cond) {
    const box = $('#revCandidates');
    box.innerHTML = '';

    const head = document.createElement('div');
    const truncTxt = {
      leaves: '（达到方案收集上限，保留最优的一批）',
      nodes: '（达到搜索节点上限，结果为近似最优）',
      time: '（达到搜索时限，结果为近似最优）',
      infeasible: '',
    }[res.truncated] || '';
    head.className = 'rev-result-head';
    const nCand = res.candidates.length;
    if (res.compliantExact) {
      head.innerHTML = `✓ 找到合规精确方案：<b>100%</b> 目标格满足且浮线不超过 ${res.params.maxFloat}，` +
        `共保留 ${nCand} 个候选　${truncTxt}`;
      head.style.color = 'var(--ok)';
    } else if (res.exact) {
      // 有目标全满足方案，但全部超浮线上限
      head.innerHTML = `⚠ 目标可 100% 满足，但存在<b>超长浮线</b>（限值 ${res.params.maxFloat}），` +
        `没有合规精确方案；下列最接近方案已标出超限格，可放宽浮线限值或增加综框/踏板。　${truncTxt}`;
      head.style.color = 'var(--warn)';
    } else if (res.hasCompliant) {
      // 目标不能全满足，但存在浮线合规的最近似方案
      const c0 = res.candidates.find(c => c.floatOK) || res.candidates[0];
      head.innerHTML = `✗ 精确无解，返回浮线合规的最接近方案：首位匹配 <b>${(c0.matchRate * 100).toFixed(1)}%</b>` +
        `（冲突 ${c0.conflicts}/${res.hardCount} 个目标格），浮线限值 ${res.params.maxFloat} 内。　${truncTxt}`;
      head.style.color = 'var(--bad)';
    } else {
      const c0 = res.candidates[0];
      head.innerHTML = `✗ 精确无解且均超浮线，返回最接近方案：首位匹配 <b>${(c0.matchRate * 100).toFixed(1)}%</b>` +
        `（冲突 ${c0.conflicts}/${res.hardCount} 个目标格，浮线限值 ${res.params.maxFloat}）。　${truncTxt}`;
      head.style.color = 'var(--bad)';
    }
    head.style.fontSize = '12.5px';
    head.style.marginBottom = '6px';
    box.appendChild(head);

    res.candidates.forEach((c, i) => box.appendChild(candidateCard(c, i)));

    setStatus(`搜索完成：访问 ${res.nodes} 节点 / ${res.leaves} 个完整方案，用时 ${res.elapsedMs}ms；` +
      `目标硬格 ${res.hardCount}、不限 ${res.wildCount}。`);

    // 默认选中首位并展示
    const first = box.querySelector('.rev-cand');
    if (first) first.click();
  }

  function candidateCard(c, idx) {
    const card = document.createElement('div');
    card.className = 'rev-cand';
    const pct = (c.matchRate * 100).toFixed(1);

    const badges = [];
    badges.push(`<span class="rev-badge ${c.conflicts === 0 ? 'ok' : 'bad'}">` +
      `${c.conflicts === 0 ? '精确匹配' : '冲突 ' + c.conflicts}</span>`);
    const overWarp = c.maxWarp > c.draft.maxFloat;
    const overWeft = c.maxWeft > c.draft.maxFloat;
    const floatCls = c.floatOK ? 'ok' : 'bad';
    const overTxt = !c.floatOK
      ? `（${overWarp ? '经浮' : ''}${overWarp && overWeft ? '、' : ''}${overWeft ? '纬浮' : ''}超限）`
      : ' ✓';
    badges.push(`<span class="rev-badge ${floatCls}" title="最长经浮 ${c.maxWarp}、纬浮 ${c.maxWeft}，限值 ${c.draft.maxFloat}">` +
      `浮长 ${c.maxWarp}/${c.maxWeft}${overTxt}</span>`);
    badges.push(`<span class="rev-badge">综框 ${c.usedShafts}/${c.draft.shafts}</span>`);
    badges.push(`<span class="rev-badge">踏板 ${c.usedTreadles}/${c.draft.treadles}</span>`);

    card.innerHTML = `
      <div class="rev-cand-head">
        <span class="rev-rank">${idx + 1}</span>
        <span class="rev-cand-title">匹配 ${pct}% · 改动 ${c.changes} 格 · 最小循环 ${c.repW}×${c.repH}</span>
        <span class="rev-badges">${badges.join('')}</span>
      </div>
      <div class="rev-cand-meta">
        <span>穿综：${seqText(c.draft.threading)}</span>
        <span>踩踏：${seqText(c.draft.treadling)}</span>
      </div>
      <div class="rev-thumbs"></div>`;

    const thumbs = card.querySelector('.rev-thumbs');
    const mk = (side, cap) => {
      const wrap = document.createElement('div');
      wrap.innerHTML = `<div class="rev-thumb-cap">${cap}</div>`;
      const cnv = document.createElement('canvas');
      // 非浏览器环境（无真实 canvas Node）下 appendChild 会失败，缩略图可跳过
      try {
        cnv.width = 132; cnv.height = 132;
        wrap.appendChild(cnv);
        drawThumb(cnv, c.draft, side);
      } catch (err) { /* 缩略图仅为辅助展示 */ }
      thumbs.appendChild(wrap);
    };
    mk('front', '正面');
    mk('back', '反面');

    card.addEventListener('click', () => selectCandidate(card, c));
    return card;
  }

  function seqText(arr) {
    const s = arr.map(v => v + 1).join(' ');
    return s.length > 46 ? s.slice(0, 44) + '…' : s;
  }

  function drawThumb(cnv, d, side) {
    const c = cnv.getContext('2d');
    c.imageSmoothingEnabled = false;
    const A = Engine.analyze(d);
    const cg = Engine.colorGrid(d, A.derived, side);
    const off = document.createElement('canvas');
    off.width = d.ends; off.height = d.picks;
    const o = off.getContext('2d');
    for (let p = 0; p < d.picks; p++)
      for (let e = 0; e < d.ends; e++) {
        o.fillStyle = cg[p][e] || '#e9e2d2';
        o.fillRect(e, p, 1, 1);
      }
    const sc = Math.max(1, Math.floor(Math.min(cnv.width / d.ends, cnv.height / d.picks)));
    c.drawImage(off, 0, 0, d.ends * sc, d.picks * sc);
  }

  function selectCandidate(card, c) {
    $$('.rev-cand').forEach(x => x.classList.toggle('selected', x === card));
    R.selected = c;
    R.explain = Reverse.explain(c, R.target);
    drawOverlay();
    renderExplain(c);
    renderSummary(c);
    $('#revApply').disabled = false;
  }

  /* ------------------------------- 冲突说明 ------------------------------- */
  function renderExplain(c) {
    const box = $('#revExplain');
    const info = R.explain;
    const conflictNotes = c.conflicts > 0 ? Reverse.explainNotes(info) : [];
    const overNotes = !c.floatOK ? Reverse.floatNotes(info) : [];

    if (!conflictNotes.length && !overNotes.length) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }

    let html = '';
    if (conflictNotes.length) {
      html += '<h4>目标冲突原因（为什么无法同时满足）</h4><ul>';
      conflictNotes.slice(0, 12).forEach(n => { html += '<li>' + n + '</li>'; });
      html += '</ul>';
      if (conflictNotes.length > 12)
        html += `<div class="rev-more">另有 ${conflictNotes.length - 12} 条同类原因未列出。</div>`;
    }
    if (overNotes.length) {
      html += '<h4>超长浮线（超过限值 ' + c.draft.maxFloat + '）</h4><ul>';
      overNotes.forEach(n => { html += '<li>' + n + '</li>'; });
      html += '</ul>';
      html += '<div class="rev-more">左图橙框 = 超长浮线格；可放宽浮线限值、增加综框/踏板，或改标部分目标格为“不限”。</div>';
    }
    if (conflictNotes.length)
      html += `<div class="rev-more">左图红叉格 = 目标与候选不一致；红框列/行 = 共享综框或踏板的冲突经/纬；灰点 = “不限”格被候选实现成的朝向。</div>`;
    box.innerHTML = html;
    box.classList.remove('hidden');
  }

  /* ------------------------------- 改动摘要 ------------------------------- */
  function renderSummary(c) {
    const base = window.__loom.state.draft;
    const s = Reverse.changeSummary(c, base);
    const box = $('#revSummary');
    const fmts = (v) => (v < 0 ? '—' : v + 1);

    const line = (label, arr) => {
      if (!arr.length) return `<tr><td>${label}</td><td>无</td></tr>`;
      const shown = arr.slice(0, 10).map(x =>
        `#${x.i + 1}: ${fmts(x.from)}→${fmts(x.to)}`).join('，');
      return `<tr><td>${label}${arr.length > 10 ? ` <span class="rev-more">等 ${arr.length} 项</span>` : ''}</td>` +
             `<td class="rev-diff-line">${shown}${arr.length > 10 ? '…' : ''}</td></tr>`;
    };

    let html = `<h4>应用前改动摘要（应用将新建草稿，不覆盖原稿）</h4>
      <table class="rev-sum-table">
        <tr><th></th><th>综框</th><th>踏板</th><th>经线</th><th>纬线</th></tr>
        <tr><td>当前稿</td><td>${s.dims.from.shafts}</td><td>${s.dims.from.treadles}</td>
            <td>${s.dims.from.ends}</td><td>${s.dims.from.picks}</td></tr>
        <tr><td>新草稿</td><td>${s.dims.to.shafts}</td><td>${s.dims.to.treadles}</td>
            <td>${s.dims.to.ends}</td><td>${s.dims.to.picks}</td></tr>
      </table>
      <table class="rev-sum-table">
        ${line('穿综改动（共 ' + s.threading.changed.length + '）', s.threading.changed)}
        ${line('踩踏改动（共 ' + s.treadling.changed.length + '）', s.treadling.changed)}
        ${line('联结改动（共 ' + s.tieup.changed.length + '）',
          s.tieup.changed.map(x => ({ i: x.s * c.draft.treadles + x.t,
            from: x.from ? '有' : '无', to: x.to ? '有' : '无' })))}
      </table>`;
    const extra = [];
    if (s.threading.added.length) extra.push(`新增 ${s.threading.added.length} 根经的穿综`);
    if (s.treadling.added.length) extra.push(`新增 ${s.treadling.added.length} 纬的踩踏`);
    if (s.tieup.added.length) extra.push(`扩维区新增 ${s.tieup.added.length} 处联结`);
    if (extra.length) html += `<div class="rev-more">${extra.join('；')}。</div>`;
    box.innerHTML = html;
    box.classList.remove('hidden');
  }

  /* ------------------------------- 应用 ------------------------------- */
  function applyCandidate() {
    const c = R.selected;
    if (!c) return;
    const base = window.__loom.state.draft;
    // 不覆盖原稿：复制候选草稿，名称另起
    const nd = JSON.parse(JSON.stringify(c.draft));
    const baseName = ($('#draftName') && $('#draftName').value.trim()) || '未命名草稿';
    const name = `反推自「${baseName}」`;
    // 主应用提供 loadDraft(draft, name, id=null)；id 置 null 即另存为新草稿
    window.loadDraft(nd, name, null);
    if (window.toast) window.toast(`已应用为新草稿「${name}」，原稿未改动；确认满意后请手动保存。`, 3200);
    $('#reverseModal').classList.add('hidden');
  }

  /* ------------------------------- 事件 ------------------------------- */
  function bind() {
    $('#btnReverse').addEventListener('click', openModal);
    $$('[data-close-rev]').forEach(b =>
      b.addEventListener('click', () => $('#reverseModal').classList.add('hidden')));
    $('#reverseModal').addEventListener('click', (e) => {
      if (e.target.id === 'reverseModal') $('#reverseModal').classList.add('hidden');
    });

    $('#revResize').addEventListener('click', () => {
      const ends = clamp(parseInt($('#revEnds').value, 10) || 4, 2, 16);
      const picks = clamp(parseInt($('#revPicks').value, 10) || 4, 2, 16);
      R.target = Reverse.resizeTarget(R.target, ends, picks);
      invalidateResults();
      resizeBoards();
    });
    $('#revFromDraft').addEventListener('click', () => {
      const d = window.__loom.state.draft;
      R.target = Reverse.targetFromDraft(d, R.target.ends, R.target.picks);
      invalidateResults();
      resizeBoards();
      if (window.toast) window.toast('已从当前稿组织图（循环对齐）取入目标');
    });
    $('#revInvert').addEventListener('click', () => {
      R.target = Reverse.invertTarget(R.target);
      invalidateResults(); resizeBoards();
    });
    $('#revClear').addEventListener('click', () => {
      R.target = Reverse.clearTarget(R.target, -1);
      invalidateResults(); resizeBoards();
    });

    $$('.rev-tool').forEach(btn => btn.addEventListener('click', () => {
      R.tool = parseInt(btn.dataset.revtool, 10);
      $$('.rev-tool').forEach(b => b.classList.toggle('active', b === btn));
    }));

    cvs.addEventListener('pointerdown', (ev) => {
      const cell = eventCell(ev);
      if (!cell) return;
      cvs.setPointerCapture(ev.pointerId);
      const val = ev.button === 2 ? -1 : R.tool;
      R.gesture = { pointerId: ev.pointerId, val, last: cell };
      paintCell(cell, val);
      resizeBoardsDrawOnly();
    });
    cvs.addEventListener('pointermove', (ev) => {
      const cell = eventCell(ev);
      R.hover = cell;
      drawOverlay();
      const g = R.gesture;
      if (!g || g.pointerId !== ev.pointerId || !cell) return;
      if (g.last.e === cell.e && g.last.p === cell.p) return;
      g.last = cell;
      paintCell(cell, g.val);
      resizeBoardsDrawOnly();
    });
    window.addEventListener('pointerup', (ev) => {
      if (R.gesture && R.gesture.pointerId === ev.pointerId) R.gesture = null;
    });
    cvs.addEventListener('contextmenu', e => e.preventDefault());

    $('#revSearch').addEventListener('click', runSearch);
    $('#revApply').addEventListener('click', applyCandidate);

    // Esc 关闭
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !$('#reverseModal').classList.contains('hidden'))
        $('#reverseModal').classList.add('hidden');
    });
  }

  /** 涂绘中只重绘底图（保留 DOM 尺寸）。 */
  function resizeBoardsDrawOnly() {
    drawTarget();
    drawOverlay();
  }

  function openModal() {
    // 每次打开用当前稿尺寸 / 浮线限值同步条件
    const d = window.__loom.state.draft;
    $('#revShafts').value = clamp(d.shafts, 2, 8);
    $('#revTreadles').value = clamp(d.treadles, 2, 8);
    $('#revMaxFloat').value = d.maxFloat;
    if (!R.target) {
      R.target = Reverse.makeTarget(
        clamp(d.ends, 2, 16), clamp(d.picks, 2, 16));
      $('#revEnds').value = R.target.ends;
      $('#revPicks').value = R.target.picks;
    }
    $('#reverseModal').classList.remove('hidden');
    // 同步应用尺寸（离线/无 rAF 环境也能正确布局），再安排一帧确保最终尺寸
    resizeBoards();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resizeBoards);
  }

  /* ------------------------------- 初始化 ------------------------------- */
  function init() {
    if (!$('#btnReverse') || !$('#revCanvas')) return false;
    cvs = $('#revCanvas');
    ov = $('#revOverlay');
    ctx = cvs.getContext('2d');
    octx = ov.getContext('2d');
    R.target = Reverse.makeTarget(4, 4);
    syncDimsInputs();
    bind();
    // 测试钩子：读取/涂绘目标格、取当前结果（浏览器中无害，仅供离线自动化）
    window.__revAPI = {
      cell: (e, p) => R.target.grid[p][e],
      paint: (e, p, v) => { R.target.grid[p][e] = v; invalidateResults(); resizeBoards(); },
      result: () => R.result,
      selected: () => R.selected,
      explain: () => R.explain,
    };
    return true;
  }

  if (!init() && typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => init());
  }
})();
