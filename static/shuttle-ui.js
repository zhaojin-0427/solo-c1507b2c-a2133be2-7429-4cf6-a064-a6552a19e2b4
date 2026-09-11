/* =====================================================================
 * shuttle-ui.js — 多梭布边计划模块（原生 DOM，无外部依赖）
 *
 * 通过 window.__loom 与主应用通信（state / Engine / pushHistory / afterEdit）。
 * 所有修改统一走 mutate()：先压入撤销历史，再变更，最后级联刷新，
 * 因此模块内一切操作（含应用建议）都可被 Ctrl+Z 撤销。
 * ===================================================================== */
'use strict';

(function () {

  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const JOIN_NAMES = { wrap: '包绕', lock: '交锁', cut: '剪断重接' };
  const EDGE_NAME = { L: '左', R: '右' };

  const S = {
    open: false,
    suggest: null,     // { changes, skipped } 最近一次生成的建议
    dragPick: null,    // 正在拖动的纬
  };

  const loom = () => window.__loom;
  const draft = () => loom().state.draft;
  const sh = () => draft().shuttles;
  const Engine = () => loom().Engine;

  function toast(msg, ms) { if (window.toast) window.toast(msg, ms); }

  /** 统一修改入口：压历史 → 变更 → 级联（afterEdit 会回调 __shuttleRefresh 重绘表格） */
  function mutate(fn) {
    const L = loom();
    L.pushHistory();
    fn();
    L.afterEdit();
  }

  /* ------------------------------- 打开 / 关闭 ------------------------- */
  function openModal() {
    // 兜底：旧数据未经 normalize 时补一份默认多梭计划（不进历史）
    if (!draft().shuttles) {
      draft().shuttles = Engine().normalizeShuttles(null, draft().picks);
    }
    S.open = true;
    S.suggest = null;
    renderSuggestList();
    $('#shuttleModal').classList.remove('hidden');
    renderAll();
  }

  function closeModal() {
    S.open = false;
    $('#shuttleModal').classList.add('hidden');
  }

  function renderAll() {
    if (!S.open) return;
    renderConfig();
    renderTable();
    renderSummary();
  }

  /* ------------------------------- ① 梭子配置 -------------------------- */
  function renderConfig() {
    const d = draft(), s = sh();
    $('#shCount').value = s.count;
    $('#shParkLimit').value = s.parkLimit;

    const usage = new Array(s.count).fill(0);
    s.picks.forEach(a => { if (a) usage[a.s]++; });

    const box = $('#shConfigList');
    box.innerHTML = '';
    for (let k = 0; k < s.count; k++) {
      const row = document.createElement('div');
      row.className = 'sh-config-row';

      const label = document.createElement('span');
      label.className = 'sh-config-name';
      label.textContent = `梭${k + 1}`;

      const sw = document.createElement('span');
      sw.className = 'sh-swatch';
      const c = d.palette[s.colors[k]];
      sw.style.background = c ? c.hex : '#888';

      const sel = document.createElement('select');
      sel.className = 'sh-mini';
      sel.title = '纱色（色号）';
      d.palette.forEach((pc, i) => {
        const o = document.createElement('option');
        o.value = i;
        o.textContent = `${i + 1} ${pc.name}`;
        sel.appendChild(o);
      });
      sel.value = s.colors[k];
      sel.addEventListener('change', () => {
        const v = parseInt(sel.value, 10);
        mutate(() => { sh().colors[k] = v; });
        toast(`梭${k + 1} 纱色 → 色号 ${v + 1}`);
      });

      const homeBtn = document.createElement('button');
      homeBtn.className = 'btn tiny';
      homeBtn.textContent = `初始停${EDGE_NAME[s.home[k]]}`;
      homeBtn.title = '初始停放边（未织前梭子停在哪一侧）';
      homeBtn.addEventListener('click', () => {
        mutate(() => { sh().home[k] = sh().home[k] === 'L' ? 'R' : 'L'; });
      });

      const use = document.createElement('span');
      use.className = 'sh-usage';
      use.textContent = `${usage[k]} 纬`;

      row.append(label, sw, sel, homeBtn, use);
      box.appendChild(row);
    }

    // 批量工具里的梭子选项
    const rs = $('#shRangeShuttle');
    rs.innerHTML = '';
    for (let k = 0; k < s.count; k++) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = `梭${k + 1}`;
      rs.appendChild(o);
    }
    $('#shRangeFrom').max = d.picks;
    $('#shRangeTo').max = d.picks;
    if (!$('#shRangeTo').value) $('#shRangeTo').value = d.picks;
    $('#shCycleLen').max = d.picks;
  }

  /* ------------------------------- ④ 逐纬计划表 ------------------------ */
  function derivedEnter(k, p) {
    const sp = Engine().shuttlePath(draft());
    if (!sp) return sh().home[k];
    return p > 0 ? sp.parked[p - 1][k] : sp.home[k];
  }

  function renderTable() {
    const d = draft(), s = sh();
    const sp = Engine().shuttlePath(d);
    const tb = $('#shPickRows');
    tb.innerHTML = '';
    const frag = document.createDocumentFragment();

    for (let p = 0; p < d.picks; p++) {
      const a = s.picks[p];
      const locked = s.locked[p];
      const r = sp ? sp.rows[p] : null;

      const tr = document.createElement('tr');
      tr.dataset.pick = p;
      if (locked) tr.classList.add('sh-locked');

      // 问题标记
      const problems = [];
      if (r) {
        if (r.mismatch) problems.push('入梭边不一致');
        if (r.changed && !r.join) problems.push('未交接');
        if (r.floatLen > s.parkLimit && r.join !== 'cut') problems.push(`停放浮线${r.floatLen}`);
      } else if (sp && sp.active) {
        problems.push('未指定');
      }
      if (problems.length) tr.classList.add('sh-problem');

      // 拖动换序
      const tdDrag = document.createElement('td');
      tdDrag.className = 'drag-handle';
      tdDrag.textContent = '⠿';
      tdDrag.title = locked ? '已锁定，不参与换序' : '拖动到另一纬可交换梭次';
      if (!locked) tr.draggable = true;

      const tdNo = document.createElement('td');
      tdNo.textContent = p + 1;

      // 梭子
      const tdS = document.createElement('td');
      const selS = document.createElement('select');
      selS.className = 'sh-mini';
      const o0 = document.createElement('option');
      o0.value = ''; o0.textContent = '—';
      selS.appendChild(o0);
      for (let k = 0; k < s.count; k++) {
        const o = document.createElement('option');
        o.value = k; o.textContent = `梭${k + 1}`;
        selS.appendChild(o);
      }
      selS.value = a ? String(a.s) : '';
      selS.disabled = locked;
      selS.addEventListener('change', () => {
        const v = selS.value;
        mutate(() => {
          sh().picks[p] = v === '' ? null
            : { s: parseInt(v, 10), enter: derivedEnter(parseInt(v, 10), p), join: a ? a.join : null };
        });
      });
      tdS.appendChild(selS);

      // 入梭边
      const tdE = document.createElement('td');
      const btnE = document.createElement('button');
      btnE.className = 'btn tiny edge-toggle';
      btnE.textContent = a ? (a.enter === 'L' ? '左▶' : '◀右') : '·';
      btnE.title = '入梭边（点击切换）';
      btnE.disabled = locked || !a;
      btnE.addEventListener('click', () => {
        mutate(() => { sh().picks[p].enter = sh().picks[p].enter === 'L' ? 'R' : 'L'; });
      });
      tdE.appendChild(btnE);

      // 交接方式
      const tdJ = document.createElement('td');
      const selJ = document.createElement('select');
      selJ.className = 'sh-mini';
      [['', '无'], ['wrap', '包绕'], ['lock', '交锁'], ['cut', '剪断重接']].forEach(([v, name]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = name;
        selJ.appendChild(o);
      });
      selJ.value = a && a.join ? a.join : '';
      selJ.disabled = locked || !a;
      selJ.addEventListener('change', () => {
        const v = selJ.value || null;
        mutate(() => { sh().picks[p].join = v; });
      });
      tdJ.appendChild(selJ);

      // 锁定
      const tdL = document.createElement('td');
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = locked;
      chk.title = '锁定已织纬（批量操作与建议不再改动此纬）';
      chk.addEventListener('change', () => {
        mutate(() => { sh().locked[p] = chk.checked; });
      });
      tdL.appendChild(chk);

      // 路径状态
      const tdSt = document.createElement('td');
      tdSt.className = 'sh-status';
      let status = '';
      if (r) status = `织完停${EDGE_NAME[r.exit]}${r.changed ? ' · 换梭' : ''}`;
      if (problems.length) status = problems.join('；') + (status ? `（${status}）` : '');
      tdSt.textContent = status;

      tr.append(tdDrag, tdNo, tdS, tdE, tdJ, tdL, tdSt);
      frag.appendChild(tr);
    }
    tb.appendChild(frag);
  }

  function renderSummary() {
    const v = loom().state.analysis.validation;
    const s = sh();
    const shIssues = v.issues.filter(i => i.code.startsWith('shuttle-'));
    const errs = shIssues.filter(i => i.level === 'error').length;
    $('#shSummary').textContent = s.picks.some(Boolean)
      ? `布边校验：错误 ${errs} · 警告 ${shIssues.length - errs}（点击主界面“校验问题”可定位到纬与布边）`
      : '尚未指定任何纬的梭子：用左侧批量工具分配，或在图板左侧梭道上点击逐纬指定。';
  }

  /* ------------------------------- ② 批量工具 -------------------------- */
  function setCount() {
    const n = clamp(parseInt($('#shCount').value, 10) || 2, 2, 8);
    if (n === sh().count) return;
    mutate(() => {
      const d = draft();
      d.shuttles = Engine().normalizeShuttles({ ...sh(), count: n }, d.picks);
    });
    toast(`梭子数 → ${n} 把`);
  }

  function setParkLimit() {
    const v = clamp(parseInt($('#shParkLimit').value, 10) || 8, 1, 200);
    mutate(() => { sh().parkLimit = v; });
  }

  function rangeAssign() {
    const d = draft();
    const from = clamp(parseInt($('#shRangeFrom').value, 10) || 1, 1, d.picks);
    const to = clamp(parseInt($('#shRangeTo').value, 10) || from, 1, d.picks);
    const k = clamp(parseInt($('#shRangeShuttle').value, 10) || 0, 0, sh().count - 1);
    const enter0 = $('#shRangeEnter').value === 'R' ? 'R' : 'L';
    const join = $('#shRangeJoin').value || null;
    if (from > to) { toast('起始纬不能大于结束纬'); return; }
    let skipped = 0;
    mutate(() => {
      let enter = enter0, joinPending = join;
      for (let p = from - 1; p <= to - 1; p++) {
        if (sh().locked[p]) { skipped++; continue; }
        sh().picks[p] = { s: k, enter, join: joinPending };
        joinPending = null;                    // 交接只落在区间第一根未锁纬
        enter = enter === 'L' ? 'R' : 'L';     // 同梭连织入梭边自然交替
      }
    });
    toast(`已分配第 ${from}–${to} 纬 → 梭${k + 1}` + (skipped ? `（跳过 ${skipped} 锁定纬）` : ''));
  }

  /** 复制梭次循环：前 N 纬为模板，后续纬复制梭子与交接，入梭边按推演自动顺推 */
  function cycleCopy() {
    const d = draft();
    const L = clamp(parseInt($('#shCycleLen').value, 10) || 1, 1, d.picks);
    const template = sh().picks.slice(0, L);
    if (!template.some(Boolean)) { toast(`前 ${L} 纬还没有梭次可作模板`); return; }
    mutate(() => {
      const s = sh();
      const edges = s.home.slice();
      const sim = (a) => { if (a) edges[a.s] = a.enter === 'L' ? 'R' : 'L'; };
      for (let p = 0; p < d.picks; p++) {
        if (p < L || s.locked[p]) { sim(s.picks[p]); continue; }
        const src = s.picks[p % L];
        s.picks[p] = src ? { s: src.s, enter: edges[src.s], join: src.join } : null;
        sim(s.picks[p]);
      }
    });
    toast(`已按前 ${L} 纬循环复制（入梭边已顺推）`);
  }

  /** 入梭边自动顺边：按推演停放边重写所有未锁定纬的入梭边 */
  function alignEntries() {
    let n = 0;
    mutate(() => {
      const s = sh();
      const edges = s.home.slice();
      for (let p = 0; p < draft().picks; p++) {
        const a = s.picks[p];
        if (!a) continue;
        if (!s.locked[p] && a.enter !== edges[a.s]) { a.enter = edges[a.s]; n++; }
        edges[a.s] = a.enter === 'L' ? 'R' : 'L';
      }
    });
    toast(n ? `已顺边 ${n} 纬` : '入梭边已全部一致');
  }

  function clearUnlocked() {
    let n = 0;
    mutate(() => {
      const s = sh();
      for (let p = 0; p < draft().picks; p++) {
        if (!s.locked[p] && s.picks[p]) { s.picks[p] = null; n++; }
      }
    });
    toast(n ? `已清空 ${n} 纬的梭子（锁定纬保留）` : '没有可清空的纬');
  }

  function colorToWeft() {
    let n = 0;
    mutate(() => {
      const d = draft(), s = sh();
      for (let p = 0; p < d.picks; p++) {
        const a = s.picks[p];
        if (a && !s.locked[p]) { d.weftColor[p] = s.colors[a.s]; n++; }
      }
    });
    toast(n ? `已把 ${n} 纬的梭子纱色写入纬线带` : '没有可写入的未锁定纬');
  }

  function lockAll(lock) {
    mutate(() => {
      const s = sh();
      for (let p = 0; p < draft().picks; p++) s.locked[p] = lock;
    });
    toast(lock ? '已全部锁定（已织）' : '已全部解锁');
  }

  /* ------------------------------- 拖动换序 ---------------------------- */
  function bindDrag() {
    const tb = $('#shPickRows');
    tb.addEventListener('dragstart', (ev) => {
      const tr = ev.target.closest('tr');
      if (!tr) return;
      S.dragPick = parseInt(tr.dataset.pick, 10);
      ev.dataTransfer.effectAllowed = 'move';
    });
    tb.addEventListener('dragover', (ev) => {
      const tr = ev.target.closest('tr');
      if (!tr || S.dragPick === null) return;
      ev.preventDefault();
      tr.classList.add('drag-over');
    });
    tb.addEventListener('dragleave', (ev) => {
      const tr = ev.target.closest('tr');
      if (tr) tr.classList.remove('drag-over');
    });
    tb.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const tr = ev.target.closest('tr');
      if (!tr || S.dragPick === null) return;
      const a = S.dragPick, b = parseInt(tr.dataset.pick, 10);
      S.dragPick = null;
      if (a === b) return;
      const s = sh();
      if (s.locked[a] || s.locked[b]) { toast('锁定纬不参与换序'); renderTable(); return; }
      mutate(() => {
        const t = s.picks[a];
        s.picks[a] = s.picks[b];
        s.picks[b] = t;
      });
      toast(`已交换第 ${a + 1} 与第 ${b + 1} 纬的梭次`);
    });
    tb.addEventListener('dragend', () => { S.dragPick = null; });
  }

  /* ------------------------------- ③ 交接建议 -------------------------- */
  function preferJoin() {
    const r = document.querySelector('input[name="shPrefer"]:checked');
    return r ? r.value : 'wrap';
  }

  function genSuggest() {
    S.suggest = Engine().shuttleSuggest(draft(), preferJoin());
    renderSuggestList();
  }

  function renderSuggestList() {
    const box = $('#shSuggestList');
    box.innerHTML = '';
    const btn = $('#shApplySuggest');
    if (!S.suggest) {
      box.innerHTML = '<p class="hint">点击“生成建议”预览包绕 / 交锁 / 剪断重接与顺边修改。</p>';
      btn.disabled = true;
      return;
    }
    const { changes, skipped } = S.suggest;
    if (!changes.length && !skipped.length) {
      box.innerHTML = '<p class="hint">✓ 布边路径没有需要修改的问题。</p>';
      btn.disabled = true;
      return;
    }
    changes.forEach((c, i) => {
      const row = document.createElement('label');
      row.className = 'sh-sug-row';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = true;
      chk.dataset.idx = i;
      const parts = [];
      if (c.enter) parts.push(`入梭边→${EDGE_NAME[c.enter]}`);
      if (c.join) parts.push(`交接→${JOIN_NAMES[c.join]}`);
      const txt = document.createElement('span');
      txt.textContent = `第 ${c.pick + 1} 纬（梭${c.shuttle + 1}）：${parts.join('，')}　— ${c.reasons.join('；')}`;
      row.append(chk, txt);
      box.appendChild(row);
    });
    skipped.forEach(c => {
      const row = document.createElement('div');
      row.className = 'sh-sug-row sh-sug-skip';
      row.textContent = `第 ${c.pick + 1} 纬（梭${c.shuttle + 1}）：${c.reasons.join('；')}　— 已锁定，跳过`;
      box.appendChild(row);
    });
    btn.disabled = !changes.length;
  }

  function applySuggest() {
    if (!S.suggest) return;
    const checks = Array.from($('#shSuggestList').querySelectorAll('input[type="checkbox"]'));
    const picked = checks.filter(c => c.checked).map(c => parseInt(c.dataset.idx, 10));
    if (!picked.length) { toast('未勾选任何建议'); return; }
    let n = 0;
    mutate(() => {
      const s = sh();
      picked.forEach(i => {
        const c = S.suggest.changes[i];
        const a = s.picks[c.pick];
        if (!a || s.locked[c.pick]) return;   // 只调整未锁定纬
        if (c.enter) a.enter = c.enter;
        if (c.join) a.join = c.join;
        n++;
      });
    });
    S.suggest = null;
    renderSuggestList();
    toast(`已应用 ${n} 条建议（仅未锁定纬，可撤销）`);
  }

  /* ------------------------------- 事件绑定 ---------------------------- */
  function bind() {
    $('#btnShuttle').addEventListener('click', openModal);
    document.querySelectorAll('[data-close-sh]').forEach(b =>
      b.addEventListener('click', closeModal));
    $('#shuttleModal').addEventListener('click', (e) => {
      if (e.target.id === 'shuttleModal') closeModal();
    });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && S.open) closeModal();
    });

    $('#shCount').addEventListener('change', setCount);
    $('#shParkLimit').addEventListener('change', setParkLimit);
    $('#shRangeApply').addEventListener('click', rangeAssign);
    $('#shCycleApply').addEventListener('click', cycleCopy);
    $('#shAlign').addEventListener('click', alignEntries);
    $('#shClearAll').addEventListener('click', clearUnlocked);
    $('#shColorToWeft').addEventListener('click', colorToWeft);
    $('#shLockAll').addEventListener('click', () => lockAll(true));
    $('#shUnlockAll').addEventListener('click', () => lockAll(false));
    $('#shSuggest').addEventListener('click', genSuggest);
    $('#shApplySuggest').addEventListener('click', applySuggest);
    bindDrag();
  }

  /* ------------------------------- 初始化 ------------------------------ */
  function init() {
    if (!$('#btnShuttle') || !$('#shuttleModal')) return false;
    bind();
    // 主应用 afterEdit / afterStructural 回调：模态打开时同步重绘
    window.__shuttleRefresh = renderAll;
    // 测试钩子
    window.__shuttleAPI = {
      open: openModal,
      close: closeModal,
      isOpen: () => S.open,
      suggest: () => S.suggest,
      genSuggest, applySuggest, rangeAssign, cycleCopy, alignEntries,
    };
    return true;
  }

  if (!init() && typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => init());
  }
})();
