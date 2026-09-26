// Turns the point-and-click query state into SQL + bound parameters.
// Nothing typed by the user is ever pasted into SQL text: table/column names
// are quoted identifiers from the schema, and values are bound parameters.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DBXQuery = factory();
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

  const OPERATORS = [
    { id: 'contains', label: 'contains', arity: 1 },
    { id: 'notContains', label: 'does not contain', arity: 1 },
    { id: 'eq', label: 'is exactly', arity: 1 },
    { id: 'ne', label: 'is not', arity: 1 },
    { id: 'starts', label: 'starts with', arity: 1 },
    { id: 'ends', label: 'ends with', arity: 1 },
    { id: 'in', label: 'is one of', arity: 'list' },
    { id: 'gt', label: 'is greater than', arity: 1 },
    { id: 'gte', label: 'is at least', arity: 1 },
    { id: 'lt', label: 'is less than', arity: 1 },
    { id: 'lte', label: 'is at most', arity: 1 },
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

  const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);

  // A typed value only becomes a number if doing so loses nothing ("007" stays text).
  function asNumber(v) {
    const s = String(v).trim();
    if (s === '' || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) && String(n) === s.replace(/^\+/, '') ? n : null;
  }

  function bindValue(v, aff) {
    if (aff === 'TEXT') return String(v);
    const n = asNumber(v);
    return n === null ? String(v) : n;
  }

  // Build the list of every column reachable in this query (base table + linked tables).
  function availableColumns(state, schema) {
    const out = [];
    const sources = [{ alias: 't0', table: state.table, prefix: '' }].concat(
      state.joins.map((j) => ({ alias: j.alias, table: j.table, prefix: j.label + ' → ' }))
    );
    for (const s of sources) {
      const t = schema.tables[s.table];
      if (!t) continue;
      for (const c of t.columns) {
        out.push({
          key: s.alias + '.' + c.name,
          alias: s.alias,
          table: s.table,
          column: c.name,
          affinity: c.affinity,
          label: s.prefix + c.name,
        });
      }
    }
    return out;
  }

  function uniqueLabels(labels) {
    const seen = new Map();
    return labels.map((l) => {
      const n = seen.get(l) || 0;
      seen.set(l, n + 1);
      return n ? `${l} (${n + 1})` : l;
    });
  }

  function buildFrom(state, schema) {
    let sql = ` FROM ${qi(state.table)} AS t0`;
    for (const j of state.joins) {
      const on = j.pairs.map(([from, to]) => `${j.from}.${qi(from)} = ${j.alias}.${qi(to)}`).join(' AND ');
      sql += ` LEFT JOIN ${qi(j.table)} AS ${j.alias} ON ${on}`;
    }
    return sql;
  }

  function buildWhere(state, colsByKey, params) {
    const parts = [];
    for (const f of state.filters) {
      const col = colsByKey.get(f.key);
      if (!col) continue;
      const x = `${col.alias}.${qi(col.column)}`;
      const aff = col.affinity;
      const v = f.value == null ? '' : String(f.value);
      switch (f.op) {
        case 'contains': if (v === '') continue; parts.push(`${x} LIKE ? ESCAPE '\\'`); params.push('%' + likeEscape(v) + '%'); break;
        case 'notContains': if (v === '') continue; parts.push(`(${x} IS NULL OR ${x} NOT LIKE ? ESCAPE '\\')`); params.push('%' + likeEscape(v) + '%'); break;
        case 'starts': if (v === '') continue; parts.push(`${x} LIKE ? ESCAPE '\\'`); params.push(likeEscape(v) + '%'); break;
        case 'ends': if (v === '') continue; parts.push(`${x} LIKE ? ESCAPE '\\'`); params.push('%' + likeEscape(v)); break;
        case 'eq':
        case 'ne': {
          const b = bindValue(v, aff);
          // Columns with no declared type (common in views) don't convert, so match either spelling.
          const alts = aff === 'NONE' && typeof b === 'number' ? [b, v.trim()] : [b];
          const inList = alts.map(() => '?').join(', ');
          parts.push(f.op === 'eq' ? `${x} IN (${inList})` : `(${x} IS NULL OR ${x} NOT IN (${inList}))`);
          params.push(...alts);
          break;
        }
        case 'in': {
          const items = v.split(/[\n,]/).map((s) => s.trim()).filter((s) => s !== '');
          if (!items.length) continue;
          parts.push(`${x} IN (${items.map(() => '?').join(', ')})`);
          params.push(...items.map((s) => bindValue(s, aff)));
          break;
        }
        case 'gt': case 'gte': case 'lt': case 'lte': {
          if (v === '') continue;
          const op = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.op];
          parts.push(`${x} ${op} ?`);
          params.push(bindValue(v, aff));
          break;
        }
        case 'between': {
          const v2 = f.value2 == null ? '' : String(f.value2);
          if (v === '' || v2 === '') continue;
          parts.push(`${x} BETWEEN ? AND ?`);
          params.push(bindValue(v, aff), bindValue(v2, aff));
          break;
        }
        case 'empty': parts.push(`(${x} IS NULL OR ${x} = '')`); break;
        case 'notEmpty': parts.push(`(${x} IS NOT NULL AND ${x} <> '')`); break;
      }
    }
    if (!parts.length) return '';
    return ' WHERE ' + parts.join(state.match === 'any' ? ' OR ' : ' AND ');
  }

  // Returns { sql, params, labels } for the whole result (no LIMIT), or null if
  // there is nothing to select.
  function build(state, schema) {
    const cols = availableColumns(state, schema);
    const colsByKey = new Map(cols.map((c) => [c.key, c]));
    const ref = (c) => `${c.alias}.${qi(c.column)}`;
    let selects = [];
    let labels = [];
    let groupBy = '';

    if (state.summary && state.summary.on) {
      const groups = state.summary.groupBy.map((k) => colsByKey.get(k)).filter(Boolean);
      for (const g of groups) { selects.push(ref(g)); labels.push(g.label); }
      for (const m of state.summary.measures) {
        const c = colsByKey.get(m.key);
        const def = MEASURES.find((d) => d.id === m.fn);
        if (!def || (def.needsColumn && !c)) continue;
        const expr = {
          count: () => 'COUNT(*)',
          countDistinct: () => `COUNT(DISTINCT ${ref(c)})`,
          sum: () => `SUM(${ref(c)})`,
          avg: () => `AVG(${ref(c)})`,
          min: () => `MIN(${ref(c)})`,
          max: () => `MAX(${ref(c)})`,
        }[m.fn]();
        selects.push(expr);
        labels.push(def.needsColumn ? `${def.label} ${c.label}` : def.label);
      }
      if (groups.length) groupBy = ' GROUP BY ' + groups.map(ref).join(', ');
    } else {
      const visible = state.columns.filter((c) => c.visible && colsByKey.has(c.key));
      for (const v of visible) {
        const c = colsByKey.get(v.key);
        selects.push(ref(c));
        labels.push(c.label);
      }
    }
    if (!selects.length) return null;
    labels = uniqueLabels(labels);

    const params = [];
    const where = buildWhere(state, colsByKey, params);
    const unsorted = 'SELECT ' + selects.map((s, i) => `${s} AS ${qi(labels[i])}`).join(', ') +
      buildFrom(state, schema) + where + groupBy;

    let sql = unsorted;
    const sortIdx = state.sort ? labels.indexOf(state.sort.label) : -1;
    if (sortIdx >= 0) sql += ` ORDER BY ${sortIdx + 1} ${state.sort.dir === 'desc' ? 'DESC' : 'ASC'}`;

    // Counting never needs the sort; with no filters, joins or grouping it's
    // just the table's own row count, which SQLite answers fastest.
    const plain = !state.joins.length && !where && !groupBy;
    const countSql = plain ? `SELECT COUNT(*) FROM ${qi(state.table)}` : `SELECT COUNT(*) FROM (${unsorted})`;
    return { sql, params, labels, countSql, countParams: plain ? [] : params };
  }

  // Foreign keys that could be followed from the tables already in the query.
  function availableLinks(state, schema) {
    const sources = [{ alias: 't0', table: state.table, label: state.table }].concat(
      state.joins.map((j) => ({ alias: j.alias, table: j.table, label: j.label }))
    );
    const links = [];
    for (const s of sources) {
      const t = schema.tables[s.table];
      if (!t) continue;
      for (const fk of t.fks) {
        if (!schema.tables[fk.table]) continue;
        const already = state.joins.some((j) => j.from === s.alias && j.fkId === fk.id);
        if (already) continue;
        links.push({
          from: s.alias,
          fkId: fk.id,
          table: fk.table,
          pairs: fk.pairs,
          label: s.alias === 't0' ? fk.table : `${s.label} → ${fk.table}`,
          via: fk.pairs.map((p) => p[0]).join(', '),
        });
      }
    }
    return links;
  }

  return { qi, affinity, OPERATORS, MEASURES, availableColumns, availableLinks, build, asNumber };
});
