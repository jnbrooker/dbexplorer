(function () {
  'use strict';

  const { qi, affinity, OPERATORS, MEASURES, availableColumns, availableLinks, build } = window.DBXQuery;
  const PAGE_SIZE = 100;
  const SQL_PREVIEW_ROWS = 500;
  const $ = (id) => document.getElementById(id);

  // ---------- tiny DOM helper ----------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k in el && k !== 'list') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    }
    return el;
  }
  const fmt = (n) => Number(n).toLocaleString();
  const fmtBytes = (n) => {
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${i ? n.toFixed(1) : n} ${units[i]}`;
  };

  // ---------- app state ----------
  let db = null; // { id, path, name, size }
  let schema = null;
  let current = null; // selected table name
  let mode = 'explore';
  let page = 0;
  let sqlShown = false;
  let samplePath = null;
  const tableStates = new Map();
  const S = () => tableStates.get(current);

  // ---------- server ----------
  class CancelledError extends Error {}

  async function api(path, body) {
    const res = await fetch('api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-DBX': '1', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* not JSON */ }
    if (res.status === 409 && data.cancelled) throw new CancelledError('cancelled');
    if (!res.ok) throw new Error(data.error || `The server said: ${res.status} ${res.statusText}`);
    return data;
  }

  // Each `key` has its own connection on the server; a new query with the same
  // key interrupts the previous one (e.g. the user changed a filter mid-count).
  function query(sql, params, key, limit) {
    return api('query', { id: db.id, sql, params: params || [], key, limit: limit || PAGE_SIZE });
  }

  function schemaFrom(tables) {
    const out = {};
    for (const t of tables) {
      out[t.name] = {
        name: t.name,
        type: t.type,
        columns: t.columns.map((c) => ({ ...c, affinity: affinity(c.type) })),
        rawFks: t.fks,
        fks: [],
        rowCount: null,
        estimate: t.estimate,
      };
    }
    // Resolve foreign keys now that every table is known (names are case-insensitive in SQLite).
    const byLower = new Map(Object.keys(out).map((n) => [n.toLowerCase(), n]));
    for (const t of Object.values(out)) {
      const groups = new Map();
      for (const fk of t.rawFks) {
        if (!groups.has(fk.id)) groups.set(fk.id, { parent: fk.table, pairs: [] });
        groups.get(fk.id).pairs.push([fk.from, fk.to]);
      }
      for (const [id, g] of groups) {
        const parent = byLower.get(String(g.parent).toLowerCase());
        if (!parent) continue;
        const pkCols = out[parent].columns.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
        const pairs = g.pairs.map(([from, to], i) => [from, to == null ? pkCols[i] : to]);
        if (pairs.some(([, to]) => to == null)) continue;
        t.fks.push({ id, table: parent, pairs });
      }
      delete t.rawFks;
    }
    return { tables: out };
  }

  function newState(table) {
    return {
      table,
      joins: [],
      nextAlias: 1,
      columns: schema.tables[table].columns.map((c) => ({ key: 't0.' + c.name, visible: true })),
      filters: [],
      match: 'all',
      sort: null,
      summary: { on: false, groupBy: [], measures: [{ fn: 'count', key: null }] },
    };
  }

  // ---------- opening ----------
  const canOpenByPath = location.protocol === 'http:' || location.protocol === 'https:';

  async function openPath(path, keepState) {
    showOpenError(null);
    const btn = $('path-form').querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Opening…';
    try {
      const d = await api('open', { path });
      db = { id: d.id, path: d.path, name: d.name, size: d.size };
      schema = schemaFrom(d.tables);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Open';
    }
    if (!keepState) {
      tableStates.clear();
      current = null;
      countCache.clear();
    }
    for (const t of [...tableStates.keys()]) if (!schema.tables[t]) tableStates.delete(t);
    if (!current || !schema.tables[current]) {
      current = Object.values(schema.tables).find((t) => t.type === 'table')?.name || Object.keys(schema.tables)[0] || null;
    }
    if (db.path !== samplePath) rememberPath(db.path);
    showWorkspace();
    countTables();
  }

  // Exact row counts for the sidebar, one table at a time in the background.
  // COUNT(*) has to read the whole table, so on a big database this can take a while.
  async function countTables() {
    const dbId = db.id;
    for (const t of Object.values(schema.tables)) {
      if (t.type !== 'table' || t.rowCount != null) continue;
      try {
        const r = await query(`SELECT COUNT(*) FROM ${qi(t.name)}`, [], 'tablecount', 1);
        if (!db || db.id !== dbId) return;
        t.rowCount = r.rows[0][0];
        renderTableList();
        if (t.name === current) renderBuilderHead();
      } catch (e) {
        if (!db || db.id !== dbId) return;
      }
    }
  }

  function withErrors(fn) {
    return async (...args) => {
      try {
        await fn(...args);
      } catch (e) {
        if (e instanceof CancelledError) return;
        console.error(e);
        if (db && !$('workspace').hidden) toast(e.message, true);
        else showOpenError(e.message);
      }
    };
  }

  function showOpenError(msg) {
    $('open-error').hidden = !msg;
    $('open-error').textContent = msg || '';
  }

  // ---------- recent paths (per-browser convenience only) ----------
  function recentPaths() {
    try { return JSON.parse(localStorage.getItem('dbx.recent') || '[]'); } catch (_) { return []; }
  }
  function rememberPath(p) {
    try {
      const list = [p, ...recentPaths().filter((x) => x !== p)].slice(0, 6);
      localStorage.setItem('dbx.recent', JSON.stringify(list));
    } catch (_) { /* storage unavailable */ }
  }
  function renderRecent() {
    const list = canOpenByPath ? recentPaths() : [];
    $('recent').hidden = !list.length;
    $('recent-list').replaceChildren(...list.map((p) =>
      h('li', null, h('button', { class: 'link mono', type: 'button', title: p, onclick: withErrors(() => openPath(p)) }, p))
    ));
  }

  // ---------- screens ----------
  function showLanding() {
    db = null; schema = null; current = null;
    tableStates.clear();
    countCache.clear();
    closePopover();
    $('workspace').hidden = true;
    $('db-info').hidden = true;
    $('landing').hidden = false;
    document.title = 'DB Explorer';
    renderRecent();
    $('path-input').focus();
  }

  function showWorkspace() {
    $('landing').hidden = true;
    $('workspace').hidden = false;
    $('db-info').hidden = false;
    $('db-name').textContent = `${db.path} · ${fmtBytes(db.size)}`;
    $('db-name').title = db.path;
    document.title = db.name + ' · DB Explorer';
    renderTableList();
    selectTable(current, true);
  }

  // ---------- sidebar ----------
  function countLabel(t) {
    if (t.rowCount != null) return fmt(t.rowCount);
    if (t.estimate != null) return '~' + fmt(t.estimate);
    return t.type === 'table' ? '…' : '';
  }

  function renderTableList() {
    const q = $('table-search').value.trim().toLowerCase();
    const items = Object.values(schema.tables).filter((t) => !q || t.name.toLowerCase().includes(q));
    const section = (title, list) => list.length ? [
      h('div', { class: 'list-heading' }, title),
      ...list.map((t) => h('button', {
        class: 'table-item' + (t.name === current ? ' active' : ''),
        onclick: () => selectTable(t.name),
      }, h('span', { class: 'name' }, t.name), h('span', { class: 'count' }, countLabel(t)))),
    ] : [];
    const nodes = [
      ...section('Tables', items.filter((t) => t.type === 'table')),
      ...section('Views', items.filter((t) => t.type === 'view')),
    ];
    if (!Object.keys(schema.tables).length) nodes.push(h('p', { class: 'muted pad' }, 'This database has no tables.'));
    else if (!nodes.length) nodes.push(h('p', { class: 'muted pad' }, 'No tables match.'));
    $('table-list').replaceChildren(...nodes);
  }

  function selectTable(name, keepPage) {
    current = name;
    if (!keepPage) page = 0;
    closePopover();
    renderTableList();
    if (!name) {
      $('table-title').textContent = 'No tables';
      $('grid').replaceChildren();
      return;
    }
    if (!tableStates.has(name)) tableStates.set(name, newState(name));
    renderBuilder();
    if (mode === 'explore') refresh();
  }

  // ---------- builder ----------
  function renderBuilderHead() {
    const t = schema.tables[current];
    $('table-title').textContent = t.name;
    const rows = t.rowCount != null ? `${fmt(t.rowCount)} rows` : t.estimate != null ? `about ${fmt(t.estimate)} rows` : null;
    $('table-meta').textContent = [t.type === 'view' ? 'view' : null, rows, `${t.columns.length} columns`].filter(Boolean).join(' · ');
  }

  function renderBuilder() {
    const st = S();
    renderBuilderHead();
    const shown = st.columns.filter((c) => c.visible).length;
    $('btn-columns').textContent = `Columns (${shown} of ${st.columns.length})`;
    $('btn-columns').disabled = st.summary.on;
    $('summary-toggle').checked = st.summary.on;
    $('btn-links').hidden = !availableLinks(st, schema).length && !st.joins.length;
    renderJoins();
    renderFilters();
    renderSummary();
  }

  function columnSelect(cols, value, onchange, placeholder) {
    return h('select', { onchange: (e) => onchange(e.target.value) },
      placeholder ? h('option', { value: '', selected: !value, disabled: true }, placeholder) : null,
      cols.map((c) => h('option', { value: c.key, selected: c.key === value }, c.label)));
  }

  function renderJoins() {
    const st = S();
    const box = $('joins');
    box.replaceChildren();
    if (!st.joins.length) return;
    box.append(h('span', { class: 'muted small' }, 'Linked:'));
    for (const j of st.joins) {
      box.append(h('span', { class: 'tag' },
        j.label,
        h('span', { class: 'muted' }, ` via ${j.pairs.map((p) => p[0]).join(', ')}`),
        h('button', { class: 'x', title: 'Remove this link', onclick: () => removeJoin(j.alias) }, '×')));
    }
  }

  function renderFilters() {
    const st = S();
    const cols = availableColumns(st, schema);
    const box = $('filters');
    box.replaceChildren();
    if (!st.filters.length) return;
    if (st.filters.length > 1) {
      box.append(h('div', { class: 'match small' }, 'Show rows that match ',
        h('select', { onchange: (e) => { st.match = e.target.value; changed(); } },
          h('option', { value: 'all', selected: st.match === 'all' }, 'all'),
          h('option', { value: 'any', selected: st.match === 'any' }, 'any')),
        ' of these filters'));
    }
    st.filters.forEach((f, i) => {
      const op = OPERATORS.find((o) => o.id === f.op);
      const col = cols.find((c) => c.key === f.key);
      const listId = `dl-${i}`;
      const valueInput = (prop, placeholder) => h('input', {
        type: 'text', value: f[prop] ?? '', placeholder, list: op.arity === 1 ? listId : null,
        oninput: (e) => { f[prop] = e.target.value; changed(true); },
        onfocus: () => fillDistinct(listId, col),
      });
      const inputs = [];
      if (op.arity === 1) inputs.push(valueInput('value', 'value'), h('datalist', { id: listId }));
      if (op.arity === 2) inputs.push(valueInput('value', 'from'), h('span', { class: 'muted' }, 'and'), valueInput('value2', 'to'));
      if (op.arity === 'list') inputs.push(valueInput('value', 'e.g. London, Paris, Rome'));
      box.append(h('div', { class: 'filter-row' },
        columnSelect(cols, f.key, (k) => { f.key = k; changed(); renderFilters(); }),
        h('select', { onchange: (e) => { f.op = e.target.value; changed(); renderFilters(); } },
          OPERATORS.map((o) => h('option', { value: o.id, selected: o.id === f.op }, o.label))),
        ...inputs,
        h('button', { class: 'x', title: 'Remove filter', onclick: () => { st.filters.splice(i, 1); changed(); renderFilters(); } }, '×')));
    });
  }

  // Suggestions for the filter box. Only samples the first 200,000 rows so it
  // stays quick on huge tables.
  async function fillDistinct(listId, col) {
    const dl = document.getElementById(listId);
    if (!dl || !col || dl.dataset.for === col.key) return;
    dl.dataset.for = col.key;
    const c = qi(col.column);
    try {
      const r = await query(
        `SELECT DISTINCT v FROM (SELECT ${c} AS v FROM ${qi(col.table)} LIMIT 200000) WHERE v IS NOT NULL AND typeof(v) <> 'blob' LIMIT 300`,
        [], 'distinct', 300);
      r.rows.sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }));
      dl.replaceChildren(...r.rows.map(([v]) => h('option', { value: plain(v) })));
    } catch (_) { /* suggestions are optional */ }
  }

  function renderSummary() {
    const st = S();
    const box = $('summary');
    box.hidden = !st.summary.on;
    box.replaceChildren();
    if (!st.summary.on) return;
    const cols = availableColumns(st, schema);
    const byKey = new Map(cols.map((c) => [c.key, c]));
    const sm = st.summary;

    const groupTags = sm.groupBy.filter((k) => byKey.has(k)).map((k, i) => h('span', { class: 'tag' }, byKey.get(k).label,
      h('button', { class: 'x', title: 'Remove', onclick: () => { sm.groupBy.splice(i, 1); changed(); renderSummary(); } }, '×')));
    const remaining = cols.filter((c) => !sm.groupBy.includes(c.key));
    box.append(h('div', { class: 'summary-row' },
      h('span', { class: 'label' }, 'Group rows by'),
      ...groupTags,
      columnSelect(remaining, '', (k) => { sm.groupBy.push(k); changed(); renderSummary(); }, sm.groupBy.length ? '+ add another' : 'choose a column…')));

    sm.measures.forEach((m, i) => {
      const def = MEASURES.find((d) => d.id === m.fn);
      box.append(h('div', { class: 'summary-row' },
        h('span', { class: 'label' }, i === 0 ? 'and show' : 'and'),
        h('select', { onchange: (e) => { m.fn = e.target.value; if (MEASURES.find((d) => d.id === m.fn).needsColumn && !m.key) m.key = likelyAmount(cols); changed(); renderSummary(); } },
          MEASURES.map((d) => h('option', { value: d.id, selected: d.id === m.fn }, d.label))),
        def.needsColumn ? columnSelect(cols, m.key, (k) => { m.key = k; changed(); }) : null,
        sm.measures.length > 1 ? h('button', { class: 'x', title: 'Remove', onclick: () => { sm.measures.splice(i, 1); changed(); renderSummary(); } }, '×') : null));
    });
    box.append(h('button', { class: 'ghost small', onclick: () => { sm.measures.push({ fn: 'sum', key: likelyAmount(cols) }); changed(); renderSummary(); } }, '+ Show another figure'));
  }

  // Best guess at a column worth adding up: numeric, and not an ID or key.
  function likelyAmount(cols) {
    const isKey = (c) => /(^|_)id$/i.test(c.column) || schema.tables[c.table].columns.find((x) => x.name === c.column)?.pk;
    const numeric = cols.filter((c) => ['INTEGER', 'REAL', 'NUMERIC'].includes(c.affinity) && !isKey(c));
    return (numeric.find((c) => c.affinity === 'REAL') || numeric[0] || cols[0])?.key;
  }

  function addJoin(link) {
    const st = S();
    const alias = 'j' + st.nextAlias++;
    st.joins.push({ alias, from: link.from, fkId: link.fkId, table: link.table, pairs: link.pairs, label: link.label });
    const keyCols = new Set(link.pairs.map((p) => p[1]));
    for (const c of schema.tables[link.table].columns) st.columns.push({ key: alias + '.' + c.name, visible: !keyCols.has(c.name) });
    closePopover();
    renderBuilder();
    changed();
  }

  function removeJoin(alias) {
    const st = S();
    const gone = new Set([alias]);
    let grew = true;
    while (grew) { // also drop links that hang off this one
      grew = false;
      for (const j of st.joins) if (gone.has(j.from) && !gone.has(j.alias)) { gone.add(j.alias); grew = true; }
    }
    const keep = (key) => key == null || !gone.has(key.split('.')[0]);
    st.joins = st.joins.filter((j) => !gone.has(j.alias));
    st.columns = st.columns.filter((c) => keep(c.key));
    st.filters = st.filters.filter((f) => keep(f.key));
    st.summary.groupBy = st.summary.groupBy.filter(keep);
    st.summary.measures = st.summary.measures.filter((m) => keep(m.key));
    if (!st.summary.measures.length) st.summary.measures.push({ fn: 'count', key: null });
    renderBuilder();
    changed();
  }

  // ---------- popovers ----------
  function openPopover(anchor, content) {
    const pop = $('popover');
    pop.replaceChildren(content);
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 12);
    pop.style.left = Math.max(12, left) + 'px';
    pop.style.top = r.bottom + 6 + window.scrollY + 'px';
    pop.dataset.anchor = anchor.id;
  }
  function closePopover() { $('popover').hidden = true; $('popover').dataset.anchor = ''; }

  function columnsPopover() {
    const st = S();
    const cols = availableColumns(st, schema);
    const byKey = new Map(cols.map((c) => [c.key, c]));
    const search = h('input', { type: 'search', placeholder: 'Find a column…', oninput: () => drawList() });
    const list = h('div', { class: 'check-list' });
    const drawList = () => {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren(...st.columns.filter((c) => byKey.has(c.key) && byKey.get(c.key).label.toLowerCase().includes(q)).map((c) =>
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: c.visible, onchange: (e) => { c.visible = e.target.checked; renderBuilder(); changed(); } }),
          h('span', null, byKey.get(c.key).label))));
    };
    const setAll = (v) => { st.columns.forEach((c) => { c.visible = v; }); drawList(); renderBuilder(); changed(); };
    drawList();
    return h('div', { class: 'pop-columns' },
      h('div', { class: 'row' }, search,
        h('button', { class: 'ghost small', onclick: () => setAll(true) }, 'All'),
        h('button', { class: 'ghost small', onclick: () => setAll(false) }, 'None')),
      list);
  }

  function linksPopover() {
    const links = availableLinks(S(), schema);
    if (!links.length) return h('p', { class: 'muted pad' }, 'No more related tables to link.');
    return h('div', { class: 'pop-links' },
      h('p', { class: 'muted small' }, 'Bring in columns from a related table:'),
      links.map((l) => h('button', { class: 'link-item', onclick: () => addJoin(l) },
        h('strong', null, l.label), h('span', { class: 'muted small' }, `matched on ${l.via}`))));
  }

  function togglePopover(anchor, make) {
    if (!$('popover').hidden && $('popover').dataset.anchor === anchor.id) closePopover();
    else openPopover(anchor, make());
  }

  // ---------- results ----------
  let refreshTimer = null;
  let refreshSeq = 0;
  let lastTotal = null; // row count of the current explore query, once known
  const countCache = new Map(); // count SQL + params -> total

  function changed(debounce) {
    page = 0;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, debounce ? 350 : 0);
  }

  function setLoading(on) {
    $('grid-wrap').classList.toggle('loading', on);
  }

  async function refresh() {
    clearTimeout(refreshTimer);
    if (mode !== 'explore' || !current) return;
    const seq = ++refreshSeq;
    const stale = () => seq !== refreshSeq || mode !== 'explore';
    showResultError(null);
    const q = build(S(), schema);
    $('sql-preview-text').textContent = q ? inlineParams(q.sql, q.params) : '';
    if (!q) {
      $('result-count').textContent = 'Choose at least one column to show.';
      $('grid').replaceChildren();
      $('pager').replaceChildren();
      return;
    }

    const countKey = q.countSql + '\u0000' + JSON.stringify(q.countParams);
    const table = schema.tables[current];
    const wholeTable = q.countSql === `SELECT COUNT(*) FROM ${qi(current)}`;
    lastTotal = countCache.has(countKey) ? countCache.get(countKey) : null;
    if (lastTotal == null && wholeTable) lastTotal = table.rowCount;
    if (lastTotal == null) {
      $('result-count').replaceChildren(h('span', { class: 'muted' }, 'Counting rows…'));
      query(q.countSql, q.countParams, 'count', 1).then((r) => {
        countCache.set(countKey, r.rows[0][0]);
        if (wholeTable && table.rowCount == null) { // share it with the sidebar
          table.rowCount = r.rows[0][0];
          if (schema && schema.tables[table.name] === table) renderTableList();
        }
        if (stale()) return;
        lastTotal = r.rows[0][0];
        showCount();
      }).catch((e) => {
        if (!(e instanceof CancelledError) && !stale()) $('result-count').textContent = '';
      });
    } else {
      showCount();
    }

    const loadingTimer = setTimeout(() => setLoading(true), 150);
    try {
      const r = await query(q.sql + ' LIMIT ? OFFSET ?', [...q.params, PAGE_SIZE, page * PAGE_SIZE], 'page', PAGE_SIZE);
      if (stale()) return;
      renderGrid(q.labels, r.rows, true);
      lastPage = { rows: r.rows.length, more: r.more };
      renderPager();
    } catch (e) {
      if (!(e instanceof CancelledError) && !stale()) showResultError(e.message);
    } finally {
      clearTimeout(loadingTimer);
      if (!stale()) setLoading(false);
    }
  }

  let lastPage = { rows: 0, more: false };

  function showCount() {
    $('result-count').textContent = `${fmt(lastTotal)} ${lastTotal === 1 ? 'row' : 'rows'}`;
    renderPager();
  }

  function renderGrid(labels, rows, sortable) {
    const st = S();
    const head = h('tr', null, labels.map((l) => {
      const dir = sortable && st.sort && st.sort.label === l ? st.sort.dir : null;
      return h('th', {
        class: sortable ? 'sortable' : null,
        title: sortable ? 'Click to sort' : null,
        onclick: sortable ? () => cycleSort(l) : null,
      }, l, dir ? h('span', { class: 'arrow' }, dir === 'asc' ? ' ▲' : ' ▼') : null);
    }));
    const body = rows.length
      ? rows.map((row) => h('tr', null, row.map(cell)))
      : [h('tr', null, h('td', { class: 'empty', colSpan: labels.length || 1 }, 'No rows match.'))];
    $('grid').replaceChildren(h('thead', null, head), h('tbody', null, body));
  }

  // Values arrive as JSON; a few kinds are wrapped by the server so nothing is lost.
  function plain(v) {
    if (v && typeof v === 'object') return v.$int ?? v.$text ?? '';
    return v;
  }

  function cell(v) {
    if (v === null || v === undefined) return h('td', { class: 'null' }, '');
    if (typeof v === 'object') {
      if (v.$int != null) return h('td', { class: 'num' }, v.$int);
      if (v.$blob != null) return h('td', { class: 'null' }, `[binary, ${fmt(v.$blob)} bytes]`);
      return h('td', null, String(v.$text ?? ''));
    }
    if (typeof v === 'number') return h('td', { class: 'num' }, String(v));
    const s = String(v);
    return s.length > 200 ? h('td', { title: s.slice(0, 2000) }, s.slice(0, 200) + '…') : h('td', null, s);
  }

  function cycleSort(label) {
    const st = S();
    if (!st.sort || st.sort.label !== label) st.sort = { label, dir: 'asc' };
    else if (st.sort.dir === 'asc') st.sort.dir = 'desc';
    else st.sort = null;
    changed();
  }

  function renderPager() {
    if (mode !== 'explore') return;
    const from = lastPage.rows ? page * PAGE_SIZE + 1 : 0;
    const to = page * PAGE_SIZE + lastPage.rows;
    const go = (p) => { page = p; refresh(); $('grid-wrap').scrollTop = 0; };
    const multi = page > 0 || lastPage.more;
    $('pager').replaceChildren(
      multi ? h('button', { class: 'ghost small', disabled: page === 0, onclick: () => go(page - 1) }, '← Previous') : '',
      h('span', { class: 'muted small' }, lastPage.rows
        ? `Showing ${fmt(from)}–${fmt(to)}` + (lastTotal != null ? ` of ${fmt(lastTotal)}` : '')
        : ''),
      multi ? h('button', { class: 'ghost small', disabled: !lastPage.more, onclick: () => go(page + 1) }, 'Next →') : '');
  }

  function showResultError(msg) {
    $('result-error').hidden = !msg;
    $('result-error').textContent = msg || '';
    if (msg) { $('grid').replaceChildren(); $('pager').replaceChildren(); $('result-count').textContent = ''; }
  }

  // Readable SQL for the "Show SQL" box: put the bound values back in place of each ?.
  function inlineParams(sql, params) {
    let out = '';
    let i = 0;
    let quote = null;
    for (const ch of sql) {
      if (quote) { if (ch === quote) quote = null; out += ch; continue; }
      if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
      if (ch === '?' && i < params.length) {
        const p = params[i++];
        out += typeof p === 'number' ? String(p) : "'" + String(p).replace(/'/g, "''") + "'";
        continue;
      }
      out += ch;
    }
    return out.replace(/ (FROM|LEFT JOIN|WHERE|GROUP BY|ORDER BY) /g, '\n$1 ');
  }

  // ---------- SQL mode ----------
  const userSql = () => $('sql-input').value.trim().replace(/;+\s*$/, '');

  async function runSql() {
    showResultError(null);
    const sql = userSql();
    if (!sql) return;
    const seq = ++refreshSeq;
    const stale = () => seq !== refreshSeq || mode !== 'sql';
    $('result-count').replaceChildren(h('span', { class: 'muted' }, 'Running…'));
    setLoading(true);
    try {
      const r = await query(sql, [], 'sql', SQL_PREVIEW_ROWS);
      if (stale()) return;
      renderGrid(r.columns, r.rows, false);
      $('pager').replaceChildren();
      if (!r.more) {
        $('result-count').textContent = `${fmt(r.rows.length)} ${r.rows.length === 1 ? 'row' : 'rows'}`;
        return;
      }
      $('result-count').textContent = `Showing the first ${fmt(r.rows.length)} rows (counting the rest…)`;
      query(`SELECT COUNT(*) FROM (${sql})`, [], 'sqlcount', 1).then((c) => {
        if (!stale()) $('result-count').textContent = `${fmt(c.rows[0][0])} rows · showing the first ${fmt(r.rows.length)}; the download includes them all`;
      }).catch(() => {
        if (!stale()) $('result-count').textContent = `Showing the first ${fmt(r.rows.length)} rows; the download includes them all`;
      });
    } catch (e) {
      if (!(e instanceof CancelledError) && !stale()) showResultError(e.message);
    } finally {
      if (!stale()) setLoading(false);
    }
  }

  function setMode(m) {
    mode = m;
    refreshSeq++;
    $('tab-explore').classList.toggle('active', m === 'explore');
    $('tab-sql').classList.toggle('active', m === 'sql');
    $('explore-panel').hidden = m !== 'explore';
    $('sql-panel').hidden = m !== 'sql';
    $('btn-show-sql').hidden = m !== 'explore';
    $('sql-preview').hidden = m !== 'explore' || !sqlShown;
    closePopover();
    setLoading(false);
    if (m === 'sql') {
      if (!$('sql-input').value.trim() && current) $('sql-input').value = `SELECT * FROM ${qi(current)}`;
      $('grid').replaceChildren();
      $('pager').replaceChildren();
      $('result-count').textContent = '';
      showResultError(null);
      $('sql-input').focus();
      runSql();
    } else {
      refresh();
    }
  }

  // ---------- export ----------
  const today = () => new Date().toISOString().slice(0, 10);
  let exporting = false;

  async function startExport(sheets, filename, expectedRows) {
    if (exporting) return toast('An export is already running.', true);
    exporting = true;
    const panel = $('export-panel');
    const status = $('export-status');
    const bar = $('export-bar');
    const cancel = $('btn-export-cancel');
    panel.hidden = false;
    status.textContent = 'Starting export…';
    bar.style.width = '0%';
    bar.parentElement.classList.toggle('indeterminate', !expectedRows);
    cancel.hidden = false;
    try {
      const { token } = await api('export', { id: db.id, sheets, filename });
      cancel.onclick = () => { api(`export/${token}/cancel`, {}).catch(() => {}); status.textContent = 'Cancelling…'; };
      for (;;) {
        await new Promise((r) => setTimeout(r, 400));
        const s = await api(`export/${token}`);
        if (s.state === 'running') {
          const pct = expectedRows ? Math.min(100, (s.rows / expectedRows) * 100) : null;
          status.textContent = `Writing ${sheets.length > 1 && s.sheet ? `“${s.sheet}”… ` : ''}${fmt(s.rows)} rows` +
            (expectedRows ? ` of ${fmt(expectedRows)}` : '') + ' so far';
          if (pct != null) bar.style.width = pct.toFixed(1) + '%';
          continue;
        }
        if (s.state === 'done') {
          bar.style.width = '100%';
          const frame = h('iframe', { hidden: true, src: 'download/' + token });
          document.body.append(frame);
          setTimeout(() => frame.remove(), 10 * 60 * 1000);
          const notes = s.warnings || [];
          toast(`Downloaded ${s.filename} (${fmt(s.rows)} rows)` + (notes.length ? '. ' + notes.join(' ') : ''), false, notes.length ? 10000 : 4000);
        } else if (s.state === 'cancelled') {
          toast('Export cancelled.');
        } else {
          toast('Export failed: ' + (s.error || 'unknown error'), true);
        }
        break;
      }
    } finally {
      exporting = false;
      panel.hidden = true;
    }
  }

  const exportCurrent = withErrors(async () => {
    if (mode === 'sql') {
      const sql = userSql();
      if (!sql) return;
      await startExport([{ name: 'Query', sql, params: [] }], `query-${today()}.xlsx`, null);
      return;
    }
    const st = S();
    const q = build(st, schema);
    if (!q) return toast('Choose at least one column first.', true);
    const name = st.summary.on ? `${st.table} summary` : st.table;
    await startExport([{ name, sql: q.sql, params: q.params, columns: q.labels }], `${name}-${today()}.xlsx`, lastTotal);
  });

  const exportAll = withErrors(async () => {
    const tables = Object.values(schema.tables).filter((t) => t.type === 'table');
    if (!tables.length) return toast('There are no tables to export.', true);
    const known = tables.every((t) => t.rowCount != null);
    const total = known ? tables.reduce((n, t) => n + t.rowCount, 0) : null;
    if (total != null && total > 5_000_000 &&
        !confirm(`That's ${fmt(total)} rows across ${tables.length} tables, which will make a very large Excel file and take a while. Continue?`)) return;
    const sheets = tables.map((t) => ({ name: t.name, sql: `SELECT * FROM ${qi(t.name)}`, params: [] }));
    await startExport(sheets, `${db.name.replace(/\.[^.]+$/, '')}-${today()}.xlsx`, total);
  });

  // ---------- toast ----------
  let toastTimer = null;
  function toast(msg, isError, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || (isError ? 6000 : 3500));
  }

  // ---------- wiring ----------
  function init() {
    $('path-form').hidden = !canOpenByPath;
    $('path-unavailable').hidden = canOpenByPath;
    $('path-form').addEventListener('submit', withErrors(async (e) => {
      e.preventDefault();
      const p = $('path-input').value.trim();
      if (!p) return showOpenError('Type or paste the path to a database file.');
      await openPath(p);
    }));
    $('btn-sample').addEventListener('click', withErrors(() => openPath(samplePath)));

    $('btn-close').addEventListener('click', showLanding);
    $('btn-reload').addEventListener('click', withErrors(async () => {
      await openPath(db.path, true);
      toast('Reloaded');
    }));
    $('btn-export-all').addEventListener('click', exportAll);
    $('btn-export').addEventListener('click', exportCurrent);
    $('table-search').addEventListener('input', renderTableList);

    $('tab-explore').addEventListener('click', () => setMode('explore'));
    $('tab-sql').addEventListener('click', () => setMode('sql'));
    $('btn-run-sql').addEventListener('click', runSql);
    $('sql-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runSql(); }
    });

    $('btn-columns').addEventListener('click', (e) => togglePopover(e.currentTarget, columnsPopover));
    $('btn-links').addEventListener('click', (e) => togglePopover(e.currentTarget, linksPopover));
    $('btn-add-filter').addEventListener('click', () => {
      const st = S();
      st.filters.push({ key: availableColumns(st, schema)[0].key, op: 'contains', value: '', value2: '' });
      renderFilters();
      const inputs = $('filters').querySelectorAll('.filter-row:last-child input');
      if (inputs.length) inputs[0].focus();
    });
    $('summary-toggle').addEventListener('change', (e) => {
      S().summary.on = e.target.checked;
      renderBuilder();
      changed();
    });
    $('btn-reset').addEventListener('click', () => {
      tableStates.set(current, newState(current));
      closePopover();
      renderBuilder();
      changed();
    });
    $('btn-show-sql').addEventListener('click', () => {
      sqlShown = !sqlShown;
      $('sql-preview').hidden = !sqlShown;
      $('btn-show-sql').textContent = sqlShown ? 'Hide SQL' : 'Show SQL';
    });
    $('btn-edit-sql').addEventListener('click', () => {
      $('sql-input').value = $('sql-preview-text').textContent;
      setMode('sql');
    });

    document.addEventListener('mousedown', (e) => {
      const pop = $('popover');
      if (pop.hidden || pop.contains(e.target)) return;
      if (e.target.closest('#' + (pop.dataset.anchor || '_'))) return;
      closePopover();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });
    window.addEventListener('resize', closePopover);

    renderRecent();
    if (canOpenByPath) {
      api('startup')
        .then((d) => {
          samplePath = d.samplePath;
          $('btn-sample').hidden = !samplePath;
          if (d.path) return withErrors(openPath)(d.path);
        })
        .catch(() => {});
    } else {
      $('btn-sample').hidden = true;
    }
  }

  init();
})();
