/* =====================================================================
 * loom-ui.js — 上机工艺单模块（原生 DOM，无外部依赖）
 *
 * 从当前草稿冻结工艺单：工艺参数 → 推算（整经根数 / 筘幅 / 经长 / 纬数 /
 * 分色用纱量）→ 穿筘方案搜索 → 生成连续区段步骤。工艺单与确认进度经
 * /api/sheets* 持久化到 SQLite；草稿或参数变化不改写原单，可冻结新版，
 * 原单中与新单不符的步骤标记失效。
 * ===================================================================== */
'use strict';

(function () {

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const LC = () => window.LoomCore;
  const Engine = () => window.__loom.Engine;
  const deepClone = (o) => JSON.parse(JSON.stringify(o));
  const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const fmt2 = (v) => String(Math.round(v * 100) / 100);
  const fmtG = (g) => g >= 1000 ? (g / 1000).toFixed(2) + ' kg' : fmt1(g) + ' g';

  const KIND_NAMES = { warp: '整经', thread: '穿综', dent: '穿筘' };
  const EXPAND_CAP = 400;   // 展开到每根经线时的渲染上限

  const S = {
    open: false,
    list: [],
    current: null,        // 打开的工艺单（含 steps / snapshot / params / derived / reedPlan）
    preview: null,        // 计算预览 {snapshot, params, plan, reedSearch, reedSel, fingerprint}
    expanded: new Set(),  // 展开的步骤 id
  };

  function toast(msg, ms) { if (window.toast) window.toast(msg, ms); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function req(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    return res.json();
  }

  /* ============================== 打开 / 关闭 ========================== */
  function openModal() {
    S.open = true;
    $('#loomModal').classList.remove('hidden');
    buildYarnGrid();
    refreshList().then(() => {
      if (!S.current && S.list.length) openSheet(S.list[0].id).catch(() => {});
      else renderAll();
    });
  }
  function closeModal() {
    S.open = false;
    $('#loomModal').classList.add('hidden');
  }

  /* ============================== 参数表单 ============================= */
  function buildYarnGrid() {
    const d = window.__loom.state.draft;
    const grid = $('#loYarnGrid');
    grid.innerHTML = '';
    d.palette.forEach((c, i) => {
      const lab = document.createElement('label');
      lab.className = 'lo-yarn';
      lab.innerHTML = `<i style="background:${c.hex}"></i><span>${i + 1} ${escapeHtml(c.name)}</span>`;
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = '0.001'; inp.max = '10'; inp.step = '0.001';
      inp.value = '0.05';
      inp.dataset.color = i;
      inp.title = `色号 ${i + 1} ${c.name} 的单位长度重量（g/m）`;
      inp.addEventListener('input', scheduleFpHint);
      lab.appendChild(inp);
      grid.appendChild(lab);
    });
  }

  function readYarnGpm() {
    const out = [];
    $$('#loYarnGrid input').forEach(inp => { out[Number(inp.dataset.color)] = parseFloat(inp.value); });
    return out;
  }

  function readFormParams() {
    return LC().normalizeParams({
      finishWidth: parseFloat($('#loFinishW').value),
      finishLength: parseFloat($('#loFinishL').value),
      warpShrink: parseFloat($('#loWarpShrink').value),
      weftShrink: parseFloat($('#loWeftShrink').value),
      warpDensity: parseFloat($('#loWarpDensity').value),
      weftDensity: parseFloat($('#loWeftDensity').value),
      reedDents: parseFloat($('#loReedDents').value),
      wasteFront: parseFloat($('#loWasteFront').value),
      wasteBack: parseFloat($('#loWasteBack').value),
      yarnGpm: readYarnGpm(),
    });
  }

  function fillForm(params) {
    const q = LC().normalizeParams(params);
    $('#loFinishW').value = q.finishWidth;
    $('#loFinishL').value = q.finishLength;
    $('#loWarpShrink').value = q.warpShrink;
    $('#loWeftShrink').value = q.weftShrink;
    $('#loWarpDensity').value = q.warpDensity;
    $('#loWeftDensity').value = q.weftDensity;
    $('#loReedDents').value = q.reedDents;
    $('#loWasteFront').value = q.wasteFront;
    $('#loWasteBack').value = q.wasteBack;
    const gpm = LC().normalizeYarnGpm(q.yarnGpm, $$('#loYarnGrid input').length);
    $$('#loYarnGrid input').forEach(inp => { inp.value = gpm[Number(inp.dataset.color)]; });
  }

  /* ============================== 工艺单列表 ========================== */
  async function refreshList() {
    let rows;
    try { rows = await req('GET', '/api/sheets'); }
    catch (e) {
      $('#loSheetList').innerHTML = '<p class="hint">无法读取工艺单：' + escapeHtml(e.message) + '</p>';
      S.list = [];
      return;
    }
    S.list = rows;
    renderList();
  }

  function renderList() {
    const box = $('#loSheetList');
    box.innerHTML = '';
    $('#loListHint').textContent = S.list.length ? `共 ${S.list.length} 单` : '';
    if (!S.list.length) {
      box.innerHTML = '<p class="hint">还没有工艺单。填写下方参数并“计算预览”后冻结建立。</p>';
      return;
    }
    S.list.forEach(sh => {
      const row = document.createElement('div');
      row.className = 'lo-sheet' + (S.current && S.current.id === sh.id ? ' sel' : '');
      const pct = sh.stepCount ? Math.round(sh.doneCount / sh.stepCount * 100) : 0;
      row.innerHTML =
        `<div class="lo-sheet-name">${escapeHtml(sh.name)}
           <span class="lo-tag">v${sh.version}</span>
           ${sh.staleCount ? `<span class="lo-stale-tag">失效 ${sh.staleCount}</span>` : ''}
         </div>
         <div class="lo-sheet-meta">${escapeHtml(sh.draftName)} · ${String(sh.updatedAt || '').replace('T', ' ').slice(0, 16)}</div>
         <div class="lo-sheet-prog">进度 ${sh.doneCount}/${sh.stepCount} 步（${pct}%）
           <div class="lo-prog-bar"><div class="lo-prog-fill" style="width:${pct}%"></div></div>
         </div>`;
      row.addEventListener('click', () => openSheet(sh.id));
      box.appendChild(row);
    });
  }

  /* ============================== 计算预览 ============================ */
  function calcPreview() {
    const cur = window.__loom.state;
    const snapshot = deepClone(cur.draft);
    const params = readFormParams();
    const plan = LC().derivePlan(Engine(), snapshot, params);
    const target = plan.loomDensity / params.reedDents;
    const reedSearch = LC().searchReedPlans(target);
    S.preview = {
      snapshot, params, plan, reedSearch, reedSel: 0,
      fingerprint: LC().fingerprint(snapshot, params),
    };
    renderMiddle();
    const mode = S.current ? `新版预览（基于当前草稿，v${S.current.version + 1}）` : '预览（未冻结）';
    toast(`已计算${mode}：整经 ${plan.totalEnds} 根 · 筘幅 ${fmt1(plan.reedWidthCm)} cm`);
  }

  function previewSteps() {
    const pv = S.preview;
    if (!pv) return [];
    const seq = pv.reedSearch.plans[pv.reedSel].seq;
    return LC().buildSteps(pv.snapshot, pv.plan, seq);
  }

  /* ============================== 中栏渲染 ============================ */
  function renderMiddle() {
    const pv = S.preview, cur = S.current;
    $('#loMidHint').classList.toggle('hidden', !!(pv || cur));
    $('#loDerived').classList.toggle('hidden', !(pv || cur));
    $('#loUsage').classList.toggle('hidden', !(pv || cur));
    $('#loReedBox').classList.toggle('hidden', !(pv || cur));
    $('#loFreezeBar').classList.toggle('hidden', !pv);
    if (pv) {
      renderDerived(pv.plan, pv.params, true);
      renderUsage(pv.plan);
      renderReedCandidates();
      $('#loFreeze').textContent = cur
        ? `冻结为新版 v${cur.version + 1}（原单 v${cur.version} 保留）`
        : '冻结并建立工艺单';
    } else if (cur) {
      renderDerived(cur.derived, cur.params, false);
      renderUsage(cur.derived);
      renderReedFrozen(cur);
    }
  }

  function renderDerived(plan, params, isPreview) {
    const el = $('#loDerived');
    const adj = plan.endsAdjusted !== 0
      ? `原算 ${fmt2(plan.rawEnds)} 根，按循环 ${plan.repeatWarp} 根取整`
      : `恰为循环 ${plan.repeatWarp} 根的整数倍`;
    el.innerHTML =
      `<div class="lo-kv"><span>整经根数${isPreview ? '（预览）' : ''}</span><b>${plan.totalEnds} 根</b><small>${adj}</small></div>
       <div class="lo-kv"><span>上机筘幅</span><b>${fmt1(plan.reedWidthCm)} cm</b><small>上机经密 ${fmt2(plan.loomDensity)} 根/cm（纬缩 ${params.weftShrink}%）</small></div>
       <div class="lo-kv"><span>经纱长度</span><b>${fmt2(plan.warpLengthM)} m</b><small>成品 ${plan.params ? plan.params.finishLength : params.finishLength} cm 缩率还原 + 前后废纱</small></div>
       <div class="lo-kv"><span>预计纬数</span><b>${plan.estPicks} 纬</b><small>成品长 × 目标纬密 ${params.weftDensity} 根/cm</small></div>`;
  }

  function usageRows(plan) {
    const map = new Map();
    (plan.warpColors || []).forEach(w => map.set(w.color, { w }));
    (plan.weftColors || []).forEach(f => {
      const o = map.get(f.color) || {};
      o.f = f;
      map.set(f.color, o);
    });
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }

  function renderUsage(plan) {
    const el = $('#loUsage');
    let html = `<div class="lo-sub2">分色用纱量</div>
      <table><thead><tr>
        <th>色号</th><th>g/m</th><th>经根数</th><th>经用量</th><th>纬数</th><th>纬用量</th><th>合计</th>
      </tr></thead><tbody>`;
    usageRows(plan).forEach(([c, { w, f }]) => {
      const g = (w ? w.grams : 0) + (f ? f.grams : 0);
      const name = (w && w.name) || (f && f.name) || `色号${c + 1}`;
      const hex = (w && w.hex) || (f && f.hex) || '#888';
      const gpm = plan.gpm && plan.gpm[c] != null ? plan.gpm[c] : 0.05;
      html += `<tr>
        <td class="lo-l"><span class="lo-chip" style="background:${hex}"></span>${c + 1} ${escapeHtml(name)}</td>
        <td>${gpm}</td>
        <td>${w ? w.ends : 0}</td><td>${fmtG(w ? w.grams : 0)}</td>
        <td>${f ? f.picks : 0}</td><td>${fmtG(f ? f.grams : 0)}</td>
        <td>${fmtG(g)}</td></tr>`;
    });
    html += `<tr class="lo-total"><td class="lo-l">合计</td><td></td>
      <td>${plan.totalEnds}</td><td>${fmtG(plan.totalWarpGrams)}</td>
      <td>${plan.estPicks}</td><td>${fmtG(plan.totalWeftGrams)}</td>
      <td>${fmtG(plan.totalGrams)}</td></tr>`;
    el.innerHTML = html + '</tbody></table>';
  }

  function renderReedCandidates() {
    const pv = S.preview;
    const el = $('#loReedBox');
    const rs = pv.reedSearch;
    const note = LC().reedNote(rs, pv.params.reedDents);
    let html = `<div class="lo-sub2">穿筘方案（目标平均每筘 ${fmt2(rs.target)} 根 = 上机经密 ${fmt2(pv.plan.loomDensity)} ÷ 筘 ${pv.params.reedDents} 筘/cm）</div>`;
    rs.plans.forEach((cand, i) => {
      const selCls = i === pv.reedSel ? ' sel' : '';
      const errTxt = cand.err < 1e-9 ? '精确匹配' : `误差 ${fmt2(cand.err)} 根/筘`;
      html += `<div class="lo-reed-cand${selCls}" data-idx="${i}">
        <span class="lo-reed-seq">[${cand.seq.join(' ')}]</span>
        <span class="lo-reed-meta">${cand.dents} 筘循环 · 平均 ${fmt2(cand.avg)} 根/筘 · ${errTxt} · 均匀度 ${fmt2(cand.disc)}</span>
        ${i === 0 ? '<span class="lo-tag lo-reed-best">推荐</span>' : ''}
      </div>`;
    });
    html += note
      ? `<div class="lo-note">⚠ ${escapeHtml(note)}</div>`
      : `<div class="lo-note ok">✓ 可精确匹配目标上机经密。</div>`;
    el.innerHTML = html;
    $$('#loReedBox .lo-reed-cand').forEach(row => {
      row.addEventListener('click', () => {
        pv.reedSel = Number(row.dataset.idx);
        renderReedCandidates();
      });
    });
  }

  function renderReedFrozen(sheet) {
    const el = $('#loReedBox');
    const rp = sheet.reedPlan || {};
    const seqTxt = (rp.seq || []).join(' ');
    let html = `<div class="lo-sub2">穿筘方案（已冻结）</div>
      <div class="lo-reed-cand sel">
        <span class="lo-reed-seq">[${seqTxt}]</span>
        <span class="lo-reed-meta">平均 ${fmt2(rp.avg || 0)} 根/筘 · 共 ${rp.dents != null ? rp.dents : '—'} 筘${rp.err ? ` · 误差 ${fmt2(rp.err)} 根/筘` : ' · 精确匹配'}</span>
      </div>`;
    if (rp.note) html += `<div class="lo-note">⚠ ${escapeHtml(rp.note)}</div>`;
    el.innerHTML = html;
  }

  /* ============================== 冻结（新建 / 新版） ================== */
  async function freeze() {
    const pv = S.preview;
    if (!pv) { toast('请先“计算预览”'); return; }
    const steps = previewSteps();
    const cand = pv.reedSearch.plans[pv.reedSel];
    const dentStep = steps.find(s => s.kind === 'dent');
    const name = ($('#loSheetName').value || '').trim() ||
      ($('#draftName').value || '未命名草稿') + ' 工艺单';
    const body = {
      name,
      draftId: window.__loom.state.savedId,
      draftName: $('#draftName').value || '未保存草稿',
      snapshot: pv.snapshot,
      params: pv.params,
      derived: pv.plan,
      reedPlan: {
        seq: cand.seq, dents: dentStep ? dentStep.detail.dents : null,
        avg: cand.avg, err: cand.err, disc: cand.disc,
        target: pv.reedSearch.target, exact: pv.reedSearch.exact,
        note: LC().reedNote(pv.reedSearch, pv.params.reedDents),
      },
      fingerprint: pv.fingerprint,
      steps,
    };
    try {
      if (S.current) {
        const r = await req('POST', `/api/sheets/${S.current.id}/copy`, body);
        toast(`已冻结为新版 v${r.sheet.version}；原单 ${r.staleCount} 步失效（原单保留可查）`, 2600);
        S.preview = null;
        await refreshList();
        await openSheet(r.sheet.id);
      } else {
        const r = await req('POST', '/api/sheets', body);
        toast(`工艺单「${name}」已冻结建立（#${r.id}）`);
        S.preview = null;
        await refreshList();
        await openSheet(r.id);
      }
    } catch (e) {
      toast('冻结失败：' + e.message, 3000);
    }
  }

  /* ============================== 打开工艺单 ========================== */
  async function openSheet(id) {
    let sheet;
    try { sheet = await req('GET', `/api/sheets/${id}`); }
    catch (e) { toast('读取工艺单失败：' + e.message, 3000); return; }
    S.current = sheet;
    S.preview = null;
    S.expanded.clear();
    buildYarnGrid();
    fillForm(sheet.params);
    $('#loSheetName').value = `${sheet.name} 新版`;
    renderAll();
  }

  function renderAll() {
    renderList();
    renderMiddle();
    renderSteps();
    updateFpHint();
    const has = !!S.current;
    $('#loPrint').disabled = !has;
    $('#loDelete').disabled = !has;
    $('#loFormMode').classList.toggle('hidden', !has);
  }

  /** 指纹对比：当前草稿 + 表单参数 vs 已冻结工艺单 */
  function currentFingerprint() {
    const cur = window.__loom.state;
    return LC().fingerprint(deepClone(cur.draft), readFormParams());
  }

  function updateFpHint() {
    const el = $('#loFpHint');
    if (!S.current) { el.textContent = ''; return; }
    let same = false;
    try { same = currentFingerprint() === S.current.fingerprint; } catch (e) { same = false; }
    el.textContent = same
      ? '当前草稿与参数和本单一致。'
      : '⚠ 当前草稿或参数与本单不符——原单不会被改写；修改参数后“计算预览”可冻结为新版。';
  }

  let fpTimer = null;
  function scheduleFpHint() {
    clearTimeout(fpTimer);
    fpTimer = setTimeout(updateFpHint, 250);
  }

  /* ============================== 操作步骤 ============================ */
  function renderSteps() {
    const box = $('#loStepList');
    box.innerHTML = '';
    const cur = S.current;
    // 失效提示条
    const staleBar = $('#loStaleBar');
    if (cur && cur.staleCount > 0) {
      const newer = S.list.filter(s => s.parentId === cur.id)
        .sort((a, b) => b.version - a.version)[0];
      staleBar.classList.remove('hidden');
      staleBar.innerHTML = `⚠ 本单有 <b>${cur.staleCount}</b> 步已失效（草稿或参数已出新版，原单不改写）。` +
        (newer ? `<br>新版：<a href="#" id="loOpenNewer">v${newer.version}「${escapeHtml(newer.name)}」</a>` : '');
      const link = $('#loOpenNewer');
      if (link && newer) link.addEventListener('click', (ev) => { ev.preventDefault(); openSheet(newer.id); });
    } else {
      staleBar.classList.add('hidden');
      staleBar.innerHTML = '';
    }

    if (!cur) {
      box.innerHTML = '<p class="hint">打开工艺单后在此逐项确认；勾选步骤可在主图板定位对应经线。</p>';
      return;
    }
    const steps = cur.steps || [];
    steps.forEach((st, i) => {
      const canDone = steps.slice(0, i).every(s => s.done);
      const canUndo = steps.slice(i + 1).every(s => !s.done);
      const row = document.createElement('div');
      row.className = 'lo-step' + (st.done ? ' done' : '') + (st.stale ? ' stale' : '');

      const head = document.createElement('div');
      head.className = 'lo-step-head';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!st.done;
      cb.disabled = st.done ? !canUndo : (!canDone || st.stale);
      cb.title = st.stale && !st.done ? '该步骤已失效，请改用新版工艺单'
        : st.done ? (canUndo ? '撤回该步骤' : '只能倒序撤回：请先撤回后面的步骤')
        : (canDone ? '确认该步骤' : '请按顺序确认：前面还有未完成的步骤');
      cb.addEventListener('change', () => toggleStep(st, cb.checked, cb));

      const no = document.createElement('span');
      no.className = 'lo-step-no';
      no.textContent = `${i + 1}.`;

      const kind = document.createElement('span');
      kind.className = `lo-step-kind ${st.kind}`;
      kind.textContent = KIND_NAMES[st.kind] || st.kind;

      const label = document.createElement('div');
      label.className = 'lo-step-label';
      label.textContent = st.label;
      const meta = document.createElement('div');
      meta.className = 'lo-step-meta';
      const bits = [];
      if (st.done && st.doneAt) bits.push(`确认于 ${String(st.doneAt).replace('T', ' ')}`);
      if (st.stale) bits.push('已失效（与新版不符）');
      meta.textContent = bits.join(' · ');
      label.appendChild(meta);

      const acts = document.createElement('div');
      acts.className = 'lo-step-acts';
      const btnExp = document.createElement('button');
      btnExp.className = 'btn tiny';
      btnExp.textContent = S.expanded.has(st.id) ? '收起' : '展开';
      btnExp.title = '展开到每根经线';
      btnExp.addEventListener('click', () => {
        if (S.expanded.has(st.id)) S.expanded.delete(st.id);
        else S.expanded.add(st.id);
        renderSteps();
      });
      const btnLoc = document.createElement('button');
      btnLoc.className = 'btn tiny';
      btnLoc.textContent = '定位';
      btnLoc.title = '在主图板高亮对应经线';
      btnLoc.addEventListener('click', () => locateStep(st));
      acts.append(btnExp, btnLoc);
      if (st.stale) {
        const tag = document.createElement('span');
        tag.className = 'lo-stale-tag';
        tag.textContent = '失效';
        acts.appendChild(tag);
      }

      head.append(cb, no, kind, label, acts);
      row.appendChild(head);

      if (S.expanded.has(st.id)) {
        const exp = document.createElement('div');
        exp.className = 'lo-expand';
        exp.innerHTML = expandHtml(st);
        row.appendChild(exp);
      }
      box.appendChild(row);
    });
  }

  /** 展开到每根经线（穿筘展开到每筘） */
  function expandHtml(st) {
    const d = st.detail || {};
    const palette = (S.current && S.current.snapshot && S.current.snapshot.palette) || [];
    let rows = '';
    let total = 0;
    if (st.kind === 'warp') {
      total = d.to - d.from + 1;
      const pal = palette[d.color] || {};
      const n = Math.min(total, EXPAND_CAP);
      for (let e = 0; e < n; e++) {
        rows += `<tr><td>第 ${d.from + e} 根</td><td>色号${d.color + 1} ${escapeHtml(pal.name || '')}</td></tr>`;
      }
    } else if (st.kind === 'thread') {
      const cyc = d.cycle || [];
      total = d.to - d.from + 1;
      const n = Math.min(total, EXPAND_CAP);
      for (let e = 0; e < n; e++) {
        const s = cyc.length ? cyc[e % cyc.length] : 0;
        rows += `<tr><td>第 ${d.from + e} 根</td><td>综框 ${s + 1}</td></tr>`;
      }
    } else if (st.kind === 'dent') {
      const walk = LC().dentWalk(d.to - d.from + 1, d.seq || [1]);
      total = walk.length;
      const n = Math.min(total, EXPAND_CAP);
      for (let i = 0; i < n; i++) {
        const w = walk[i];
        rows += `<tr><td>第 ${w.dent} 筘</td><td>第 ${w.from}–${w.to} 根（${w.take} 根${w.full ? '' : '，末筘'}）</td></tr>`;
      }
    }
    const more = total > EXPAND_CAP ? `<tr><td colspan="2">…共 ${total} ${st.kind === 'dent' ? '筘' : '根'}，仅显示前 ${EXPAND_CAP} 行</td></tr>` : '';
    return `<table>${rows}${more}</table>`;
  }

  async function toggleStep(step, wantDone, cbEl) {
    const cur = S.current;
    if (!cur) return;
    try {
      const updated = await req('POST', `/api/sheets/${cur.id}/steps/${step.id}/${wantDone ? 'done' : 'undo'}`);
      const i = cur.steps.findIndex(s => s.id === step.id);
      if (i >= 0) cur.steps[i] = updated;
      cur.doneCount = cur.steps.filter(s => s.done).length;
      renderSteps();
      refreshList();
    } catch (e) {
      cbEl.checked = !wantDone;
      toast(e.message || '操作失败', 2600);
    }
  }

  /** 在主图板定位步骤对应经线（映射到当前草稿的经向循环位置） */
  function locateStep(st) {
    const A = window.__loom.state.analysis;
    const rw = Math.max(1, (A && A.rep && A.rep.warp) || 1);
    const from = st.detail.from, to = st.detail.to;
    const len = to - from + 1;
    let c, c1;
    if (len >= rw) { c = 0; c1 = rw - 1; }
    else {
      const s0 = (from - 1) % rw;
      if (s0 + len <= rw) { c = s0; c1 = s0 + len - 1; }
      else { c = 0; c1 = rw - 1; }   // 跨循环边界：整循环高亮
    }
    S.open = false;   // locateCell 会隐藏所有模态
    window.locateCell({ grid: 'threading', r: -1, c, c1 });
    toast(`已定位：第 ${from}–${to} 根（循环内第 ${c + 1}–${c1 + 1} 根）`);
  }

  /* ============================== 删除 ================================ */
  async function deleteSheet() {
    const cur = S.current;
    if (!cur) return;
    if (!confirm(`确定删除工艺单「${cur.name}」（v${cur.version}）？进度将一并删除。`)) return;
    try {
      await req('DELETE', `/api/sheets/${cur.id}`);
      S.current = null;
      S.preview = null;
      await refreshList();
      renderAll();
      toast('工艺单已删除');
    } catch (e) { toast('删除失败：' + e.message, 3000); }
  }

  /* ============================== 打印 ================================ */
  function doPrint() {
    const cur = S.current;
    if (!cur) { toast('请先打开工艺单'); return; }
    const p = LC().normalizeParams(cur.params);
    const d = cur.derived;
    $('#loPrintTitle').textContent = `${cur.name}（v${cur.version}）— 上机工艺单`;
    $('#loPrintMeta').innerHTML =
      `来源草稿：${escapeHtml(cur.draftName)}　冻结时间：${String(cur.createdAt || '').replace('T', ' ')}<br>` +
      `成品 ${fmt1(p.finishWidth)} × ${fmt1(p.finishLength)} cm　经缩 ${p.warpShrink}%　纬缩 ${p.weftShrink}%　` +
      `目标经密 ${p.warpDensity} 根/cm　目标纬密 ${p.weftDensity} 根/cm　筘 ${p.reedDents} 筘/cm<br>` +
      `整经根数 <b>${d.totalEnds}</b> 根　上机筘幅 <b>${fmt1(d.reedWidthCm)}</b> cm　` +
      `经纱长度 <b>${fmt2(d.warpLengthM)}</b> m（含前废纱 ${p.wasteFront} cm、后废纱 ${p.wasteBack} cm）　` +
      `预计纬数 <b>${d.estPicks}</b> 纬<br>` +
      `打印时间：${new Date().toLocaleString()}　进度：${cur.doneCount}/${cur.stepCount} 步`;

    // 分色用纱量
    let usage = `<table class="lo-print-table"><thead><tr>
      <th>色号</th><th>名称</th><th>g/m</th><th>经根数</th><th>经用量</th><th>纬数</th><th>纬用量</th><th>合计</th>
      </tr></thead><tbody>`;
    usageRows(d).forEach(([c, { w, f }]) => {
      const g = (w ? w.grams : 0) + (f ? f.grams : 0);
      const gpm = d.gpm && d.gpm[c] != null ? d.gpm[c] : 0.05;
      usage += `<tr><td>${c + 1}</td><td class="lo-l">${escapeHtml((w && w.name) || (f && f.name) || '')}</td><td>${gpm}</td>` +
        `<td>${w ? w.ends : 0}</td><td>${fmtG(w ? w.grams : 0)}</td>` +
        `<td>${f ? f.picks : 0}</td><td>${fmtG(f ? f.grams : 0)}</td><td>${fmtG(g)}</td></tr>`;
    });
    usage += `<tr><td colspan="3"><b>合计</b></td><td><b>${d.totalEnds}</b></td><td><b>${fmtG(d.totalWarpGrams)}</b></td>` +
      `<td><b>${d.estPicks}</b></td><td><b>${fmtG(d.totalWeftGrams)}</b></td><td><b>${fmtG(d.totalGrams)}</b></td></tr>`;
    $('#loPrintUsage').innerHTML = usage + '</tbody></table>';

    // 穿筘方案 + 操作顺序
    const rp = cur.reedPlan || {};
    let stepsHtml = `<div>穿筘方案：每筘 [${(rp.seq || []).join(' ')}] 循环 · 平均 ${fmt2(rp.avg || 0)} 根/筘` +
      (rp.dents != null ? ` · 共 ${rp.dents} 筘` : '') + (rp.note ? `<br>⚠ ${escapeHtml(rp.note)}` : '') + '</div>';
    stepsHtml += '<div class="lo-print-steps">';
    (cur.steps || []).forEach((st, i) => {
      const mark = st.done ? '☑' : '☐';
      const cls = st.stale ? ' class="stale"' : '';
      stepsHtml += `<div${cls}>${mark} ${i + 1}. ${escapeHtml(st.label)}${st.stale ? '（已失效）' : ''}</div>`;
    });
    $('#loPrintSteps').innerHTML = stepsHtml + '</div>';

    document.body.classList.add('lo-printing');
    setTimeout(() => {
      window.print();
      setTimeout(() => document.body.classList.remove('lo-printing'), 600);
    }, 120);
  }

  /* ============================== 事件绑定 ============================ */
  function bind() {
    $('#btnLoom').addEventListener('click', openModal);
    $$('[data-close-lo]').forEach(b => b.addEventListener('click', closeModal));
    $('#loomModal').addEventListener('click', (e) => { if (e.target.id === 'loomModal') closeModal(); });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && S.open) closeModal();
    });

    $('#loNewSheet').addEventListener('click', () => {
      S.current = null;
      S.preview = null;
      S.expanded.clear();
      $('#loSheetName').value = ($('#draftName').value || '未命名草稿') + ' 工艺单';
      renderAll();
      $('#loSheetName').focus();
    });
    $('#loCalc').addEventListener('click', calcPreview);
    $('#loFreeze').addEventListener('click', freeze);
    $('#loDelete').addEventListener('click', deleteSheet);
    $('#loPrint').addEventListener('click', doPrint);
    ['loFinishW', 'loFinishL', 'loWarpShrink', 'loWeftShrink', 'loWarpDensity',
     'loWeftDensity', 'loReedDents', 'loWasteFront', 'loWasteBack']
      .forEach(id => $('#' + id).addEventListener('input', scheduleFpHint));
  }

  /* ============================== 初始化 / 测试钩子 =================== */
  function init() {
    if (!$('#btnLoom') || !$('#loomModal')) return false;
    bind();
    window.__loomSheetAPI = {
      open: openModal, close: closeModal, isOpen: () => S.open,
      state: S,
      refreshList, openSheet, calcPreview, freeze, deleteSheet,
      toggleStep, locateStep, doPrint, readFormParams, fillForm,
      previewSteps,
    };
    return true;
  }

  if (!init() && typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => init());
  }
})();
