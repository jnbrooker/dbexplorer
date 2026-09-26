// The query engine: a query is a list of steps (like Power Query's "Applied
// steps"), applied in order. Each step wraps the previous one's SQL, so steps
// mean exactly what they say in sequence ("filter after grouping" filters the
// groups). SQLite flattens the nesting, so filters still reach the indexes.
//
// Every column carries where it came from ({table, column}) so the app can
// follow foreign keys from any column, even after renames, links or grouping.
//
// Nothing typed by the user is ever pasted into SQL text: names are quoted
// identifiers and values are bound parameters.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DBXPipeline = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const qi = (name) => '"' + String(name).replace(/"/g, '""') + '"';

  // SQLite's column affinity rules (https://sqlite.org/datatype3.html#determination_of_column_affinity)
  function affinity(declared) {
    const t = String(declared || '').toUpperCase();
    if (t.includes('INT')) return 'INTEGER';
    if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT';
    if (t === '' || t.includes('BLOB')) return 'NONE';
    if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL';
    return 'NUMERIC';
  }
  const isNumeric = (aff) => aff === 'INTEGER' || aff === 'REAL' || aff === 'NUMERIC';

  const OPERATORS = [
    { id: 'contains', label: 'contains', arity: 1 },
    { id: 'notContains', label: 'does not contain', arity: 1 },
    { id: 'eq', label: 'is exactly', arity: 1, symbol: '=' },
    { id: 'ne', label: 'is not', arity: 1, symbol: '≠' },
    { id: 'starts', label: 'starts with', arity: 1 },
    { id: 'ends', label: 'ends with', arity: 1 },
    { id: 'in', label: 'is one of', arity: 'list' },
    { id: 'gt', label: 'is greater than', arity: 1, symbol: '>' },
    { id: 'gte', label: 'is at least', arity: 1, symbol: '≥' },
    { id: 'lt', label: 'is less than', arity: 1, symbol: '<' },
    { id: 'lte', label: 'is at most', arity: 1, symbol: '≤' },
    { id: 'between', label: 'is between', arity: 2 },
    { id: 'empty', label: 'is empty', arity: 0 },
    { id: 'notEmpty', label: 'is not empty', arity: 0 },
  ];

  const MEASURES = [
    { id: 'count', label: 'Number of rows', needsColumn: false },
    { id: 'countDistinct', label: 'Number of different', needsColumn: true },
    { id: 'sum', label: 'Total of', needsColumn: true },
    { id: 'avg', label: 'Average of', needsColumn: true },
    { id: 'min', label: 'Smallest', needsColumn: true },
    { id: 'max', label: 'Largest', needsColumn: true },
  ];

  class StepError extends Error {}

  const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);

  // A typed value only becomes a number if doing so loses nothing ("007" stays text).
  function asNumber(v) {
    const s = String(v).trim();
    if (s === '' || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) && String(n) === s.replace(/^\+/, '') ? n : null;
  }

  // Values picked by clicking a cell keep their real type (number, text, or a
  // {$int} big integer); values typed into a box are strings and get coerced.
  function bindValue(v, aff) {
    if (v !== null && typeof v === 'object') return v;
    if (typeof v === 'number') return v;
    if (aff === 'TEXT') return String(v);
    const n = asNumber(v);
    return n === null ? String(v) : n;
  }

  // Human-readable form of a value, for step descriptions.
  function show(v) {
    if (v === null || v === undefined) return '(empty)';
    if (typeof v === 'object') return v.$int ?? v.$text ?? String(v);
    const s = String(v);
    return s.length > 40 ? s.slice(0, 39) + '…' : s;
  }

  function uniqueName(name, taken) {
    let n = name;
    for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${name} (${i})`;
    taken.add(n.toLowerCase());
    return n;
  }

  function findCol(rel, name, what) {
    const c = rel.cols.find((x) => x.name === name);
    if (!c) throw new StepError(`${what || 'This step'} uses the column “${name}”, which isn't there any more`);
    return c;
  }

  // ---------- conditions ----------
  function conditionSql(cond, col, params) {
    const x = qi(col.name);
    const aff = col.affinity;
    const raw = cond.value;
    const v = raw == null ? '' : raw;
    const text = typeof v === 'string' ? v : show(v);
    const push = (...p) => params.push(...p);
    switch (cond.op) {
      case 'contains': if (text === '') return null; push('%' + likeEscape(text) + '%'); return `${x} LIKE ? ESCAPE '\\'`;
      case 'notContains': if (text === '') return null; push('%' + likeEscape(text) + '%'); return `(${x} IS NULL OR ${x} NOT LIKE ? ESCAPE '\\')`;
      case 'starts': if (text === '') return null; push(likeEscape(text) + '%'); return `${x} LIKE ? ESCAPE '\\'`;
      case 'ends': if (text === '') return null; push('%' + likeEscape(text)); return `${x} LIKE ? ESCAPE '\\'`;
      case 'eq':
      case 'ne': {
        if (raw === null) return cond.op === 'eq' ? `${x} IS NULL` : `${x} IS NOT NULL`;
        if (raw === undefined || raw === '') return null; // box not filled in yet
        const b = bindValue(v, aff);
        // Columns with no declared type (common in views) don't convert, so match either spelling.
        const alts = aff === 'NONE' && typeof b === 'number' && typeof raw === 'string' ? [b, raw.trim()] : [b];
        push(...alts);
        const list = alts.map(() => '?').join(', ');
        return cond.op === 'eq' ? `${x} IN (${list})` : `(${x} IS NULL OR ${x} NOT IN (${list}))`;
      }
      case 'in': {
        const items = Array.isArray(raw)
          ? raw.filter((s) => s !== null)
          : String(v).split(/[\n,]/).map((s) => s.trim()).filter((s) => s !== '');
        const withNull = Array.isArray(raw) && raw.includes(null);
        if (!items.length && !withNull) return cond.negate ? null : '0';
        const parts = [];
        if (items.length) {
          push(...items.map((s) => bindValue(s, aff)));
          parts.push(`${x} IN (${items.map(() => '?').join(', ')})`);
        }
        if (withNull) parts.push(`${x} IS NULL`);
        const sql = parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0];
        return cond.negate ? `NOT COALESCE(${sql}, 0)` : sql;
      }
      case 'gt': case 'gte': case 'lt': case 'lte': {
        if (v === '') return null;
        push(bindValue(v, aff));
        return `${x} ${{ gt: '>', gte: '>=', lt: '<', lte: '<=' }[cond.op]} ?`;
      }
      case 'between': {
        const v2 = cond.value2 == null ? '' : cond.value2;
        if (v === '' || v2 === '') return null;
        push(bindValue(v, aff), bindValue(v2, aff));
        return `${x} BETWEEN ? AND ?`;
      }
      case 'empty': return `(${x} IS NULL OR ${x} = '')`;
      case 'notEmpty': return `(${x} IS NOT NULL AND ${x} <> '')`;
    }
    return null;
  }

  function describeCondition(c) {
    const op = OPERATORS.find((o) => o.id === c.op);
    if (!op) return c.col;
    if (c.op === 'eq' && c.value === null) return `${c.col} is empty`;
    if (c.op === 'ne' && c.value === null) return `${c.col} is not empty`;
    if (op.arity === 0) return `${c.col} ${op.label}`;
    if (op.arity === 2) return `${c.col} between ${show(c.value)} and ${show(c.value2)}`;
    if (c.op === 'in') {
      const items = Array.isArray(c.value) ? c.value : String(c.value || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      const shown = items.slice(0, 3).map(show).join(', ') + (items.length > 3 ? ` +${items.length - 3} more` : '');
      return `${c.col} ${c.negate ? 'is not one of' : 'is one of'} ${shown}`;
    }
    return `${c.col} ${op.symbol || op.label} ${show(c.value)}`;
  }

  // ---------- steps ----------
  const orderBy = (rel) => rel.order.length
    ? ' ORDER BY ' + rel.order.map((o) => `${qi(o.col)} ${o.dir === 'desc' ? 'DESC' : 'ASC'}`).join(', ')
    : '';

  const wrap = (rel) => `(${rel.sql})`;

  const JOIN_KINDS = [
    { id: 'left', label: 'Keep all rows here', hint: 'rows with no match get empty cells' },
    { id: 'inner', label: 'Only rows that match', hint: 'drop rows with no match' },
    { id: 'anti', label: 'Only rows with no match', hint: 'e.g. customers who never ordered' },
    { id: 'full', label: 'All rows from both', hint: 'unmatched rows from either side', minSqlite: [3, 39] },
  ];

  const sourceName = (src) => src.table || src.name || 'query';

  // The rows of another table or another open query, as a relation.
  function sourceRel(src, schema, ctx, stack) {
    if (src.table) return apply(null, { type: 'source', table: src.table }, schema, ctx, stack);
    const q = ctx && ctx.resolveQuery ? ctx.resolveQuery(src.query) : null;
    if (!q) throw new StepError(`The query “${sourceName(src)}” isn't open any more`);
    if (stack.has(src.query)) throw new StepError('These queries use each other in a loop');
    const inner = new Set(stack).add(src.query);
    const r = build(q.steps, schema, null, ctx, inner);
    if (r.error) throw new StepError(`The query “${q.name}” has a problem: ${r.error.message}`);
    return r.rel;
  }

  function merge(rel, step, schema, ctx, stack, what) {
    const right = sourceRel(step.source, schema, ctx, stack);
    const kind = step.kind || 'left';
    if (!step.on.length) throw new StepError('Choose which columns to match on');
    for (const [l, r] of step.on) {
      findCol(rel, l, what);
      findCol(right, r, what);
    }
    const taken = new Set(rel.cols.map((c) => c.name.toLowerCase()));
    const prefix = step.prefix ?? sourceName(step.source);
    const added = kind === 'anti' ? [] : (step.columns || right.cols.map((c) => c.name)).map((name) => {
      const rc = findCol(right, name, what);
      return { name: uniqueName(prefix ? `${prefix}.${name}` : name, taken), affinity: rc.affinity, prov: rc.prov, src: name };
    });
    const on = step.on.map(([l, r]) => `p.${qi(l)} = j.${qi(r)}`).join(' AND ');
    const join = { left: 'LEFT JOIN', inner: 'JOIN', anti: 'LEFT JOIN', full: 'FULL JOIN' }[kind];
    if (!join) throw new StepError(`Unknown way of merging “${kind}”`);
    let sql = `SELECT p.*${added.map((c) => `, j.${qi(c.src)} AS ${qi(c.name)}`).join('')} FROM ${wrap(rel)} AS p ${join} ${wrap(right)} AS j ON ${on}`;
    if (kind === 'anti') sql += ` WHERE j.${qi(step.on[0][1])} IS NULL`;
    return {
      sql,
      params: rel.params.concat(right.params),
      cols: rel.cols.concat(added.map(({ src, ...c }) => c)),
      order: rel.order, base: null, plain: false,
    };
  }

  function apply(rel, step, schema, ctx, stack) {
    stack = stack || new Set();
    if (step.type !== 'source' && !rel) throw new StepError('The first step must be a source table');
    switch (step.type) {
      case 'source': {
        const t = schema.tables[step.table];
        if (!t) throw new StepError(`There's no table called “${step.table}” in this database`);
        const cols = t.columns.map((c) => ({ name: c.name, affinity: c.affinity, prov: { table: t.name, column: c.name } }));
        return {
          sql: `SELECT ${cols.map((c) => qi(c.name)).join(', ')} FROM ${qi(t.name)}`,
          params: [], cols, order: [], base: t.name, plain: true,
        };
      }

      case 'link': // following a foreign key: a merge that keeps every row
        return merge(rel, { source: { table: step.table }, kind: 'left', on: step.pairs, columns: step.columns, prefix: step.table }, schema, ctx, stack, 'This link');

      case 'merge':
        return merge(rel, step, schema, ctx, stack, 'This merge');

      case 'lookup': {
        // One figure per row from a related table (e.g. each customer's number
        // of orders), without multiplying rows the way a merge would.
        const right = sourceRel(step.source, schema, ctx, stack);
        if (!step.on.length) throw new StepError('Choose which columns to match on');
        step.on.forEach(([l, r]) => { findCol(rel, l, 'This summary'); findCol(right, r, 'This summary'); });
        const taken = new Set(rel.cols.map((c) => c.name.toLowerCase()));
        const inner = step.on.map(([, r], i) => `${qi(r)} AS k${i}`);
        const outer = [];
        const cols = [];
        step.measures.forEach((m, i) => {
          const def = MEASURES.find((d) => d.id === m.fn);
          if (!def) return;
          const c = def.needsColumn ? findCol(right, m.col, 'This summary') : null;
          inner.push({
            count: () => 'COUNT(*)', countDistinct: () => `COUNT(DISTINCT ${qi(c.name)})`,
            sum: () => `SUM(${qi(c.name)})`, avg: () => `AVG(${qi(c.name)})`,
            min: () => `MIN(${qi(c.name)})`, max: () => `MAX(${qi(c.name)})`,
          }[m.fn]() + ` AS m${i}`);
          const name = uniqueName(m.name || `${sourceName(step.source)}: ${def.needsColumn ? `${def.label} ${c.name}` : def.label}`, taken);
          const counts = m.fn === 'count' || m.fn === 'countDistinct';
          outer.push(`${counts ? `COALESCE(j.m${i}, 0)` : `j.m${i}`} AS ${qi(name)}`);
          cols.push({ name, affinity: counts ? 'INTEGER' : m.fn === 'min' || m.fn === 'max' ? c.affinity : 'REAL', prov: null });
        });
        if (!cols.length) throw new StepError('Choose at least one figure to add');
        const on = step.on.map(([l], i) => `p.${qi(l)} = j.k${i}`).join(' AND ');
        return {
          sql: `SELECT p.*, ${outer.join(', ')} FROM ${wrap(rel)} AS p LEFT JOIN (SELECT ${inner.join(', ')} FROM ${wrap(right)} GROUP BY ${step.on.map((_, i) => `k${i}`).join(', ')}) AS j ON ${on}`,
          params: rel.params.concat(right.params),
          cols: rel.cols.concat(cols),
          order: rel.order, base: null, plain: false,
        };
      }

      case 'append': {
        // Stack rows underneath, matching columns by name; missing ones are empty.
        const right = sourceRel(step.source, schema, ctx, stack);
        const cols = rel.cols.concat(right.cols.filter((rc) => !rel.cols.some((c) => c.name === rc.name)));
        const side = (r) => cols.map((c) => (r.cols.some((x) => x.name === c.name) ? qi(c.name) : `NULL AS ${qi(c.name)}`)).join(', ');
        return {
          sql: `SELECT ${side(rel)} FROM ${wrap(rel)} UNION ALL SELECT ${side(right)} FROM ${wrap(right)}`,
          params: rel.params.concat(right.params),
          cols, order: [], base: null, plain: false,
        };
      }

      case 'filter': {
        const params = [];
        const parts = [];
        for (const cond of step.conditions) {
          const col = findCol(rel, cond.col, 'This filter');
          const sql = conditionSql(cond, col, params);
          if (sql) parts.push(sql);
        }
        if (!parts.length) return rel; // an unfinished filter doesn't change anything yet
        const where = parts.length > 1 ? parts.map((p) => `(${p})`).join(step.match === 'any' ? ' OR ' : ' AND ') : parts[0];
        return { ...rel, sql: `SELECT * FROM ${wrap(rel)} WHERE ${where}`, params: rel.params.concat(params), base: null, plain: false };
      }

      case 'columns':
      case 'remove': {
        let keep;
        if (step.type === 'columns') keep = step.keep.map((n) => findCol(rel, n, 'Choosing columns'));
        else {
          step.cols.forEach((n) => findCol(rel, n, 'Removing columns'));
          keep = rel.cols.filter((c) => !step.cols.includes(c.name));
        }
        if (!keep.length) throw new StepError('This step leaves no columns');
        const names = new Set(keep.map((c) => c.name));
        return {
          ...rel,
          sql: `SELECT ${keep.map((c) => qi(c.name)).join(', ')} FROM ${wrap(rel)}`,
          cols: keep,
          order: rel.order.filter((o) => names.has(o.col)),
        };
      }

      case 'rename': {
        const col = findCol(rel, step.from, 'This rename');
        const to = String(step.to || '').trim();
        if (!to) throw new StepError('The new name is empty');
        if (to !== col.name && rel.cols.some((c) => c.name.toLowerCase() === to.toLowerCase() && c !== col)) {
          throw new StepError(`There's already a column called “${to}”`);
        }
        return {
          ...rel,
          sql: `SELECT ${rel.cols.map((c) => (c === col ? `${qi(c.name)} AS ${qi(to)}` : qi(c.name))).join(', ')} FROM ${wrap(rel)}`,
          cols: rel.cols.map((c) => (c === col ? { ...c, name: to } : c)),
          order: rel.order.map((o) => (o.col === col.name ? { ...o, col: to } : o)),
        };
      }

      case 'sort': {
        step.by.forEach((o) => findCol(rel, o.col, 'This sort'));
        return { ...rel, order: step.by.map((o) => ({ col: o.col, dir: o.dir })) };
      }

      case 'group': {
        const groups = step.by.map((n) => findCol(rel, n, 'This grouping'));
        const taken = new Set(groups.map((g) => g.name.toLowerCase()));
        const selects = groups.map((g) => qi(g.name));
        const cols = groups.slice();
        for (const m of step.measures) {
          const def = MEASURES.find((d) => d.id === m.fn);
          if (!def) continue;
          const c = def.needsColumn ? findCol(rel, m.col, 'This grouping') : null;
          const expr = {
            count: () => 'COUNT(*)',
            countDistinct: () => `COUNT(DISTINCT ${qi(c.name)})`,
            sum: () => `SUM(${qi(c.name)})`,
            avg: () => `AVG(${qi(c.name)})`,
            min: () => `MIN(${qi(c.name)})`,
            max: () => `MAX(${qi(c.name)})`,
          }[m.fn]();
          const name = uniqueName(m.name || (def.needsColumn ? `${def.label} ${c.name}` : def.label), taken);
          const aff = m.fn === 'count' || m.fn === 'countDistinct' ? 'INTEGER'
            : m.fn === 'min' || m.fn === 'max' ? c.affinity : 'REAL';
          selects.push(`${expr} AS ${qi(name)}`);
          cols.push({ name, affinity: aff, prov: null });
        }
        if (!cols.length) throw new StepError('Choose something to group by or show');
        const groupNames = new Set(groups.map((g) => g.name));
        return {
          sql: `SELECT ${selects.join(', ')} FROM ${wrap(rel)}` + (groups.length ? ` GROUP BY ${groups.map((g) => qi(g.name)).join(', ')}` : ''),
          params: rel.params, cols, base: null, plain: false,
          order: rel.order.filter((o) => groupNames.has(o.col)),
        };
      }

      case 'distinct':
        return { ...rel, sql: `SELECT DISTINCT * FROM ${wrap(rel)}`, base: null, plain: false };

      case 'top': {
        const n = Math.floor(Number(step.n));
        if (!(n > 0)) throw new StepError('Choose how many rows to keep');
        return { ...rel, sql: `SELECT * FROM (${rel.sql}${orderBy(rel)} LIMIT ${n})`, base: null, plain: false };
      }
    }
    throw new StepError(`Unknown step “${step.type}”`);
  }

  function build(steps, schema, upto, ctx, stack) {
    const last = upto == null ? steps.length - 1 : Math.min(upto, steps.length - 1);
    let rel = null;
    for (let i = 0; i <= last; i++) {
      try {
        rel = apply(rel, steps[i], schema, ctx, stack);
      } catch (e) {
        if (!(e instanceof StepError)) throw e;
        return { rel, error: { step: i, message: e.message } };
      }
    }
    return { rel, error: null };
  }

  // Compile steps[0..upto] into SQL. On a broken step, returns the error and
  // the result of the steps before it. ctx.resolveQuery(id) -> {name, steps}
  // lets steps use other open queries.
  function compile(steps, schema, upto, ctx) {
    const { rel, error } = build(steps, schema, upto, ctx, new Set(ctx && ctx.self ? [ctx.self] : []));
    if (!rel) return { error: error || { step: 0, message: 'Nothing to show' } };
    return {
      error,
      cols: rel.cols,
      order: rel.order,
      sql: rel.sql + orderBy(rel),
      unsortedSql: rel.sql,
      params: rel.params,
      // Counting never needs the sort; a plain table is fastest counted directly.
      countSql: rel.plain && rel.base ? `SELECT COUNT(*) FROM ${qi(rel.base)}` : `SELECT COUNT(*) FROM (${rel.sql})`,
      countParams: rel.plain && rel.base ? [] : rel.params,
    };
  }

  // The problem with each step, if any, for the steps panel.
  function stepErrors(steps, schema, ctx) {
    const { error } = build(steps, schema, null, ctx, new Set(ctx && ctx.self ? [ctx.self] : []));
    return error ? { [error.step]: error.message } : {};
  }

  function describe(step) {
    switch (step.type) {
      case 'source': return `Source: ${step.table}`;
      case 'link': return `Linked ${step.table} (via ${step.pairs.map((p) => p[0]).join(', ')})`;
      case 'merge': {
        const kind = { left: '', inner: ', only matching rows', anti: ', only rows with no match', full: ', all rows from both' }[step.kind || 'left'];
        return `Merged with ${sourceName(step.source)} on ${step.on.map((p) => p[0]).join(', ')}${kind}`;
      }
      case 'lookup': return `Added ${step.measures.map((m) => (MEASURES.find((d) => d.id === m.fn) || {}).label.toLowerCase() + (m.col ? ' ' + m.col : '')).join(', ')} from ${sourceName(step.source)}`;
      case 'append': return `Appended ${sourceName(step.source)}`;
      case 'filter': {
        const parts = step.conditions.map(describeCondition);
        return parts.length ? 'Filtered: ' + parts.join(step.match === 'any' ? ' or ' : ' and ') : 'Filter (not set yet)';
      }
      case 'columns': return `Chose ${step.keep.length} column${step.keep.length === 1 ? '' : 's'}`;
      case 'remove': return `Removed ${step.cols.join(', ')}`;
      case 'rename': return `Renamed ${step.from} → ${step.to}`;
      case 'sort': return 'Sorted by ' + step.by.map((o) => `${o.col} ${o.dir === 'desc' ? '↓' : '↑'}`).join(', ');
      case 'group': return step.by.length ? `Grouped by ${step.by.join(', ')}` : 'Summarised all rows';
      case 'distinct': return 'Removed duplicate rows';
      case 'top': return `Kept first ${Number(step.n).toLocaleString()} rows`;
    }
    return step.type;
  }

  // ---------- relationships ----------
  // Tables whose foreign keys can be followed from the current columns.
  function outgoingLinks(cols, schema) {
    const out = [];
    const tables = new Set(cols.filter((c) => c.prov).map((c) => c.prov.table));
    for (const tname of tables) {
      const t = schema.tables[tname];
      if (!t) continue;
      for (const fk of t.fks) {
        const pairs = [];
        for (const [from, to] of fk.pairs) {
          const col = cols.find((c) => c.prov && c.prov.table === tname && c.prov.column === from);
          if (!col) break;
          pairs.push([col.name, to]);
        }
        if (pairs.length === fk.pairs.length && schema.tables[fk.table]) out.push({ table: fk.table, pairs, from: tname });
      }
    }
    return out;
  }

  // The foreign key (if any) a single column follows.
  function parentOf(col, schema) {
    if (!col || !col.prov) return null;
    const t = schema.tables[col.prov.table];
    if (!t) return null;
    const fk = t.fks.find((f) => f.pairs.length === 1 && f.pairs[0][0] === col.prov.column);
    return fk && schema.tables[fk.table] ? { table: fk.table, column: fk.pairs[0][1] } : null;
  }

  // Everywhere else a value of this key column appears: tables whose foreign
  // keys point at the same key. For a foreign-key column, that means siblings
  // pointing at the same parent too.
  function referencesTo(table, column, schema) {
    const out = [];
    for (const t of Object.values(schema.tables)) {
      for (const fk of t.fks) {
        if (fk.pairs.length === 1 && fk.table === table && fk.pairs[0][1] === column) {
          out.push({ table: t.name, column: fk.pairs[0][0] });
        }
      }
    }
    return out;
  }

  function relatedFor(col, schema) {
    if (!col || !col.prov) return [];
    const targets = [col.prov];
    const parent = parentOf(col, schema);
    if (parent) targets.push(parent);
    const seen = new Set();
    const out = [];
    for (const target of targets) {
      for (const r of referencesTo(target.table, target.column, schema)) {
        const k = r.table + '\u0000' + r.column;
        if (seen.has(k) || (r.table === col.prov.table && r.column === col.prov.column)) continue;
        seen.add(k);
        out.push(r);
      }
    }
    return out;
  }

  // Likely column pairs to match two relations on, best first: declared
  // foreign keys either way, then "customer_id" <-> customers.id, then same names.
  function suggestMatches(left, right, schema, rightTable) {
    const out = [];
    const add = (l, r) => { if (!out.some(([a, b]) => a === l.name && b === r.name)) out.push([l.name, r.name]); };
    for (const l of left) {
      for (const r of right) {
        const lp = parentOf(l, schema);
        const rp = parentOf(r, schema);
        if ((lp && r.prov && lp.table === r.prov.table && lp.column === r.prov.column) ||
            (rp && l.prov && rp.table === l.prov.table && rp.column === l.prov.column) ||
            (lp && rp && lp.table === rp.table && lp.column === rp.column)) add(l, r);
      }
    }
    if (rightTable) {
      const singular = rightTable.toLowerCase().replace(/ies$/, 'y').replace(/s$/, '');
      const pk = primaryKey(rightTable, schema);
      const r = right.find((c) => c.name === pk);
      for (const l of left) if (r && l.name.toLowerCase() === `${singular}_${pk}`.toLowerCase()) add(l, r);
    }
    for (const l of left) for (const r of right) if (l.name.toLowerCase() === r.name.toLowerCase()) add(l, r);
    return out;
  }

  function primaryKey(table, schema) {
    const t = schema.tables[table];
    if (!t) return null;
    const pks = t.columns.filter((c) => c.pk);
    return pks.length === 1 ? pks[0].name : null;
  }

  return {
    qi, affinity, isNumeric, OPERATORS, MEASURES, JOIN_KINDS, compile, stepErrors, describe, describeCondition,
    outgoingLinks, parentOf, referencesTo, relatedFor, primaryKey, suggestMatches, show, asNumber, sourceName,
  };
});
