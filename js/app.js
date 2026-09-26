(function () {
  'use strict';

  const { $, h, fmt, icon, menu, popover, askText, closeLayer, isOpenFor, dialog, closeDialog, toast } = window.DBXDom;
  const P = window.DBXPipeline;
  const { qi } = P;
  const PAGE_SIZE = 100;
  const SQL_PREVIEW_ROWS = 500;
  const VALUES_SAMPLE = 200000;
  const COUNT_CAP = 10000;

  const fmtBytes = (n) => {
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${i ? n.toFixed(1) : n} ${units[i]}`;
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));

  // Display form of a cell value (values arrive as JSON; big integers and
  // odd values are wrapped by the server so nothing is lost).
  function display(v, max) {
    if (v === null || v === undefined) return '(empty)';
    if (typeof v === 'object') return v.$int ?? v.$text ?? (v.$blob != null ? `[binary, ${fmt(v.$blob)} bytes]` : '');
    const s = String(v);
    return max && s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  // ---------- app state ----------
  let db = null; // { id, path, name, size, sqliteVersion }
  let schema = null;
  let samplePath = null;
  let queries = []; // { id, name, steps, view (step index or null = last), page, editing, undo: [] }
  let activeId = null; // a query id, or 'sql'
  let sqlShown = false;
  const countCache = new Map();

  const Q = () => queries.find((q) => q.id === activeId) || null;
  const ctxFor = (q) => ({ self: q.id, resolveQuery: (id) => queries.find((x) => x.id === id) });
  const viewIndex = (q) => (q.view == null ? q.steps.length - 1 : Math.min(q.view, q.steps.length - 1));
  const compileView = (q) => P.compile(q.steps, schema, viewIndex(q), ctxFor(q));
  const colsBefore = (q, index) => (index <= 0 ? [] : P.compile(q.steps, schema, index - 1, ctxFor(q)).cols || []);
  const sourceTable = (q) => q.steps[0] && q.steps[0].table;

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
  // With a label, the query shows in the activity bar while it runs.
  function query(sql, params, key, limit, label) {
    const p = api('query', { id: db.id, sql, params: params || [], key, limit: limit || PAGE_SIZE });
    return label ? track(key, label, p) : p;
  }

  // ---------- activity bar: what's running, for how long, and a Cancel ----------
  // SQLite can't say how far through a query it is, so this shows what's
  // happening and the time taken rather than a percentage.
  const activity = new Map(); // key -> { label, start, token }
  const userCancelled = new Set();
  let activityTimer = null;

  function track(key, label, promise) {
    const token = {};
    activity.set(key, { label, start: performance.now(), token });
    userCancelled.delete(key);
    renderActivity();
    return promise.finally(() => {
      if (activity.get(key)?.token === token) activity.delete(key);
      renderActivity();
    });
  }

  function renderActivity() {
    clearTimeout(activityTimer);
    const bar = $('activity');
    if (!activity.size) { bar.hidden = true; return; }
    const now = performance.now();
    const items = [...activity.values()];
    const oldest = Math.min(...items.map((a) => a.start));
    if (now - oldest > 400) {
      const labels = [...new Set(items.map((a) => a.label))];
      $('activity-text').textContent = `${labels.join(' · ')}… ${((now - oldest) / 1000).toFixed(1)}s`;
      bar.hidden = false;
    }
    activityTimer = setTimeout(renderActivity, 100);
  }

  function cancelActivity() {
    const keys = [...activity.keys()];
    if (!keys.length || !db) return;
    keys.forEach((k) => userCancelled.add(k));
    api('cancel', { id: db.id, keys }).catch(() => {});
  }

  // What the page query is mostly doing, for the activity bar.
  function workLabel(q) {
    const types = new Set(q.steps.slice(0, viewIndex(q) + 1).map((s) => s.type));
    if (types.has('group') || types.has('lookup')) return 'Summarising';
    if (types.has('merge') || types.has('append') || types.has('link')) return 'Combining tables';
    if (types.has('sort')) return 'Sorting';
    if (types.has('filter')) return 'Filtering';
    return 'Loading rows';
  }

  // "12 rows" / "10,000+ rows", reading at most COUNT_CAP + 1 matches.
  async function cappedCount(table, column, value, key) {
    const r = await query(`SELECT COUNT(*) FROM (SELECT 1 FROM ${qi(table)} WHERE ${qi(column)} = ? LIMIT ${COUNT_CAP + 1})`, [value], key, 1);
    const n = r.rows[0][0];
    return n > COUNT_CAP ? `${fmt(COUNT_CAP)}+ rows` : `${fmt(n)} ${n === 1 ? 'row' : 'rows'}`;
  }

  function schemaFrom(tables) {
    const out = {};
    for (const t of tables) {
      out[t.name] = {
        name: t.name, type: t.type, rawFks: t.fks, fks: [], rowCount: null, estimate: t.estimate,
        columns: t.columns.map((c) => ({ ...c, affinity: P.affinity(c.type) })),
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

  const sqliteAtLeast = (v) => {
    const have = String(db.sqliteVersion || '0').split('.').map(Number);
    return have[0] > v[0] || (have[0] === v[0] && have[1] >= v[1]);
  };

  // ---------- queries ----------
  const newId = () => 'q' + Math.random().toString(36).slice(2, 9);

  function uniqueQueryName(name) {
    let n = name;
    for (let i = 2; queries.some((q) => q.name === n); i++) n = `${name} (${i})`;
    return n;
  }

  function openQuery(steps, name) {
    const q = { id: newId(), name: uniqueQueryName(name), steps, view: null, page: 0, editing: null, undo: [] };
    queries.push(q);
    activate(q.id);
    return q;
  }

  function openTable(table) {
    const pristine = queries.find((q) => q.steps.length === 1 && q.steps[0].table === table);
    if (pristine) activate(pristine.id);
    else openQuery([{ type: 'source', table }], table);
  }

  function closeQuery(id) {
    const q = queries.find((x) => x.id === id);
    const users = queries.filter((x) => x.id !== id && JSON.stringify(x.steps).includes(`"query":"${id}"`));
    if (users.length && !confirm(`“${users.map((u) => u.name).join('”, “')}” uses “${q.name}”. Close it anyway?`)) return;
    const i = queries.indexOf(q);
    queries.splice(i, 1);
    if (activeId === id) activeId = queries[Math.max(0, i - 1)]?.id || null;
    save();
    renderAll();
    refresh();
  }

  function activate(id) {
    activeId = id;
    closeLayer();
    const q = Q();
    if (q) q.page = q.page || 0;
    save();
    renderAll();
    refresh();
  }

  // Record the state before a change, for Undo.
  function snapshot(q) {
    q.undo.push(JSON.stringify({ steps: q.steps, view: q.view }));
    if (q.undo.length > 60) q.undo.shift();
  }

  function undo() {
    const q = Q();
    if (!q || !q.undo.length) return;
    const s = JSON.parse(q.undo.pop());
    q.steps = s.steps;
    q.view = s.view;
    q.editing = null;
    q.page = 0;
    commit();
  }

  // Add a step after the one being viewed (like Power Query inserting after
  // the selected step). `combine(prev)` may return a replacement for the
  // previous step instead, e.g. a second sort replaces the first.
  function addStep(step, opts = {}) {
    const q = Q();
    snapshot(q);
    const at = viewIndex(q) + 1;
    const prev = q.steps[at - 1];
    let index;
    const merged = opts.combine && prev && at - 1 > 0 ? opts.combine(prev) : null;
    if (merged) {
      q.steps[at - 1] = merged;
      index = at - 1;
    } else {
      q.steps.splice(at, 0, step);
      index = at;
    }
    q.view = index === q.steps.length - 1 ? null : index;
    q.editing = opts.edit ? index : null;
    q.page = 0;
    commit();
    return index;
  }

  function replaceStep(index, step) {
    const q = Q();
    snapshot(q);
    q.steps[index] = step;
    q.page = 0;
    commit();
  }

  function deleteStep(index) {
    const q = Q();
    if (index <= 0) return;
    snapshot(q);
    q.steps.splice(index, 1);
    if (q.view != null) q.view = q.view >= index ? Math.max(0, q.view - 1) : q.view;
    if (q.view != null && q.view >= q.steps.length - 1) q.view = null;
    q.editing = null;
    q.page = 0;
    commit();
  }

  function moveStep(index, delta) {
    const q = Q();
    const to = index + delta;
    if (index <= 0 || to <= 0 || to >= q.steps.length) return;
    snapshot(q);
    const [s] = q.steps.splice(index, 1);
    q.steps.splice(to, 0, s);
    q.view = null;
    q.editing = null;
    commit();
  }

  function commit() {
    save();
    renderTabs();
    renderSteps();
    renderEditor();
    renderTableList();
    refresh();
  }

  // Live edits from the step editor: no undo entry per keystroke.
  let editTimer = null;
  function stepEdited(debounce) {
    const q = Q();
    q.page = 0;
    save();
    renderSteps();
    clearTimeout(editTimer);
    editTimer = setTimeout(refresh, debounce ? 350 : 0);
  }

  // ---------- persistence (per database, in this browser) ----------
  const storeKey = () => 'dbx.q:' + db.path;
  function save() {
    if (!db) return;
    try {
      localStorage.setItem(storeKey(), JSON.stringify({
        active: activeId,
        queries: queries.map(({ id, name, steps, view }) => ({ id, name, steps, view })),
      }));
    } catch (_) { /* storage unavailable */ }
  }
  function restore() {
    try {
      const d = JSON.parse(localStorage.getItem(storeKey()) || 'null');
      if (!d || !Array.isArray(d.queries)) return false;
      queries = d.queries
        .filter((q) => Array.isArray(q.steps) && q.steps.length && q.steps[0].type === 'source')
        .map((q) => ({ ...q, page: 0, editing: null, undo: [] }));
      activeId = d.active === 'sql' || queries.some((q) => q.id === d.active) ? d.active : queries[0]?.id || null;
      return queries.length > 0;
    } catch (_) {
      return false;
    }
  }

  // ---------- opening ----------
  const canOpenByPath = location.protocol === 'http:' || location.protocol === 'https:';

  async function openPath(path, keep) {
    showOpenError(null);
    const btn = $('path-form').querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Opening…';
    try {
      const d = await api('open', { path });
      db = { id: d.id, path: d.path, name: d.name, size: d.size, sqliteVersion: d.sqliteVersion };
      schema = schemaFrom(d.tables);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Open';
    }
    countCache.clear();
    if (!keep) {
      queries = [];
      activeId = null;
      if (!restore()) {
        const first = Object.values(schema.tables).find((t) => t.type === 'table') || Object.values(schema.tables)[0];
        if (first) queries.push({ id: newId(), name: first.name, steps: [{ type: 'source', table: first.name }], view: null, page: 0, editing: null, undo: [] });
        activeId = queries[0]?.id || null;
      }
    }
    if (db.path !== samplePath) rememberPath(db.path);
    closeInspector();
    showWorkspace();
    countTables();
  }

  // Exact row counts for the sidebar, one table at a time in the background.
  async function countTables() {
    const dbId = db.id;
    for (const t of Object.values(schema.tables)) {
      if (t.type !== 'table' || t.rowCount != null) continue;
      try {
        const r = await query(`SELECT COUNT(*) FROM ${qi(t.name)}`, [], 'tablecount', 1);
        if (!db || db.id !== dbId) return;
        t.rowCount = r.rows[0][0];
        renderTableList();
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

  function recentPaths() {
    try { return JSON.parse(localStorage.getItem('dbx.recent') || '[]'); } catch (_) { return []; }
  }
  function rememberPath(p) {
    try {
      localStorage.setItem('dbx.recent', JSON.stringify([p, ...recentPaths().filter((x) => x !== p)].slice(0, 6)));
    } catch (_) { /* storage unavailable */ }
  }
  function renderRecent() {
    const list = canOpenByPath ? recentPaths() : [];
    $('recent').hidden = !list.length;
    $('recent-list').replaceChildren(...list.map((p) =>
      h('li', null, h('button', { class: 'link mono', type: 'button', title: p, onclick: withErrors(() => openPath(p)) }, p))));
  }

  // ---------- screens ----------
  function showLanding() {
    db = null; schema = null; queries = []; activeId = null;
    countCache.clear();
    closeLayer();
    closeInspector();
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
    renderAll();
    refresh();
  }

  function renderAll() {
    const sql = activeId === 'sql';
    $('explore-panel').hidden = sql || !Q();
    $('sql-panel').hidden = !sql;
    $('steps-panel').hidden = sql || !Q();
    $('btn-show-sql').hidden = sql;
    $('search-box').hidden = sql || !Q();
    if (sql) $('search-results').hidden = true;
    $('sql-preview').hidden = sql || !sqlShown;
    $('view-banner').hidden = true;
    renderTabs();
    renderTableList();
    renderSteps();
    renderEditor();
  }

  // ---------- sidebar ----------
  function countLabel(t) {
    if (t.rowCount != null) return fmt(t.rowCount);
    if (t.estimate != null) return '~' + fmt(t.estimate);
    return t.type === 'table' ? '…' : '';
  }

  function renderTableList() {
    if (!schema) return;
    const q = $('table-search').value.trim().toLowerCase();
    const active = Q() ? sourceTable(Q()) : null;
    const items = Object.values(schema.tables).filter((t) => !q || t.name.toLowerCase().includes(q));
    const section = (title, list) => list.length ? [
      h('div', { class: 'list-heading' }, title),
      ...list.map((t) => h('button', {
        class: 'table-item' + (t.name === active ? ' active' : ''),
        title: `Open ${t.name}`,
        onclick: () => openTable(t.name),
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

  // ---------- query tabs ----------
  function renderTabs() {
    const tabs = queries.map((q) => h('div', {
      class: 'qtab' + (q.id === activeId ? ' active' : ''), role: 'tab',
      title: `${q.name}\nDouble-click to rename`,
      onclick: (e) => { if (!e.target.closest('.x')) activate(q.id); },
      ondblclick: async (e) => {
        const name = await askText(e.currentTarget, 'Query name', q.name, 'Rename');
        if (name && name.trim()) { q.name = uniqueQueryName(name.trim()); save(); renderTabs(); }
      },
    }, h('span', { class: 'qtab-name' }, q.name),
    h('button', { class: 'x', title: 'Close', onclick: () => closeQuery(q.id) }, icon('close'))));
    tabs.push(h('div', {
      class: 'qtab sql' + (activeId === 'sql' ? ' active' : ''), role: 'tab', onclick: () => setSqlMode(),
    }, h('span', { class: 'qtab-name' }, 'Write SQL')));
    $('query-tabs').replaceChildren(...tabs);
  }

  // ---------- applied steps ----------
  const EDITABLE = new Set(['filter', 'group', 'top', 'sort', 'merge', 'lookup', 'append', 'link', 'columns', 'rename']);

  function renderSteps() {
    const q = Q();
    if (!q) { $('steps').replaceChildren(); return; }
    const errors = P.stepErrors(q.steps, schema, ctxFor(q));
    const vi = viewIndex(q);
    $('steps').replaceChildren(...q.steps.map((s, i) => {
      const err = errors[i];
      const li = h('li', {
        class: 'step' + (i === vi ? ' selected' : '') + (i > vi ? ' later' : '') + (err ? ' has-error' : '') + (q.editing === i ? ' editing' : ''),
        onclick: (e) => {
          if (e.target.closest('button')) return;
          q.view = i === q.steps.length - 1 ? null : i;
          q.page = 0;
          if (q.editing != null && q.editing !== i) q.editing = null;
          save(); renderSteps(); renderEditor(); refresh();
        },
        ondblclick: (e) => { if (EDITABLE.has(s.type) && !e.target.closest('button')) editStep(i, li); },
      },
      h('span', { class: 'step-num' }, String(i + 1)),
      h('span', { class: 'step-text' }, P.describe(s), err ? h('span', { class: 'step-error' }, err) : null),
      h('span', { class: 'step-actions' },
        EDITABLE.has(s.type) ? h('button', { class: 'icon', title: 'Edit this step', onclick: () => editStep(i, li) }, icon('edit')) : null,
        i > 0 ? h('button', { class: 'icon', title: 'More', onclick: (e) => stepMenu(e.currentTarget, i, li) }, icon('more')) : null,
        i > 0 ? h('button', { class: 'icon x', title: 'Delete this step', onclick: () => deleteStep(i) }, icon('close')) : null));
      return li;
    }));
    $('btn-undo').disabled = !q.undo.length;
  }

  function stepMenu(anchor, i, li) {
    const q = Q();
    menu(anchor, [
      EDITABLE.has(q.steps[i].type) ? { label: 'Edit', onclick: () => editStep(i, li) } : null,
      { label: 'Move up', disabled: i <= 1, onclick: () => moveStep(i, -1) },
      { label: 'Move down', disabled: i >= q.steps.length - 1, onclick: () => moveStep(i, 1) },
      { label: 'New query from here', hint: 'copy steps 1–' + (i + 1) + ' into a new tab', onclick: () => openQuery(clone(q.steps.slice(0, i + 1)), q.name) },
      '-',
      { label: 'Delete', onclick: () => deleteStep(i) },
      { label: 'Delete this and everything after', onclick: () => { snapshot(q); q.steps.splice(i); q.view = null; q.editing = null; commit(); } },
    ]);
  }

  function editStep(i, anchor) {
    const q = Q();
    const s = q.steps[i];
    if (['filter', 'group', 'top', 'sort'].includes(s.type)) {
      snapshot(q);
      q.editing = i;
      q.view = i === q.steps.length - 1 ? null : i;
      save(); renderSteps(); renderEditor(); refresh();
    } else if (s.type === 'merge' || s.type === 'lookup' || s.type === 'append') {
      combineDialog(s.type, i);
    } else if (s.type === 'link') {
      expandPicker(anchor, { table: s.table, pairs: s.pairs }, i);
    } else if (s.type === 'columns') {
      chooseColumns(anchor, i);
    } else if (s.type === 'rename') {
      askText(anchor, `Rename ${s.from} to`, s.to, 'Rename').then((to) => {
        if (to && to.trim()) replaceStep(i, { ...s, to: to.trim() });
      });
    }
  }

  // ---------- step editor (filter / group / sort / top) ----------
  function renderEditor() {
    const q = Q();
    const box = $('step-editor');
    if (!q || activeId === 'sql' || q.editing == null || !q.steps[q.editing]) { box.hidden = true; box.replaceChildren(); return; }
    const i = q.editing;
    const s = q.steps[i];
    const cols = colsBefore(q, i);
    const titles = { filter: 'Filter rows', group: 'Group by', top: 'Keep top rows', sort: 'Sort' };
    const body = h('div', { class: 'editor-body' });
    ({ filter: filterEditor, group: groupEditor, top: topEditor, sort: sortEditor })[s.type](body, s, cols, q, i);
    box.replaceChildren(
      h('div', { class: 'editor-head' },
        h('strong', null, `${titles[s.type]} · step ${i + 1}`),
        h('span', { class: 'spacer' }),
        h('button', { class: 'primary small', onclick: doneEditing }, 'Done')),
      body);
    box.hidden = false;
  }

  function doneEditing() {
    const q = Q();
    const i = q.editing;
    q.editing = null;
    const s = q.steps[i];
    // A filter with nothing filled in does nothing; don't leave it lying around.
    if (s && s.type === 'filter') {
      const effective = s.conditions.some((c) => {
        const op = P.OPERATORS.find((o) => o.id === c.op);
        return op.arity === 0 || (c.value !== '' && c.value != null) || c.value === null || Array.isArray(c.value);
      });
      if (!effective) { q.steps.splice(i, 1); if (q.view != null && q.view >= i) q.view = null; }
    }
    commit();
  }

  function colSelect(cols, value, onchange, placeholder) {
    return h('select', { onchange: (e) => onchange(e.target.value) },
      placeholder ? h('option', { value: '', selected: !value, disabled: true }, placeholder) : null,
      cols.map((c) => h('option', { value: c.name, selected: c.name === value }, c.name)));
  }

  function filterEditor(body, s, cols, q, i) {
    if (s.conditions.length > 1) {
      body.append(h('div', { class: 'small' }, 'Keep rows that match ',
        h('select', { onchange: (e) => { s.match = e.target.value; stepEdited(); } },
          h('option', { value: 'all', selected: s.match !== 'any' }, 'all'),
          h('option', { value: 'any', selected: s.match === 'any' }, 'any')),
        ' of these'));
    }
    s.conditions.forEach((c, k) => {
      const op = P.OPERATORS.find((o) => o.id === c.op) || P.OPERATORS[0];
      const listId = `dl-${i}-${k}`;
      const typed = typeof c.value === 'string' || c.value == null;
      const input = (prop, placeholder) => h('input', {
        type: 'text', placeholder, list: op.arity === 1 ? listId : null,
        value: prop === 'value' && !typed ? (Array.isArray(c.value) ? c.value.map((v) => display(v)).join(', ') : display(c.value)) : (c[prop] ?? ''),
        oninput: (e) => { c[prop] = e.target.value; delete c.negate; stepEdited(true); },
        onfocus: () => suggestValues(listId, q, i, c.col),
      });
      const inputs = [];
      if (op.arity === 1) inputs.push(input('value', 'value'), h('datalist', { id: listId }));
      if (op.arity === 2) inputs.push(input('value', 'from'), h('span', { class: 'muted' }, 'and'), input('value2', 'to'));
      if (op.arity === 'list') inputs.push(input('value', 'e.g. London, Paris, Rome'));
      body.append(h('div', { class: 'filter-row' },
        colSelect(cols, c.col, (v) => { c.col = v; stepEdited(); renderEditor(); }),
        h('select', { onchange: (e) => { c.op = e.target.value; if (Array.isArray(c.value)) c.value = ''; stepEdited(); renderEditor(); } },
          P.OPERATORS.map((o) => h('option', { value: o.id, selected: o.id === c.op }, o.label))),
        ...inputs,
        h('button', { class: 'x', title: 'Remove', onclick: () => { s.conditions.splice(k, 1); if (!s.conditions.length) { doneEditing(); return; } stepEdited(); renderEditor(); } }, icon('close'))));
    });
    body.append(h('button', { class: 'ghost small', onclick: () => {
      s.conditions.push({ col: cols[0]?.name, op: 'contains', value: '' });
      renderEditor();
    } }, '+ Add another condition'));
  }

  // Suggestions for a filter box: values from the rows going into this step
  // (sampled, so it stays quick on huge tables).
  async function suggestValues(listId, q, i, colName) {
    const dl = document.getElementById(listId);
    if (!dl || dl.dataset.for === colName) return;
    dl.dataset.for = colName;
    const before = P.compile(q.steps, schema, i - 1, ctxFor(q));
    if (before.error || !before.cols.some((c) => c.name === colName)) return;
    try {
      const r = await query(
        `SELECT DISTINCT v FROM (SELECT ${qi(colName)} AS v FROM (${before.unsortedSql}) LIMIT ${VALUES_SAMPLE}) WHERE v IS NOT NULL AND typeof(v) <> 'blob' LIMIT 300`,
        before.params, 'distinct', 300);
      r.rows.sort((a, b) => display(a[0]).localeCompare(display(b[0]), undefined, { numeric: true }));
      dl.replaceChildren(...r.rows.map(([v]) => h('option', { value: display(v) })));
    } catch (_) { /* suggestions are optional */ }
  }

  function groupEditor(body, s, cols) {
    const byTags = s.by.map((name, k) => h('span', { class: 'tag' }, name,
      h('button', { class: 'x', title: 'Remove', onclick: () => { s.by.splice(k, 1); stepEdited(); renderEditor(); } }, icon('close'))));
    body.append(h('div', { class: 'summary-row' },
      h('span', { class: 'label' }, 'Group rows by'), ...byTags,
      colSelect(cols.filter((c) => !s.by.includes(c.name)), '', (v) => { s.by.push(v); stepEdited(); renderEditor(); },
        s.by.length ? '+ add another' : 'choose a column…')));
    measureRows(body, s.measures, cols, 'and show');
    if (!s.by.length) body.append(h('p', { class: 'muted small' }, 'With nothing to group by, this summarises all the rows into one.'));
  }

  function measureRows(body, measures, cols, lead, onChange, redraw) {
    onChange = onChange || stepEdited;
    redraw = redraw || renderEditor;
    measures.forEach((m, k) => {
      const def = P.MEASURES.find((d) => d.id === m.fn);
      body.append(h('div', { class: 'summary-row' },
        h('span', { class: 'label' }, k === 0 ? lead : 'and'),
        h('select', { onchange: (e) => {
          m.fn = e.target.value;
          if (P.MEASURES.find((d) => d.id === m.fn).needsColumn && !m.col) m.col = likelyAmount(cols);
          if (!P.MEASURES.find((d) => d.id === m.fn).needsColumn) delete m.col;
          onChange(); redraw();
        } }, P.MEASURES.map((d) => h('option', { value: d.id, selected: d.id === m.fn }, d.label))),
        def.needsColumn ? colSelect(cols, m.col, (v) => { m.col = v; onChange(); }) : null,
        measures.length > 1 ? h('button', { class: 'x', title: 'Remove', onclick: () => { measures.splice(k, 1); onChange(); redraw(); } }, icon('close')) : null));
    });
    body.append(h('button', { class: 'ghost small', onclick: () => {
      measures.push({ fn: 'sum', col: likelyAmount(cols) });
      onChange(); redraw();
    } }, '+ Show another figure'));
  }

  // Best guess at a column worth adding up: numeric, and not an ID or key.
  function likelyAmount(cols) {
    const isKey = (c) => /(^|_|\.)id$/i.test(c.name) || (c.prov && P.primaryKey(c.prov.table, schema) === c.prov.column);
    const numeric = cols.filter((c) => P.isNumeric(c.affinity) && !isKey(c));
    return (numeric.find((c) => c.affinity === 'REAL') || numeric[0] || cols[0])?.name;
  }

  function topEditor(body, s) {
    body.append(h('div', { class: 'summary-row' }, 'Keep the first',
      h('input', { type: 'number', min: 1, value: s.n, style: { width: '110px' }, oninput: (e) => { s.n = e.target.value; stepEdited(true); } }),
      'rows', h('span', { class: 'muted small' }, '(after any sorting above)')));
  }

  function sortEditor(body, s, cols) {
    s.by.forEach((o, k) => {
      body.append(h('div', { class: 'summary-row' },
        h('span', { class: 'label' }, k === 0 ? 'Sort by' : 'then by'),
        colSelect(cols, o.col, (v) => { o.col = v; stepEdited(); }),
        h('select', { onchange: (e) => { o.dir = e.target.value; stepEdited(); } },
          h('option', { value: 'asc', selected: o.dir !== 'desc' }, 'Ascending (A to Z, smallest first)'),
          h('option', { value: 'desc', selected: o.dir === 'desc' }, 'Descending (Z to A, largest first)')),
        s.by.length > 1 ? h('button', { class: 'x', onclick: () => { s.by.splice(k, 1); stepEdited(); renderEditor(); } }, icon('close')) : null));
    });
    body.append(h('button', { class: 'ghost small', onclick: () => { s.by.push({ col: cols[0].name, dir: 'asc' }); stepEdited(); renderEditor(); } }, '+ Then by another column'));
  }

  // ---------- results ----------
  let refreshTimer = null;
  let refreshSeq = 0;
  let lastTotal = null;
  let lastPage = { rows: 0, more: false };
  let lastGrid = null;

  function setLoading(on) { $('grid-wrap').classList.toggle('loading', on); }

  async function refresh() {
    clearTimeout(refreshTimer);
    clearTimeout(editTimer);
    if (!db || activeId === 'sql') return;
    const q = Q();
    const seq = ++refreshSeq;
    const stale = () => seq !== refreshSeq || Q() !== q;
    showResultError(null);
    if (!q) {
      $('result-count').textContent = 'Pick a table on the left to start.';
      $('grid').replaceChildren();
      $('pager').replaceChildren();
      return;
    }
    const vi = viewIndex(q);
    const banner = $('view-banner');
    banner.hidden = vi === q.steps.length - 1;
    if (!banner.hidden) {
      banner.replaceChildren(`Showing the data after step ${vi + 1} of ${q.steps.length} (“${P.describe(q.steps[vi])}”). `,
        h('button', { class: 'link', onclick: () => { q.view = null; q.editing = null; commit(); } }, 'Show the final result'));
    }

    const c = compileView(q);
    if (c.error && c.error.step <= vi) {
      showResultError(`Step ${c.error.step + 1} (“${P.describe(q.steps[c.error.step])}”) has a problem: ${c.error.message}. Edit or delete it in Applied steps.`);
      return;
    }
    $('sql-preview-text').textContent = inlineParams(c.sql, c.params);

    const countKey = c.countSql + '\u0000' + JSON.stringify(c.countParams);
    const base = q.steps.length && schema.tables[sourceTable(q)];
    const wholeTable = base && c.countSql === `SELECT COUNT(*) FROM ${qi(base.name)}`;
    lastTotal = countCache.has(countKey) ? countCache.get(countKey) : null;
    if (lastTotal == null && wholeTable) lastTotal = base.rowCount;
    if (lastTotal == null) {
      $('result-count').replaceChildren(h('span', { class: 'muted' }, 'Counting rows…'));
      query(c.countSql, c.countParams, 'count', 1, 'Counting rows').then((r) => {
        countCache.set(countKey, r.rows[0][0]);
        if (wholeTable && base.rowCount == null) { base.rowCount = r.rows[0][0]; renderTableList(); }
        if (stale()) return;
        lastTotal = r.rows[0][0];
        showCount();
      }).catch((e) => {
        if (stale()) return;
        if (e instanceof CancelledError && userCancelled.delete('count')) {
          $('result-count').replaceChildren(h('span', { class: 'muted' }, 'Row count stopped. '),
            h('button', { class: 'link small', onclick: refresh }, 'Count again'));
        } else if (!(e instanceof CancelledError)) $('result-count').textContent = '';
      });
    } else {
      showCount();
    }

    const loadingTimer = setTimeout(() => setLoading(true), 150);
    try {
      const r = await query(c.sql + ' LIMIT ? OFFSET ?', [...c.params, PAGE_SIZE, q.page * PAGE_SIZE], 'page', PAGE_SIZE, workLabel(q));
      if (stale()) return;
      lastGrid = { cols: c.cols, rows: r.rows, order: c.order };
      renderGrid(c.cols, r.rows, c.order);
      // Keep search counts in step with what's on screen (not on page turns).
      if (srch.text) {
        const sig = [c.sql, JSON.stringify(c.params), srch.text, srch.mode].join('\u0000');
        if (!srch.sig.startsWith(sig)) { srch.full = false; scheduleSearch(50); }
      }
      lastPage = { rows: r.rows.length, more: r.more };
      renderPager();
    } catch (e) {
      if (stale()) return;
      if (e instanceof CancelledError && userCancelled.delete('page')) showStopped(refresh);
      else if (!(e instanceof CancelledError)) showResultError(e.message);
    } finally {
      clearTimeout(loadingTimer);
      if (!stale()) setLoading(false);
    }
  }

  function showCount() {
    $('result-count').textContent = `${fmt(lastTotal)} ${lastTotal === 1 ? 'row' : 'rows'}`;
    renderPager();
  }

  const TYPE_BADGE = { INTEGER: '123', REAL: '1.2', NUMERIC: '#', TEXT: 'ABC', NONE: 'any' };

  // cols: pipeline columns (explore) or plain names (SQL tab, not clickable).
  function renderGrid(cols, rows, order) {
    const interactive = cols.length && typeof cols[0] === 'object';
    const head = h('tr', null, cols.map((c) => {
      if (!interactive) return h('th', null, c);
      const sorted = order && order.find((o) => o.col === c.name);
      const pk = c.prov && P.primaryKey(c.prov.table, schema) === c.prov.column;
      const parent = P.parentOf(c, schema);
      const th = h('th', { class: 'col-head', title: `${c.name}${c.prov ? `\nfrom ${c.prov.table}.${c.prov.column}` : ''}\nClick for options` },
        h('span', { class: 'th-inner' },
          h('span', { class: 'type-badge' }, TYPE_BADGE[c.affinity] || ''),
          pk ? h('span', { class: 'key-badge', title: 'Primary key: click a value to see where it’s used' }, 'PK') : null,
          parent ? h('span', { class: 'key-badge fk', title: `Links to ${parent.table}` }, 'FK') : null,
          h('span', { class: 'th-name' }, c.name),
          sorted ? h('span', { class: 'arrow', title: sorted.dir === 'desc' ? 'Sorted descending' : 'Sorted ascending' }, icon(sorted.dir === 'desc' ? 'down' : 'up')) : null,
          parent ? h('button', {
            class: 'expand', title: `Expand ${parent.table}: bring in its columns`,
            onclick: (e) => { e.stopPropagation(); expandPicker(e.currentTarget, P.outgoingLinks([c], schema)[0]); },
          }, icon('plus')) : null,
          h('span', { class: 'caret' }, icon('chevron'))));
      th.addEventListener('click', () => columnMenu(th, c));
      return th;
    }));
    const body = rows.length
      ? rows.map((row) => h('tr', null, row.map((v, k) => {
        const td = cell(v, interactive ? srch : null);
        if (interactive) {
          td.classList.add('clickable');
          td.addEventListener('click', () => cellMenu(td, cols[k], v, row, cols));
        }
        return td;
      })))
      : [h('tr', null, h('td', { class: 'empty', colSpan: cols.length || 1 }, 'No rows match.'))];
    $('grid').replaceChildren(h('thead', null, head), h('tbody', null, body));
  }

  function cell(v, hl) {
    if (v === null || v === undefined) return h('td', { class: 'null' }, '');
    if (typeof v === 'object' && v.$blob != null) return h('td', { class: 'null' }, `[binary, ${fmt(v.$blob)} bytes]`);
    const numeric = typeof v === 'number' || (typeof v === 'object' && v.$int != null);
    const s = typeof v === 'object' ? String(v.$int ?? v.$text ?? '') : String(v);
    const text = s.length > 200 ? s.slice(0, 200) + '…' : s;
    const td = h('td', { class: numeric ? 'num' : null, title: s.length > 200 ? s.slice(0, 2000) : null });
    const m = hl && hl.text ? matchAt(text, hl.text, hl.mode) : -1;
    if (m < 0) td.textContent = text;
    else {
      td.classList.add('hit');
      td.append(text.slice(0, m), h('mark', null, text.slice(m, m + hl.text.length)), text.slice(m + hl.text.length));
    }
    return td;
  }

  // Where a search matches a displayed value (-1 if it doesn't), mirroring
  // the SQL: contains/starts ignore case, "is exactly" doesn't.
  function matchAt(text, needle, mode) {
    if (mode === 'eq') return text === needle ? 0 : -1;
    const i = text.toLowerCase().indexOf(needle.toLowerCase());
    return mode === 'starts' ? (i === 0 ? 0 : -1) : i;
  }

  function renderPager() {
    const q = Q();
    if (!q || activeId === 'sql') return;
    const from = lastPage.rows ? q.page * PAGE_SIZE + 1 : 0;
    const to = q.page * PAGE_SIZE + lastPage.rows;
    const go = (p) => { q.page = p; refresh(); $('grid-wrap').scrollTop = 0; };
    const multi = q.page > 0 || lastPage.more;
    $('pager').replaceChildren(
      multi ? h('button', { class: 'ghost small', disabled: q.page === 0, onclick: () => go(q.page - 1) }, 'Previous') : '',
      h('span', { class: 'muted small' }, lastPage.rows
        ? `Showing ${fmt(from)}–${fmt(to)}` + (lastTotal != null ? ` of ${fmt(lastTotal)}` : '') : ''),
      multi ? h('button', { class: 'ghost small', disabled: !lastPage.more, onclick: () => go(q.page + 1) }, 'Next') : '');
  }

  function showStopped(retry) {
    $('grid').replaceChildren(h('tbody', null, h('tr', null, h('td', { class: 'empty' },
      'Stopped. ', h('button', { class: 'link', onclick: retry }, 'Try again')))));
    $('pager').replaceChildren();
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
        out += typeof p === 'number' ? String(p) : p && typeof p === 'object' ? String(p.$int ?? p.$text) : "'" + String(p).replace(/'/g, "''") + "'";
        continue;
      }
      out += ch;
    }
    return out;
  }

  // ---------- column heading menu ----------
  function sortBy(col, dir) {
    addStep({ type: 'sort', by: [{ col, dir }] }, { combine: (prev) => (prev.type === 'sort' ? { type: 'sort', by: [{ col, dir }] } : null) });
  }

  function addFilter(cond, edit) {
    addStep({ type: 'filter', match: 'all', conditions: [cond] }, { edit });
  }

  function columnMenu(anchor, col) {
    const q = Q();
    const c = compileView(q);
    const sorted = c.order.find((o) => o.col === col.name);
    const parent = P.parentOf(col, schema);
    const related = P.relatedFor(col, schema);
    const numeric = P.isNumeric(col.affinity);
    menu(anchor, [
      { label: numeric ? 'Sort smallest to largest' : 'Sort A to Z', onclick: () => sortBy(col.name, 'asc') },
      { label: numeric ? 'Sort largest to smallest' : 'Sort Z to A', onclick: () => sortBy(col.name, 'desc') },
      sorted ? { label: 'Clear sort', onclick: () => addStep({ type: 'sort', by: [] }, { combine: (prev) => (prev.type === 'sort' ? { type: 'sort', by: [] } : null) }) } : null,
      '-',
      { label: 'Filter by values…', hint: 'tick the values to keep', onclick: () => valuesFilter(anchor, col) },
      { label: numeric ? 'Filter by a range…' : 'Filter by text…', hint: numeric ? 'greater than, between…' : 'contains, starts with…',
        onclick: () => addFilter({ col: col.name, op: numeric ? 'gte' : 'contains', value: '' }, true) },
      { label: 'Remove empty rows', onclick: () => addFilter({ col: col.name, op: 'notEmpty' }) },
      '-',
      { label: 'Group by this column', hint: 'number of rows for each value', onclick: () => addStep({ type: 'group', by: [col.name], measures: [{ fn: 'count' }] }, { edit: true }) },
      { label: 'Rename…', onclick: async () => {
        const to = await askText(anchor, `Rename “${col.name}” to`, col.name, 'Rename');
        if (to && to.trim() && to.trim() !== col.name) addStep({ type: 'rename', from: col.name, to: to.trim() });
      } },
      { label: 'Remove this column', onclick: () => addStep({ type: 'remove', cols: [col.name] },
        { combine: (prev) => (prev.type === 'remove' ? { type: 'remove', cols: prev.cols.concat(col.name) } : null) }) },
      { label: 'Remove other columns', onclick: () => addStep({ type: 'columns', keep: [col.name] }) },
      parent || related.length ? '-' : null,
      parent ? { label: `Expand ${parent.table}…`, hint: 'bring in its columns', onclick: () => expandPicker(anchor, P.outgoingLinks([col], schema)[0]) } : null,
      ...related.slice(0, 8).map((r) => ({
        label: `Count matching ${r.table}`, hint: `adds a column: how many ${r.table} rows have this ${r.column}`,
        onclick: () => addStep({ type: 'lookup', source: { table: r.table }, on: [[col.name, r.column]], measures: [{ fn: 'count' }] }),
      })),
      related.length ? { label: 'Add other figures from a related table…', onclick: () => combineDialog('lookup', null, { col: col.name, related: related[0] }) } : null,
    ], col.name);
  }

  // Excel-style "tick the values to keep", with counts. Typing in the search
  // box searches the whole column in the database, not just the values listed.
  function valuesFilter(anchor, col) {
    const q = Q();
    const vi = viewIndex(q);
    const existing = q.steps[vi] && q.steps[vi].type === 'filter' && q.steps[vi].conditions.length === 1 &&
      q.steps[vi].conditions[0].col === col.name && q.steps[vi].conditions[0].op === 'in' && Array.isArray(q.steps[vi].conditions[0].value)
      ? q.steps[vi] : null;
    // When changing an existing value filter, list the values going into it.
    const source = existing ? P.compile(q.steps, schema, vi - 1, ctxFor(q)) : compileView(q);
    const key = (v) => JSON.stringify(v);
    const exCond = existing && existing.conditions[0];
    const exSet = exCond ? new Set(exCond.value.map(key)) : null;
    let top = [];       // the most common values (no search)
    let found = null;   // values matching the search, or null when not searching
    let more = false;   // more values exist than are listed
    let full = false;
    let sortMode = 'count';
    let searchTimer = null;
    let searchSeq = 0;

    const search = h('input', { type: 'search', placeholder: 'Search all values…', oninput: () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 300);
    } });
    const all = h('input', { type: 'checkbox', checked: true, onchange: (e) => { shown().forEach((en) => { en.checked = e.target.checked; }); draw(); } });
    const list = h('div', { class: 'check-list values' }, h('p', { class: 'muted pad' }, 'Loading values…'));
    const note = h('div', { class: 'muted small' });
    const sortBtn = h('button', { class: 'ghost small', onclick: () => { sortMode = sortMode === 'count' ? 'az' : 'count'; draw(); } });
    const shown = () => found || top;

    const draw = () => {
      sortBtn.textContent = sortMode === 'count' ? 'Most common first' : 'A to Z';
      const items = shown().slice().sort(sortMode === 'count' ? (a, b) => b.n - a.n
        : (a, b) => display(a.v).localeCompare(display(b.v), undefined, { numeric: true }));
      all.checked = items.length > 0 && items.every((en) => en.checked);
      list.replaceChildren(...items.map((en) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: en.checked, onchange: (e) => { en.checked = e.target.checked; all.checked = shown().every((x) => x.checked); } }),
        h('span', { class: 'value' + (en.v === null ? ' muted' : '') }, display(en.v, 80)),
        h('span', { class: 'n' }, fmt(en.n)))));
      if (!items.length) list.replaceChildren(h('p', { class: 'muted pad' }, found ? 'No values match.' : 'No values.'));
      const parts = [];
      if (found) {
        parts.push(`${more ? 'The 1,000 most common matching values' : `${fmt(found.length)} matching value${found.length === 1 ? '' : 's'}`}, from all rows. Only the ticked ones will be kept.`);
      } else {
        const sampled = !full && (lastTotal == null || lastTotal > VALUES_SAMPLE);
        parts.push(more ? 'The 1,000 most common values' : `${fmt(top.length)} different values`,
          sampled ? ` in the first ${fmt(VALUES_SAMPLE)} rows. ` : '. ');
        if (sampled) parts.push(h('button', { class: 'link', onclick: () => { full = true; load(); } }, 'Check all rows'));
        if (more) parts.push(' Search to find others.');
      }
      note.replaceChildren(...parts);
    };

    const load = async () => {
      list.replaceChildren(h('p', { class: 'muted pad' }, full ? 'Reading every row…' : 'Loading values…'));
      try {
        const r = await query(
          `SELECT v, COUNT(*) FROM (SELECT ${qi(col.name)} AS v FROM (${source.unsortedSql})${full ? '' : ` LIMIT ${VALUES_SAMPLE}`}) GROUP BY v ORDER BY 2 DESC LIMIT 1001`,
          source.params, 'values', 1001, 'Reading values');
        const had = new Map(top.map((en) => [key(en.v), en.checked]));
        more = r.more || r.rows.length > 1000;
        top = r.rows.slice(0, 1000).map(([v, n]) => ({
          v, n,
          checked: had.has(key(v)) ? had.get(key(v)) : exSet ? (exCond.negate ? !exSet.has(key(v)) : exSet.has(key(v))) : true,
        }));
        if (!found) draw();
      } catch (e) {
        if (!(e instanceof CancelledError)) list.replaceChildren(h('p', { class: 'error' }, e.message));
      }
    };

    const runSearch = async () => {
      const text = search.value.trim();
      const seq = ++searchSeq;
      if (!text) { found = null; more = top.length >= 1000; draw(); return; }
      list.replaceChildren(h('p', { class: 'muted pad' }, 'Searching all rows…'));
      try {
        const { sql, params } = P.valueSearchQuery(source, col.name, text, 'contains', 1000);
        const r = await query(sql, params, 'values', 1001, 'Searching values');
        if (seq !== searchSeq) return;
        more = r.more || r.rows.length > 1000;
        found = r.rows.slice(0, 1000).map(([v, n]) => ({ v, n, checked: true })); // like Excel: matches start ticked
        draw();
      } catch (e) {
        if (seq === searchSeq && !(e instanceof CancelledError)) list.replaceChildren(h('p', { class: 'error' }, e.message));
      }
    };

    const apply = () => {
      closeLayer();
      let cond;
      if (found) {
        // Searching: keep exactly the ticked matches.
        const keep = found.filter((en) => en.checked).map((en) => en.v);
        if (!keep.length) return toast('Tick at least one value to keep.', true);
        cond = { col: col.name, op: 'in', value: keep };
      } else {
        const keep = top.filter((en) => en.checked).map((en) => en.v);
        const drop = top.filter((en) => !en.checked).map((en) => en.v);
        if (!drop.length) { // everything ticked: no filter
          if (existing) deleteStep(vi);
          return;
        }
        // Store whichever list is shorter; "not one of" also keeps values that
        // weren't listed (beyond the 1,000 shown), the way Excel does.
        cond = keep.length <= drop.length
          ? { col: col.name, op: 'in', value: keep }
          : { col: col.name, op: 'in', value: drop, negate: true };
      }
      const step = { type: 'filter', match: 'all', conditions: [cond] };
      if (existing) replaceStep(vi, step);
      else addStep(step);
    };

    popover(anchor, h('div', { class: 'pop-values' },
      h('div', { class: 'row' }, search, sortBtn),
      h('label', { class: 'check select-all' }, all, h('span', null, '(Select all)')),
      list, note,
      h('div', { class: 'row end' },
        h('button', { class: 'ghost small', onclick: closeLayer }, 'Cancel'),
        h('button', { class: 'primary small', onclick: apply }, 'OK'))));
    load();
    search.focus();
  }

  // ---------- search across every column ----------
  // One pass over the rows counts matches in each column; click a column (or
  // "any of these") to turn the search into a filter step.
  const srch = { text: '', mode: 'contains', full: false, seq: 0, timer: null, sig: '' };

  function scheduleSearch(delay) {
    clearTimeout(srch.timer);
    srch.timer = setTimeout(runSearch, delay);
  }

  async function runSearch() {
    const box = $('search-results');
    const q = Q();
    const text = srch.text;
    if (!q || activeId === 'sql' || !text) { box.hidden = true; box.replaceChildren(); srch.sig = ''; return; }
    const c = compileView(q);
    if (!c.cols || (c.error && c.error.step <= viewIndex(q))) { box.hidden = true; return; }
    const sample = srch.full ? 0 : VALUES_SAMPLE;
    srch.sig = [c.sql, JSON.stringify(c.params), text, srch.mode, sample].join('\u0000');
    const seq = ++srch.seq;
    box.hidden = false;
    box.replaceChildren(h('span', { class: 'muted small' }, 'Searching…'));
    try {
      const { sql, params } = P.searchQuery(c, text, srch.mode, sample);
      const r = await query(sql, params, 'search', 1, srch.full ? 'Searching all rows' : 'Searching');
      if (seq !== srch.seq) return;
      const [scanned, ...counts] = r.rows[0];
      const any = counts.pop();
      const hits = c.cols.map((col, i) => ({ col, n: counts[i] })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
      const sampled = sample && scanned >= sample;
      const where = sampled ? ` in the first ${fmt(sample)} rows` : '';
      const modeLabel = P.SEARCH_MODES.find((m) => m.id === srch.mode).label;
      box.replaceChildren(...[
        h('span', { class: 'small' }, hits.length
          ? `Found${where} in ${hits.length} column${hits.length === 1 ? '' : 's'}:`
          : `No matches for “${text}”${where}.`),
        ...hits.map(({ col, n }) => h('button', {
          class: 'chip-btn', title: `Keep rows where ${col.name} ${modeLabel} “${text}”`,
          onclick: () => filterFromSearch([col.name]),
        }, col.name, h('span', { class: 'n' }, fmt(n)))),
        hits.length > 1 ? h('button', {
          class: 'chip-btn any', title: `Keep rows where any of these columns ${modeLabel} “${text}”`,
          onclick: () => filterFromSearch(hits.map((x) => x.col.name)),
        }, 'Any of these', h('span', { class: 'n' }, fmt(any))) : null,
        sampled ? h('button', { class: 'link small', onclick: () => { srch.full = true; runSearch(); } }, 'Search all rows') : null,
        hits.length ? h('span', { class: 'muted small push' }, 'Click to filter') : null,
      ].filter(Boolean));
    } catch (e) {
      if (seq !== srch.seq) return;
      srch.sig = '';
      if (e instanceof CancelledError) {
        box.replaceChildren(h('span', { class: 'muted small' }, 'Search stopped. '),
          h('button', { class: 'link small', onclick: runSearch }, 'Search again'));
      } else {
        box.replaceChildren(h('span', { class: 'error small' }, e.message));
      }
    }
  }

  function filterFromSearch(names) {
    addStep({
      type: 'filter',
      match: names.length > 1 ? 'any' : 'all',
      conditions: names.map((col) => ({ col, op: srch.mode, value: srch.text })),
    });
  }

  // ---------- cell menu ----------
  function cellMenu(td, col, value, row, cols) {
    const shown = display(value, 30);
    const isNull = value === null || value === undefined;
    const numeric = typeof value === 'number' || (value && value.$int != null);
    const dateLike = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value);
    const items = [];
    if (isNull) {
      items.push({ label: 'Keep only empty', onclick: () => addFilter({ col: col.name, op: 'eq', value: null }) });
      items.push({ label: 'Remove empty', onclick: () => addFilter({ col: col.name, op: 'ne', value: null }) });
    } else if (!(value && value.$blob != null)) {
      items.push({ label: 'Keep only this value', onclick: () => addFilter({ col: col.name, op: 'eq', value }) });
      items.push({ label: 'Remove this value', onclick: () => addFilter({ col: col.name, op: 'ne', value }) });
      if (numeric || dateLike) {
        items.push({ label: dateLike ? 'Keep this date or later' : 'Keep this or more', onclick: () => addFilter({ col: col.name, op: 'gte', value }) });
        items.push({ label: dateLike ? 'Keep this date or earlier' : 'Keep this or less', onclick: () => addFilter({ col: col.name, op: 'lte', value }) });
      }
      if (typeof value === 'string') {
        items.push({ label: 'Keep values containing…', onclick: () => addFilter({ col: col.name, op: 'contains', value }, true) });
      }
    }

    if (!isNull) {
      // Follow keys: the parent record, and everywhere else this key is used.
      const parent = P.parentOf(col, schema);
      const related = P.relatedFor(col, schema);
      if (parent || related.length) items.push('-', { heading: `Follow ${shown}` });
      if (parent) {
        items.push({ label: `Open the ${parent.table} record`, hint: `${parent.column} = ${shown}`, onclick: () => inspect(parent.table, parent.column, value) });
      }
      related.slice(0, 10).forEach((r, k) => {
        items.push({
          label: `Find in ${r.table}`, hint: `where ${r.column} = ${shown}`,
          badge: cappedCount(r.table, r.column, value, 'menu' + k), badgeText: '…',
          onclick: () => openQuery([{ type: 'source', table: r.table },
            { type: 'filter', match: 'all', conditions: [{ col: r.column, op: 'eq', value }] }], `${r.table} · ${r.column} = ${display(value, 20)}`),
        });
      });
    }

    // Inspect the whole row, if we can tell which record it is.
    const keyCol = cols.findIndex((c) => c.prov && c.prov.table === (col.prov && col.prov.table) && P.primaryKey(c.prov.table, schema) === c.prov.column);
    const anyKey = keyCol >= 0 ? keyCol : cols.findIndex((c) => c.prov && P.primaryKey(c.prov.table, schema) === c.prov.column);
    if (anyKey >= 0 && row[anyKey] != null) {
      const kc = cols[anyKey];
      items.push('-', { label: `Inspect this ${kc.prov.table} record`, hint: 'all its fields and linked records', onclick: () => inspect(kc.prov.table, kc.prov.column, row[anyKey]) });
    }
    items.push('-', { label: 'Copy value', disabled: isNull, onclick: () => navigator.clipboard.writeText(display(value)).then(() => toast('Copied')) });
    menu(td, items, `${col.name} = ${shown}`);
  }

  // ---------- choose / expand columns ----------
  function checklist(names, checked, labelFor, onChange) {
    const state = new Map(names.map((n) => [n, checked(n)]));
    const changed = () => { if (onChange) onChange(names.filter((n) => state.get(n))); };
    const search = h('input', { type: 'search', placeholder: 'Find a column…', oninput: () => draw() });
    const list = h('div', { class: 'check-list' });
    const draw = () => {
      const s = search.value.trim().toLowerCase();
      list.replaceChildren(...names.filter((n) => n.toLowerCase().includes(s)).map((n) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: state.get(n), onchange: (e) => { state.set(n, e.target.checked); changed(); } }),
        h('span', null, labelFor ? labelFor(n) : n))));
    };
    const setAll = (v) => { names.forEach((n) => state.set(n, v)); draw(); changed(); };
    draw();
    const el = h('div', null,
      h('div', { class: 'row' }, search,
        h('button', { class: 'ghost small', onclick: () => setAll(true) }, 'All'),
        h('button', { class: 'ghost small', onclick: () => setAll(false) }, 'None')),
      list);
    return { el, selected: () => names.filter((n) => state.get(n)) };
  }

  function chooseColumns(anchor, editIndex) {
    const q = Q();
    const at = editIndex ?? viewIndex(q) + 1;
    const cols = colsBefore(q, at);
    const current = editIndex != null ? new Set(q.steps[editIndex].keep) : new Set(compileView(q).cols.map((c) => c.name));
    const pick = checklist(cols.map((c) => c.name), (n) => current.has(n));
    popover(anchor, h('div', { class: 'pop-columns' },
      h('p', { class: 'muted small' }, 'Columns to keep:'), pick.el,
      h('div', { class: 'row end' },
        h('button', { class: 'ghost small', onclick: closeLayer }, 'Cancel'),
        h('button', { class: 'primary small', onclick: () => {
          const keep = pick.selected();
          if (!keep.length) return toast('Keep at least one column.', true);
          closeLayer();
          const step = { type: 'columns', keep };
          if (editIndex != null) replaceStep(editIndex, step);
          else addStep(step, { combine: (prev) => (prev.type === 'columns' || prev.type === 'remove' ? step : null) });
        } }, 'OK'))));
  }

  // Power Query's "expand" on a key column: pick which of the linked table's columns to bring in.
  function expandPicker(anchor, link, editIndex) {
    if (!link) return;
    const q = Q();
    const target = schema.tables[link.table];
    const keys = new Set(link.pairs.map((p) => p[1]));
    const existing = editIndex != null ? q.steps[editIndex] : null;
    const names = target.columns.map((c) => c.name);
    const pick = checklist(names, (n) => (existing ? (existing.columns || names).includes(n) : !keys.has(n)));
    const prefix = h('input', { type: 'checkbox', checked: existing ? existing.prefix !== '' : true });
    popover(anchor, h('div', { class: 'pop-columns' },
      h('p', { class: 'small' }, h('strong', null, link.table), h('span', { class: 'muted' }, ` via ${link.pairs.map((p) => p[0]).join(', ')}`)),
      pick.el,
      h('label', { class: 'check' }, prefix, h('span', { class: 'small' }, `Start new column names with “${link.table}.”`)),
      h('div', { class: 'row end' },
        h('button', { class: 'ghost small', onclick: closeLayer }, 'Cancel'),
        h('button', { class: 'primary small', onclick: () => {
          const columns = pick.selected();
          if (!columns.length) return toast('Choose at least one column.', true);
          closeLayer();
          const step = { type: 'link', table: link.table, pairs: link.pairs, columns };
          if (!prefix.checked) step.prefix = '';
          if (editIndex != null) replaceStep(editIndex, step);
          else addStep(step);
        } }, editIndex != null ? 'Update' : 'Expand'))));
  }

  function linkMenu(anchor) {
    const q = Q();
    const links = P.outgoingLinks(compileView(q).cols || [], schema);
    if (!links.length) return toast('Nothing here links to another table (no foreign keys). Try Merge instead.');
    menu(anchor, links.map((l) => ({
      label: l.table, hint: `via ${l.pairs.map((p) => p[0]).join(', ')}`,
      onclick: () => expandPicker(anchor, l),
    })), 'Expand a linked table');
  }

  // ---------- combine: merge / add figures / append ----------
  function combineDialog(mode, editIndex, preset) {
    const q = Q();
    const at = editIndex ?? viewIndex(q) + 1;
    const left = colsBefore(q, at);
    const existing = editIndex != null ? clone(q.steps[editIndex]) : null;
    const srcKey = (src) => (src.table ? 't:' + src.table : 'q:' + src.query);
    const parseSrc = (k) => (k.startsWith('t:') ? { table: k.slice(2) } : { query: k.slice(2), name: queries.find((x) => x.id === k.slice(2))?.name });

    const st = {
      source: existing ? srcKey(existing.source) : preset ? 't:' + preset.related.table : '',
      on: existing ? existing.on : preset ? [[preset.col, preset.related.column]] : [],
      kind: existing?.kind || 'left',
      columns: existing?.columns || null,     // other table's columns to bring in (null = default)
      leftColumns: existing?.leftColumns ?? null, // this query's columns to keep (null = all)
      note: '',
      prefix: existing ? existing.prefix !== '' : true,
      measures: existing?.measures || [{ fn: 'count' }],
    };
    const rightCols = () => {
      if (!st.source) return [];
      const src = parseSrc(st.source);
      if (src.table) return P.compile([{ type: 'source', table: src.table }], schema).cols || [];
      const other = queries.find((x) => x.id === src.query);
      return other ? P.compile(other.steps, schema, null, ctxFor(other)).cols || [] : [];
    };

    const body = h('div', { class: 'combine' });
    const check = h('div', { class: 'match-check muted small' });
    const titles = { merge: 'Merge', lookup: 'Add figures from a related table', append: 'Append rows' };
    const intro = {
      merge: 'Join another table or query to this one, matching rows on columns you choose.',
      lookup: 'Add a count, total or average from matching rows elsewhere, one figure per row here. Rows are never duplicated.',
      append: 'Stack the rows of another table or query underneath these. Columns are matched by name.',
    };

    const draw = () => {
      const rc = rightCols();
      const sources = h('select', { onchange: (e) => {
        st.source = e.target.value;
        const src = parseSrc(st.source);
        st.on = P.suggestMatches(left, rightCols(), schema, src.table).slice(0, 1);
        if (!st.on.length && left.length && rightCols().length) st.on = [[left[0].name, rightCols()[0].name]];
        st.columns = null;
        st.leftColumns = null;
        st.note = '';
        draw();
      } },
      h('option', { value: '', disabled: true, selected: !st.source }, 'choose…'),
      h('optgroup', { label: 'Tables' }, Object.values(schema.tables).filter((t) => t.type === 'table').map((t) => h('option', { value: 't:' + t.name, selected: st.source === 't:' + t.name }, t.name))),
      Object.values(schema.tables).some((t) => t.type === 'view')
        ? h('optgroup', { label: 'Views' }, Object.values(schema.tables).filter((t) => t.type === 'view').map((t) => h('option', { value: 't:' + t.name, selected: st.source === 't:' + t.name }, t.name))) : null,
      queries.length > 1 ? h('optgroup', { label: 'Open queries' }, queries.filter((x) => x.id !== q.id).map((x) => h('option', { value: 'q:' + x.id, selected: st.source === 'q:' + x.id }, x.name))) : null);

      const parts = [h('p', { class: 'muted' }, intro[mode]), h('div', { class: 'field' }, h('label', null, mode === 'append' ? 'Append' : 'With'), sources)];

      if (st.source && mode !== 'append') {
        const pairs = h('div', { class: 'pairs' }, st.on.map((pair, k) => h('div', { class: 'row' },
          colSelect(left, pair[0], (v) => { pair[0] = v; draw(); }, 'column here…'),
          h('span', { class: 'eq' }, '='),
          colSelect(rc, pair[1], (v) => { pair[1] = v; draw(); }, 'column there…'),
          st.on.length > 1 ? h('button', { class: 'x', onclick: () => { st.on.splice(k, 1); draw(); } }, icon('close')) : null)));
        const sugg = P.suggestMatches(left, rc, schema, parseSrc(st.source).table);
        parts.push(h('div', { class: 'field' }, h('label', null, 'Match rows where'), pairs,
          h('div', { class: 'row' },
            h('button', { class: 'ghost small', onclick: () => { st.on.push(['', '']); draw(); } }, '+ Match on another column too'),
            sugg.length > 1 ? h('span', { class: 'muted small' }, 'Suggested: ', sugg.slice(0, 4).map(([a, b]) => h('button', { class: 'link small', onclick: () => { st.on = [[a, b]]; draw(); } }, `${a} = ${b}`)).reduce((acc, el) => acc.concat(acc.length ? [', ', el] : [el]), [])) : null),
          check));
        testMatches();
      }

      if (st.source && mode === 'merge') {
        const kinds = P.JOIN_KINDS.filter((k) => !k.minSqlite || sqliteAtLeast(k.minSqlite));
        parts.push(h('div', { class: 'field' }, h('label', null, 'Keep'),
          h('div', { class: 'kinds' }, kinds.map((k) => h('label', { class: 'kind' + (st.kind === k.id ? ' on' : '') },
            h('input', { type: 'radio', name: 'kind', checked: st.kind === k.id, onchange: () => { st.kind = k.id; st.note = ''; draw(); } }),
            h('span', null, h('strong', null, k.label), h('span', { class: 'muted small' }, k.hint)))))));
        if (st.kind !== 'anti') {
          const matched = new Set(st.on.map((p) => p[1]));
          const rightNames = rc.map((c) => c.name);
          const leftNames = left.map((c) => c.name);
          if (!st.columns) st.columns = rightNames.filter((n) => !matched.has(n));
          const keptLeft = st.leftColumns ?? leftNames;
          const srcName = P.sourceName(parseSrc(st.source));
          const which = !keptLeft.length ? 'right' : !st.columns.length ? 'left' : 'both';
          const shortcut = (id, label, apply) => h('button', {
            class: 'seg' + (which === id ? ' on' : ''), type: 'button',
            onclick: () => { apply(); draw(); },
          }, label);
          const leftPick = checklist(leftNames, (n) => keptLeft.includes(n), null,
            (sel) => { st.leftColumns = sel.length === leftNames.length ? null : sel; });
          const rightPick = checklist(rightNames, (n) => st.columns.includes(n), null,
            (sel) => { st.columns = sel; });
          parts.push(h('div', { class: 'field' }, h('label', null, 'Keep columns from'),
            h('div', { class: 'segmented' },
              shortcut('both', 'Both', () => { st.leftColumns = null; st.columns = rightNames.filter((n) => !matched.has(n)); st.note = ''; }),
              shortcut('right', `Only ${srcName}`, () => {
                st.leftColumns = [];
                st.columns = rightNames.slice();
                st.prefix = false;
                if (st.kind === 'left') {
                  st.kind = 'inner';
                  st.note = `Switched to “Only rows that match”, so rows here with no ${srcName} don’t leave empty rows.`;
                }
              }),
              shortcut('left', 'Only this query', () => {
                st.leftColumns = null;
                st.columns = [];
                st.note = st.kind === 'inner' ? 'This keeps rows here that have a match, without adding any columns.' : '';
              })),
            st.note ? h('p', { class: 'muted small' }, st.note) : null,
            h('div', { class: 'two-lists' },
              h('div', null, h('div', { class: 'list-title' }, `This query (${keptLeft.length} of ${leftNames.length})`), leftPick.el),
              h('div', null, h('div', { class: 'list-title' }, `${srcName} (${st.columns.length} of ${rightNames.length})`), rightPick.el)),
            h('label', { class: 'check' },
              h('input', { type: 'checkbox', checked: st.prefix, onchange: (e) => { st.prefix = e.target.checked; } }),
              h('span', { class: 'small' }, `Start new column names with “${srcName}.”`))));
        }
      }

      if (st.source && mode === 'lookup') {
        const mbox = h('div');
        measureRows(mbox, st.measures, rc, 'Show', () => {}, draw);
        parts.push(h('div', { class: 'field' }, h('label', null, 'Figures to add'), mbox));
      }

      if (st.source && mode === 'append') {
        const leftNames = new Set(left.map((c) => c.name));
        const same = rc.filter((c) => leftNames.has(c.name)).map((c) => c.name);
        const extra = rc.filter((c) => !leftNames.has(c.name)).map((c) => c.name);
        const missing = left.filter((c) => !rc.some((r) => r.name === c.name)).map((c) => c.name);
        parts.push(h('div', { class: 'append-info small' },
          h('p', null, `${same.length} column${same.length === 1 ? ' matches' : 's match'} by name${same.length ? ': ' + same.slice(0, 8).join(', ') + (same.length > 8 ? '…' : '') : ''}.`),
          extra.length ? h('p', null, `New columns (empty for the rows already here): ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? '…' : ''}`) : null,
          missing.length ? h('p', null, `Columns only here (empty for the appended rows): ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`) : null,
          !same.length ? h('p', { class: 'error' }, 'No columns have the same name, so the rows won’t line up. Rename columns first so they match.') : null));
      }
      body.replaceChildren(...parts);
    };

    // Power Query shows how many rows find a match; we check the first 1,000.
    let checkTimer = null;
    const testMatches = () => {
      clearTimeout(checkTimer);
      const src = st.source && parseSrc(st.source);
      if (!src || !st.on.length || st.on.some(([a, b]) => !a || !b)) { check.textContent = ''; return; }
      check.textContent = 'Checking matches…';
      checkTimer = setTimeout(async () => {
        const lq = P.compile(q.steps, schema, at - 1, ctxFor(q));
        const right = src.table ? P.compile([{ type: 'source', table: src.table }], schema)
          : P.compile(queries.find((x) => x.id === src.query).steps, schema, null, ctxFor(queries.find((x) => x.id === src.query)));
        if (lq.error || right.error) { check.textContent = ''; return; }
        const keys = st.on.map(([, b], i) => `${qi(b)} AS k${i}`).join(', ');
        const on = st.on.map(([a], i) => `p.${qi(a)} = j.k${i}`).join(' AND ');
        try {
          const r = await query(
            `SELECT COUNT(*), COUNT(j.k0) FROM (SELECT * FROM (${lq.unsortedSql}) LIMIT 1000) AS p LEFT JOIN (SELECT DISTINCT ${keys} FROM (${right.unsortedSql})) AS j ON ${on}`,
            [...lq.params, ...right.params], 'matchcheck', 1);
          const [n, m] = r.rows[0];
          check.className = 'match-check small ' + (m === 0 ? 'bad' : 'good');
          const of = n < 1000 ? `${fmt(n)} rows here` : `the first ${fmt(n)} rows here`;
          check.textContent = n === 0 ? 'There are no rows here yet.'
            : m === 0 ? `None of ${of} find a match. Check the columns.`
              : n === 1 ? (m ? 'The 1 row here finds a match.' : 'The 1 row here has no match.')
                : m === n ? `All ${of.replace('the first ', '')} find a match.` : `${fmt(m)} of ${of} find a match.`;
        } catch (e) {
          if (!(e instanceof CancelledError)) { check.className = 'match-check small bad'; check.textContent = e.message; }
        }
      }, 250);
    };

    const ok = () => {
      if (!st.source) return toast('Choose a table or query first.', true);
      const source = parseSrc(st.source);
      let step;
      if (mode === 'append') step = { type: 'append', source };
      else {
        const on = st.on.filter(([a, b]) => a && b);
        if (!on.length) return toast('Choose which columns to match on.', true);
        if (mode === 'merge') {
          step = { type: 'merge', source, kind: st.kind, on };
          if (st.kind !== 'anti') {
            step.columns = st.columns || [];
            if (st.leftColumns) step.leftColumns = st.leftColumns;
            if (!step.columns.length && step.leftColumns && !step.leftColumns.length) return toast('Choose at least one column to keep.', true);
          }
          if (!st.prefix) step.prefix = '';
        } else {
          step = { type: 'lookup', source, on, measures: st.measures };
        }
      }
      closeDialog();
      if (editIndex != null) replaceStep(editIndex, step);
      else addStep(step);
    };

    dialog(titles[mode], body, [
      h('button', { class: 'ghost', onclick: closeDialog }, 'Cancel'),
      h('button', { class: 'primary', onclick: ok }, editIndex != null ? 'Update step' : 'Add step'),
    ], 'combine-modal');
    draw();
  }

  // ---------- record inspector ----------
  const insp = { history: [], index: -1, seq: 0 };

  function inspect(table, column, value) {
    insp.history = insp.history.slice(0, insp.index + 1);
    insp.history.push({ table, column, value });
    insp.index = insp.history.length - 1;
    renderInspector();
  }

  function closeInspector() {
    $('inspector').hidden = true;
    insp.history = [];
    insp.index = -1;
    document.body.classList.remove('inspecting');
  }

  async function renderInspector() {
    const el = $('inspector');
    const cur = insp.history[insp.index];
    if (!cur) return closeInspector();
    const seq = ++insp.seq;
    const stale = () => seq !== insp.seq;
    el.hidden = false;
    document.body.classList.add('inspecting');
    const { table, column, value } = cur;
    const shown = display(value, 40);
    const go = (d) => { insp.index += d; renderInspector(); };
    const body = h('div', { class: 'insp-body' }, h('p', { class: 'muted pad' }, 'Loading…'));
    el.replaceChildren(
      h('div', { class: 'insp-head' },
        h('button', { class: 'icon', title: 'Back', disabled: insp.index <= 0, onclick: () => go(-1) }, icon('left')),
        h('button', { class: 'icon', title: 'Forward', disabled: insp.index >= insp.history.length - 1, onclick: () => go(1) }, icon('right')),
        h('div', { class: 'insp-title' }, h('strong', null, table), h('span', { class: 'muted small' }, `${column} = ${shown}`)),
        h('button', { class: 'icon x', title: 'Close', onclick: closeInspector }, icon('close'))),
      h('div', { class: 'insp-actions' },
        h('button', { class: 'ghost small', onclick: () => openQuery([{ type: 'source', table },
          { type: 'filter', match: 'all', conditions: [{ col: column, op: 'eq', value }] }], `${table} · ${column} = ${display(value, 20)}`) }, 'Open as a query')),
      body);

    let rec;
    try {
      rec = await query(`SELECT * FROM ${qi(table)} WHERE ${qi(column)} = ? LIMIT 2`, [value], 'insp', 2);
    } catch (e) {
      if (!stale() && !(e instanceof CancelledError)) body.replaceChildren(h('p', { class: 'error' }, e.message));
      return;
    }
    if (stale()) return;
    if (!rec.rows.length) { body.replaceChildren(h('p', { class: 'muted pad' }, `No ${table} record has ${column} = ${shown}.`)); return; }
    const row = rec.rows[0];
    const fields = h('table', { class: 'fields' }, rec.columns.map((name, k) => {
      const v = row[k];
      const parent = v != null ? P.parentOf({ prov: { table, column: name } }, schema) : null;
      return h('tr', null, h('th', null, name), h('td', { class: v == null ? 'null' : typeof v === 'number' ? 'num' : '' },
        parent ? h('button', { class: 'link', title: `Open ${parent.table} record`, onclick: () => inspect(parent.table, parent.column, v) }, display(v, 120), icon('link')) : display(v, 300)));
    }));
    const sections = [];
    if (rec.more) sections.push(h('p', { class: 'muted small' }, `More than one record has ${column} = ${shown}; showing the first.`));
    sections.push(h('h3', null, 'Fields'), fields);

    // Everything that points at this record.
    const refs = [];
    rec.columns.forEach((name, k) => {
      if (row[k] == null) return;
      for (const r of P.referencesTo(table, name, schema)) refs.push({ ...r, key: name, value: row[k] });
    });
    if (refs.length) sections.push(h('h3', null, 'Linked records'));
    else sections.push(h('p', { class: 'muted small' }, 'No other tables link to this record.'));
    body.replaceChildren(...sections);

    refs.slice(0, 12).forEach((r, k) => {
      const count = h('span', { class: 'muted small' }, '…');
      const preview = h('div', { class: 'insp-preview' }, h('p', { class: 'muted small pad' }, 'Loading…'));
      const open = () => openQuery([{ type: 'source', table: r.table },
        { type: 'filter', match: 'all', conditions: [{ col: r.column, op: 'eq', value: r.value }] }], `${r.table} · ${r.column} = ${display(r.value, 20)}`);
      body.append(h('div', { class: 'insp-rel' },
        h('div', { class: 'insp-rel-head' }, h('strong', null, r.table), h('span', { class: 'muted small' }, ` · ${r.column}`), h('span', { class: 'spacer' }), count,
          h('button', { class: 'ghost small', onclick: open }, 'Open all')),
        preview));
      cappedCount(r.table, r.column, r.value, 'ic' + k).then((t) => { if (!stale()) count.textContent = t; }).catch(() => {});
      query(`SELECT * FROM ${qi(r.table)} WHERE ${qi(r.column)} = ? LIMIT 5`, [r.value], 'ip' + k, 5).then((res) => {
        if (stale()) return;
        if (!res.rows.length) { preview.replaceChildren(h('p', { class: 'muted small pad' }, 'None.')); return; }
        const pk = P.primaryKey(r.table, schema);
        const pkIdx = res.columns.indexOf(pk);
        preview.replaceChildren(h('table', { class: 'grid mini' },
          h('thead', null, h('tr', null, res.columns.map((c) => h('th', null, c)))),
          h('tbody', null, res.rows.map((rw) => {
            const tr = h('tr', { class: pkIdx >= 0 ? 'clickable' : '', title: pkIdx >= 0 ? 'Inspect this record' : '' }, rw.map(cell));
            if (pkIdx >= 0) tr.addEventListener('click', () => inspect(r.table, pk, rw[pkIdx]));
            return tr;
          }))),
        ...(res.more ? [h('button', { class: 'link small', onclick: open }, 'See all')] : []));
      }).catch((e) => { if (!stale() && !(e instanceof CancelledError)) preview.replaceChildren(h('p', { class: 'error small' }, e.message)); });
    });
  }

  // ---------- SQL tab ----------
  const userSql = () => $('sql-input').value.trim().replace(/;+\s*$/, '');

  function setSqlMode() {
    activeId = 'sql';
    closeLayer();
    save();
    renderAll();
    $('grid').replaceChildren();
    $('pager').replaceChildren();
    $('result-count').textContent = '';
    showResultError(null);
    if (!$('sql-input').value.trim()) {
      const t = Object.keys(schema.tables)[0];
      if (t) $('sql-input').value = `SELECT * FROM ${qi(t)}`;
    }
    $('sql-input').focus();
    runSql();
  }

  async function runSql() {
    showResultError(null);
    const sql = userSql();
    if (!sql) return;
    const seq = ++refreshSeq;
    const stale = () => seq !== refreshSeq || activeId !== 'sql';
    $('result-count').replaceChildren(h('span', { class: 'muted' }, 'Running…'));
    setLoading(true);
    try {
      const r = await query(sql, [], 'sql', SQL_PREVIEW_ROWS, 'Running query');
      if (stale()) return;
      renderGrid(r.columns, r.rows);
      $('pager').replaceChildren();
      if (!r.more) {
        $('result-count').textContent = `${fmt(r.rows.length)} ${r.rows.length === 1 ? 'row' : 'rows'}`;
        return;
      }
      $('result-count').textContent = `Showing the first ${fmt(r.rows.length)} rows (counting the rest…)`;
      query(`SELECT COUNT(*) FROM (${sql})`, [], 'sqlcount', 1, 'Counting rows').then((c) => {
        if (!stale()) $('result-count').textContent = `${fmt(c.rows[0][0])} rows · showing the first ${fmt(r.rows.length)}; the download includes them all`;
      }).catch(() => {
        if (!stale()) $('result-count').textContent = `Showing the first ${fmt(r.rows.length)} rows; the download includes them all`;
      });
    } catch (e) {
      if (stale()) return;
      if (e instanceof CancelledError && userCancelled.delete('sql')) { showStopped(runSql); $('result-count').textContent = ''; }
      else if (!(e instanceof CancelledError)) showResultError(e.message);
    } finally {
      if (!stale()) setLoading(false);
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
    panel.hidden = false;
    status.textContent = 'Starting export…';
    bar.style.width = '0%';
    bar.parentElement.classList.toggle('indeterminate', !expectedRows);
    try {
      const { token } = await api('export', { id: db.id, sheets, filename });
      $('btn-export-cancel').onclick = () => { api(`export/${token}/cancel`, {}).catch(() => {}); status.textContent = 'Cancelling…'; };
      for (;;) {
        await new Promise((r) => setTimeout(r, 400));
        const s = await api(`export/${token}`);
        if (s.state === 'running') {
          status.textContent = `Writing ${sheets.length > 1 && s.sheet ? `“${s.sheet}”… ` : ''}${fmt(s.rows)} rows` +
            (expectedRows ? ` of ${fmt(expectedRows)}` : '') + ' so far';
          if (expectedRows) bar.style.width = Math.min(100, (s.rows / expectedRows) * 100).toFixed(1) + '%';
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
    if (activeId === 'sql') {
      const sql = userSql();
      if (sql) await startExport([{ name: 'Query', sql, params: [] }], `query-${today()}.xlsx`, null);
      return;
    }
    const q = Q();
    if (!q) return;
    const c = compileView(q);
    if (c.error && c.error.step <= viewIndex(q)) return toast('Fix the step with a problem first.', true);
    await startExport([{ name: q.name, sql: c.sql, params: c.params, columns: c.cols.map((x) => x.name) }], `${q.name}-${today()}.xlsx`, lastTotal);
  });

  const exportAll = withErrors(async () => {
    const tables = Object.values(schema.tables).filter((t) => t.type === 'table');
    if (!tables.length) return toast('There are no tables to export.', true);
    const known = tables.every((t) => t.rowCount != null);
    const total = known ? tables.reduce((n, t) => n + t.rowCount, 0) : null;
    if (total != null && total > 5_000_000 &&
        !confirm(`That's ${fmt(total)} rows across ${tables.length} tables, which will make a very large Excel file and take a while. Continue?`)) return;
    await startExport(tables.map((t) => ({ name: t.name, sql: `SELECT * FROM ${qi(t.name)}`, params: [] })),
      `${db.name.replace(/\.[^.]+$/, '')}-${today()}.xlsx`, total);
  });

  // ---------- wiring ----------
  function needQuery(fn) {
    return (e) => { if (Q()) fn(e); };
  }

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
    $('btn-reload').addEventListener('click', withErrors(async () => { await openPath(db.path, true); toast('Reloaded'); }));
    $('btn-export-all').addEventListener('click', exportAll);
    $('btn-export').addEventListener('click', exportCurrent);
    $('table-search').addEventListener('input', renderTableList);

    $('btn-run-sql').addEventListener('click', runSql);
    $('btn-activity-cancel').addEventListener('click', cancelActivity);
    $('search-mode').replaceChildren(...P.SEARCH_MODES.map((m) => h('option', { value: m.id }, m.label)));
    const searchChanged = (delay) => {
      srch.text = $('search-input').value.trim();
      srch.mode = $('search-mode').value;
      srch.full = false;
      if (lastGrid && activeId !== 'sql') renderGrid(lastGrid.cols, lastGrid.rows, lastGrid.order);
      scheduleSearch(delay);
    };
    $('search-input').addEventListener('input', () => searchChanged(400));
    $('search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchChanged(0); });
    $('search-mode').addEventListener('change', () => searchChanged(0));
    $('sql-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runSql(); }
    });

    // Toolbar
    $('t-columns').addEventListener('click', needQuery((e) => chooseColumns(e.currentTarget)));
    $('t-link').addEventListener('click', needQuery((e) => linkMenu(e.currentTarget)));
    $('t-filter').addEventListener('click', needQuery(() => {
      const cols = compileView(Q()).cols || [];
      addFilter({ col: cols[0]?.name, op: 'contains', value: '' }, true);
    }));
    $('t-distinct').addEventListener('click', needQuery(() => addStep({ type: 'distinct' })));
    $('t-top').addEventListener('click', needQuery(() => addStep({ type: 'top', n: 100 }, { edit: true })));
    $('t-group').addEventListener('click', needQuery(() => {
      const cols = compileView(Q()).cols || [];
      const guess = cols.find((c) => c.affinity === 'TEXT' && !/(^|_)id$/i.test(c.name));
      addStep({ type: 'group', by: guess ? [guess.name] : [], measures: [{ fn: 'count' }] }, { edit: true });
    }));
    $('t-merge').addEventListener('click', needQuery(() => combineDialog('merge')));
    $('t-lookup').addEventListener('click', needQuery(() => combineDialog('lookup')));
    $('t-append').addEventListener('click', needQuery(() => combineDialog('append')));

    $('btn-undo').addEventListener('click', undo);
    $('btn-duplicate').addEventListener('click', needQuery(() => { const q = Q(); openQuery(clone(q.steps), q.name); }));
    $('btn-show-sql').addEventListener('click', () => {
      sqlShown = !sqlShown;
      $('sql-preview').hidden = !sqlShown;
      $('btn-show-sql').textContent = sqlShown ? 'Hide SQL' : 'Show SQL';
    });
    $('btn-edit-sql').addEventListener('click', () => {
      $('sql-input').value = $('sql-preview-text').textContent;
      setSqlMode();
    });

    document.addEventListener('keydown', (e) => {
      const typing = e.target.closest('input, textarea, select');
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey && !typing && Q()) { e.preventDefault(); undo(); }
      if (e.key === 'Escape' && !document.querySelector('.layer, .modal-backdrop') && !$('inspector').hidden) closeInspector();
    });

    renderRecent();
    if (canOpenByPath) {
      api('startup').then((d) => {
        samplePath = d.samplePath;
        $('btn-sample').hidden = !samplePath;
        if (d.path) return withErrors(openPath)(d.path);
      }).catch(() => {});
    } else {
      $('btn-sample').hidden = true;
    }
  }

  init();
})();
