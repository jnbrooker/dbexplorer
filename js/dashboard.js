// Dashboards: panels of figures, charts, tables and maps on top of the query
// engine. A panel is a source (a table, or a copy of a query tab's steps)
// plus how to summarise and draw it; its SQL wraps the source's SQL the same
// way steps wrap each other. Dashboard controls (date ranges, "region = X")
// become WHERE conditions on every panel whose data has that column.
//
// The top half is pure SQL building (tested with node); create() is the UI.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pipeline.js'));
  else root.DBXDashboard = factory(root.DBXPipeline);
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  const { qi } = P;

  // ---------- dates ----------
  const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
  const epochOf = (day) => Date.parse(day + 'T00:00:00Z') / 1000;
  const monthEnd = (ym) => { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)); return d.toISOString().slice(0, 10); };

  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const BUCKETS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year'], ['weekday', 'Day of the week'], ['monthOfYear', 'Month of the year']];
  const PRESETS = [['all', 'All time'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['12m', 'Last 12 months'], ['ytd', 'This year'], ['lastyear', 'Last year'], ['custom', 'Choose dates…']];

  function presetRange(c, today) {
    const y = today.slice(0, 4);
    switch (c.preset) {
      case '7d': return [addDays(today, -6), today];
      case '30d': return [addDays(today, -29), today];
      case '90d': return [addDays(today, -89), today];
      case '12m': return [addDays(today, -364), today];
      case 'ytd': return [y + '-01-01', today];
      case 'lastyear': return [(y - 1) + '-01-01', (y - 1) + '-12-31'];
      case 'custom': return [c.from || null, c.to || null];
      default: return [null, null];
    }
  }

  // ---------- what each column holds, judged from a sample of rows ----------
  // Real databases are full of columns nobody wants on a chart: ids and codes
  // (UUIDs, hashes, "venue|city|GB" keys), copies of other columns (city_norm,
  // countryCode), bookkeeping (loaded_at, source), and columns that are mostly
  // empty. Each column gets a role, so suggestions only use the ones that mean
  // something: dates, categories, names, measures and coordinates.
  //
  // SQLite has no date type, so dates are recognised from their values: ISO
  // text ("2024-03-01", "2024-03-01 18:30:00") or, for columns named like a
  // date, Unix timestamps. Numbers stored as text count as numbers.
  const ISO = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
  const DATE_NAME = /(date|time|_at$|_on$|stamp|created|updated|modified|day$|when)/i;
  const LAT_NAME = /^(lat|latitude)$|[_ ](lat|latitude)$|^(lat|latitude)[_ ]/i;
  const LON_NAME = /^(lon|lng|long|longitude)$|[_ ](lon|lng|long|longitude)$|^(lon|lng|long|longitude)[_ ]/i;
  const MONEY_NAME = /(price|amount|revenue|cost|total|value|sales|gross|net|fee|paid|spend|income|profit|gbp|usd|eur)/i;
  const CODE_NAME = /(^|_)(ids?|uids?|uuids?|guids?|mbids?|keys?|hash|slug|urls?|uri|links?|zip|zipcode|postcode|postal_?code|phone|email|isbn|sku|wikidata_id)$/i;
  const CODE_CAMEL = /[a-z](Id|Ids|Key|Code|Url|Uuid)$/;
  const META_NAME = /(^|_)(loaded|fetched|built|synced|imported|scraped|checked|run|refreshed|updated|modified|inserted)(_at|_on|_time|_date)?$|^last_(updated|modified|seen|checked|synced)|(^|_)(source|method|match|matched|confidence|basis|evidence|notes?|comments?|info|raw|json|payload|debug|version)$/i;
  const MEASURE_NAME = /(ticket|gross|revenue|sales|amount|price|cost|total|capacity|attendance|listeners|quantity|qty|value|spend|profit|income|fee|songs|views|plays|streams|score|points|goals|minutes|duration|distance|weight|population|shows|bookings)/i;
  // Things you'd total (tickets, gross) versus attributes you'd average (capacity, price).
  const FLOW_NAME = /(ticket|gross|revenue|sales|amount|quantity|qty|attendance|spend|profit|income|paid|streams|plays|views|goals|points|bookings|shows)/i;
  const AVG_NAME = /(^|_)(avg|average|mean|median|pct|percent|percentage|rate|ratio|price|rank|rating)(_|$)|_(min|max)$|^(min|max)_|capacity|listeners|population|size|age$|score/i;
  const DIM_NAME = /(artist|headliner|performer|band|team|player|venue|arena|stadium|country|city|region|state|county|category|type|genre|status|segment|brand|product|customer|company|promoter|market|channel|department|author|publisher|competition|league|name|title)/i;
  const ENTITY_NAME = /(artist|headliner|performer|band|team|player|venue|arena|stadium|product|customer|client|company|promoter|brand|author|publisher|title|name)/i;
  const PLACE_NAME = /(country|city|region|state|county|market|continent|town)/i;
  const TWIN_SUFFIX = /(_norm|_normalised|_normalized|_key|_clean|_lower|_slug|_code|Code|_iso2|_iso3)$/;
  const NUMERIC_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
  const OPAQUE = [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i, /^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}$/i, /^https?:\/\//i, /\|/, /^[A-Za-z0-9_-]{18,}$/, /^Q\d+$/];

  function classify(cols, rows, isPk) {
    const out = {};
    const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '') || (typeof v === 'object' && v.$blob != null);
    const numOf = (v) => (typeof v === 'number' ? v : typeof v === 'object' && v.$int != null ? Number(v.$int)
      : typeof v === 'string' && NUMERIC_TEXT.test(v.trim()) ? Number(v) : null);
    cols.forEach((c, k) => {
      const vals = rows.map((r) => r[k]).filter((v) => !blank(v));
      const filled = rows.length ? vals.length / rows.length : 0;
      const nums = vals.map(numOf).filter((n) => n != null && Number.isFinite(n));
      const strs = vals.filter((v) => typeof v === 'string');
      const distinct = new Set(vals.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : JSON.stringify(v)))).size;
      let date = null;
      if (strs.length && strs.filter((v) => ISO.test(v.trim())).length >= 0.8 * vals.length) date = 'iso';
      else if (nums.length && nums.length === vals.length && DATE_NAME.test(c.name)) {
        if (nums.every((n) => n >= 1e8 && n < 4.2e9)) date = 'unix';
        else if (nums.every((n) => n >= 1e11 && n < 4.2e12)) date = 'unixms';
      }
      const number = !date && vals.length > 0 && nums.length >= 0.9 * vals.length;
      let geo = null;
      if (number && LAT_NAME.test(c.name) && nums.every((n) => n >= -90 && n <= 90)) geo = 'lat';
      if (number && LON_NAME.test(c.name) && nums.every((n) => n >= -180 && n <= 180)) geo = 'lon';
      const share = (test) => (strs.length ? strs.filter(test).length / strs.length : 0);
      const pk = !!(isPk && isPk(c));
      const codeName = CODE_NAME.test(c.name) || CODE_CAMEL.test(c.name);
      const yearish = number && nums.every((n) => Number.isInteger(n) && n >= 1800 && n <= 2100) && /year|season/i.test(c.name);
      let role;
      if (vals.length && distinct <= 1) role = 'constant';
      else if (date) role = META_NAME.test(c.name) || (vals.length >= 30 && distinct <= 3) ? 'meta' : 'date';
      else if (geo) role = 'geo';
      else if (pk || codeName) role = 'code';
      else if (META_NAME.test(c.name)) role = 'meta';
      else if (yearish) role = 'category';
      else if (number) role = 'measure';
      else if (!vals.length) role = 'empty';
      else if (share((v) => OPAQUE.some((re) => re.test(v.trim()))) >= 0.6 || share((v) => /[a-z]/i.test(v)) < 0.8) role = 'code';
      else if (strs.reduce((n, v) => n + v.length, 0) / (strs.length || 1) > 60) role = 'text';
      else if (share((v) => / \+ |; |, /.test(v)) >= 0.3) role = 'list';
      else role = distinct <= 30 ? 'category' : 'name';
      const dates = date === 'iso' ? strs.map((v) => v.slice(0, 10)).sort() : [];
      out[c.name] = {
        name: c.name, role, date, number, geo, pk, filled,
        sparse: filled < 0.5,
        decimal: number && nums.some((n) => !Number.isInteger(n)),
        distinct, sampled: vals.length,
        id: role === 'code' || pk,
        first: dates[0], last: dates[dates.length - 1], p02: dates[Math.floor(dates.length * 0.02)],
      };
    });

    // Copies of another column: by name (city_norm, countryCode next to
    // country) or by value (the same text, give or take case, in 70% of rows).
    const names = cols.map((c) => c.name);
    const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
    for (const n of names) {
      const col = out[n];
      if (!['category', 'name', 'code', 'measure'].includes(col.role)) continue;
      const base = n.replace(TWIN_SUFFIX, '');
      const other = base !== n && (lower.get(base.toLowerCase()) || lower.get(base.replace(/_?iso$/i, '').toLowerCase()));
      if (other && other !== n && out[other].role !== 'empty') { col.role = 'twin'; col.twinOf = other; }
    }
    const textish = names.filter((n) => ['category', 'name'].includes(out[n].role));
    for (let i = 0; i < textish.length; i++) {
      for (let j = i + 1; j < textish.length; j++) {
        const a = textish[i], b = textish[j];
        if (out[a].role === 'twin' || out[b].role === 'twin') continue;
        const ka = names.indexOf(a), kb = names.indexOf(b);
        let both = 0, same = 0;
        for (const r of rows) {
          const x = r[ka], y = r[kb];
          if (blank(x) || blank(y)) continue;
          both++;
          if (String(x).trim().toLowerCase() === String(y).trim().toLowerCase()) same++;
        }
        if (both >= 20 && same >= 0.7 * both) {
          // Keep the fuller one, then the one that reads better (not all lower
          // case), then the earlier column.
          const lc = (n) => rows.every((r) => blank(r[names.indexOf(n)]) || String(r[names.indexOf(n)]) === String(r[names.indexOf(n)]).toLowerCase());
          const drop = Math.abs(out[a].filled - out[b].filled) > 0.1 ? (out[a].filled < out[b].filled ? a : b) : lc(a) && !lc(b) ? a : b;
          out[drop].role = 'twin';
          out[drop].twinOf = drop === a ? b : a;
        }
      }
    }
    return { cols: out, names, rows: rows.length };
  }

  // ---------- SQL pieces ----------
  function dayExpr(col, kind) {
    const c = qi(col);
    if (kind === 'unix') return `date(${c}, 'unixepoch')`;
    if (kind === 'unixms') return `date(${c} / 1000, 'unixepoch')`;
    return `substr(${c}, 1, 10)`;
  }

  // The group key for a column: dates go into buckets, keyed as sortable text.
  function keyExpr(col, kind, bucket) {
    if (!kind) return qi(col);
    const d = dayExpr(col, kind);
    switch (bucket) {
      case 'year': return `substr(${d}, 1, 4)`;
      case 'quarter': return `substr(${d}, 1, 4) || '-Q' || ((CAST(substr(${d}, 6, 2) AS INTEGER) + 2) / 3)`;
      case 'month': return `substr(${d}, 1, 7)`;
      case 'monthOfYear': return `substr(${d}, 6, 2)`;
      case 'week': return `date(${d}, '-' || ((CAST(strftime('%w', ${d}) AS INTEGER) + 6) % 7) || ' days')`;
      case 'weekday': return `(CAST(strftime('%w', ${d}) AS INTEGER) + 6) % 7`;
      default: return d;
    }
  }

  // "from" and "to" are whole days, both included. Compares the column itself
  // (not a function of it) so an index on the date column still helps.
  function rangeCond(col, kind, from, to, params) {
    const c = qi(col);
    const conv = (d) => (kind === 'unix' ? epochOf(d) : kind === 'unixms' ? epochOf(d) * 1000 : d);
    const parts = [];
    if (from) { parts.push(`${c} >= ?`); params.push(conv(from)); }
    if (to) { parts.push(`${c} < ?`); params.push(conv(addDays(to, 1))); }
    return parts.length ? parts.join(' AND ') : '1';
  }

  const FN_NAMES = { count: 'Number of rows', sum: 'Total', avg: 'Average', min: 'Smallest', max: 'Largest', distinct: 'Number of different' };
  const mLabel = (m) => (m.fn === 'count' ? 'Number of rows' : `${FN_NAMES[m.fn] || m.fn} ${m.col}`);

  // A figure, optionally only over rows matching `cond` (for this-period vs last).
  function measureSql(m, cond) {
    const c = m.col ? qi(m.col) : null;
    const only = (x) => (cond ? `CASE WHEN ${cond} THEN ${x} END` : x);
    switch (m.fn) {
      case 'count': return cond ? `SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END)` : 'COUNT(*)';
      case 'distinct': return `COUNT(DISTINCT ${only(c)})`;
      case 'sum': case 'avg': case 'min': case 'max': return `${m.fn.toUpperCase()}(${only(c)})`;
      default: throw new Error(`Unknown figure “${m.fn}”`);
    }
  }

  // Dashboard controls reach a panel when its data has that column (a date
  // control needs a date column there too), unless the panel opts out.
  function controlConds(p, controls, prof, params, opts) {
    const out = [];
    if (p.follow === false) return out;
    for (const c of controls || []) {
      const col = prof.cols[c.col];
      if (!col) continue;
      if (c.kind === 'choice') {
        if (!('value' in c) || (opts.skipOwn && c.col === p.by)) continue;
        if (c.value === null) out.push(`${qi(c.col)} IS NULL`);
        else { out.push(`${qi(c.col)} = ?`); params.push(c.value); }
      } else if (c.kind === 'dates' && col.date && c.col !== opts.skipDate) {
        const [f, t] = presetRange(c, opts.today);
        if (f || t) out.push(rangeCond(c.col, col.date, f, t, params));
      }
    }
    return out;
  }
  const whereSql = (conds) => (conds.length ? ' WHERE ' + conds.join(' AND ') : '');

  const TIME_TYPES = new Set(['line', 'calendar']);

  // One row per group: [key, figure 1, figure 2, …]. Asks for one row more
  // than it will show, to know whether there are more.
  function groupQuery(p, base, prof, controls, opts) {
    const col = prof.cols[p.by];
    if (!col) throw new Error(`There's no column “${p.by}” in this panel's data any more`);
    const kind = col.date;
    const bucket = kind ? (p.type === 'calendar' ? 'day' : p.bucket || 'month') : null;
    const wp = [];
    const conds = controlConds(p, controls, prof, wp, { skipOwn: true, today: opts.today });
    if (opts.month) conds.push(rangeCond(p.by, kind, opts.month[0], opts.month[1], wp));
    conds.push(...blankConds(p, kind));
    const byTime = (kind && TIME_TYPES.has(p.type)) || p.sort === 'label';
    const order = byTime ? '1' : p.sort === 'value-asc' ? '2, 1' : '2 DESC, 1';
    const limit = TIME_TYPES.has(p.type) || p.type === 'map' ? 3000 : p.top > 0 ? p.top : 500;
    return {
      sql: `SELECT ${keyExpr(p.by, kind, bucket)} AS k, ${p.measures.map((m) => measureSql(m)).join(', ')} FROM (${base.sql})${whereSql(conds)} GROUP BY 1 ORDER BY ${order} LIMIT ${limit + 1}`,
      params: [...base.params, ...wp], limit, bucket, kind,
    };
  }

  // Rows with no value for the grouping column are left out, unless the panel
  // asks for them: "(blank)" shouldn't top a chart of venues.
  function blankConds(p, kind) {
    if (p.blanks) return [];
    return kind ? [`${qi(p.by)} IS NOT NULL`] : [`${qi(p.by)} IS NOT NULL`, `TRIM(${qi(p.by)}) <> ''`];
  }

  // The same figures over every row the panel covers (for % of total and "Other").
  function totalQuery(p, base, prof, controls, opts) {
    const wp = [];
    const conds = controlConds(p, controls, prof, wp, { skipOwn: true, today: opts.today });
    if (p.by && prof.cols[p.by]) conds.push(...blankConds(p, prof.cols[p.by].date));
    return { sql: `SELECT ${p.measures.map((m) => measureSql(m)).join(', ')} FROM (${base.sql})${whereSql(conds)}`, params: [...base.params, ...wp] };
  }

  const firstDate = (prof) => prof.names.find((n) => prof.cols[n].role === 'date') || prof.names.find((n) => prof.cols[n].date);

  // A single figure, and the same figure for the period before, for "+8% vs…".
  // With a date range chosen: that range vs the same length before it.
  // Without: the whole lot, plus the latest 12 months in the data vs the 12 before.
  function numberQuery(p, base, prof, controls, opts) {
    const m = p.measures[0];
    const dcol = p.compare ? firstDate(prof) : null;
    const wp = [];
    if (!dcol) {
      const conds = controlConds(p, controls, prof, wp, { today: opts.today });
      return { sql: `SELECT ${measureSql(m)} FROM (${base.sql})${whereSql(conds)}`, params: [...base.params, ...wp], compare: null };
    }
    const kind = prof.cols[dcol].date;
    const ctl = p.follow !== false && (controls || []).find((c) => c.kind === 'dates' && c.col === dcol);
    const [f, t] = ctl ? presetRange(ctl, opts.today) : [null, null];
    if (f && t) {
      const len = daysBetween(f, t) + 1;
      const pf = addDays(f, -len);
      const sp = [];
      const cur = rangeCond(dcol, kind, f, t, sp);
      const prev = rangeCond(dcol, kind, pf, addDays(f, -1), sp);
      const conds = controlConds(p, controls, prof, wp, { skipDate: dcol, today: opts.today });
      conds.push(rangeCond(dcol, kind, pf, t, wp));
      return {
        sql: `SELECT ${measureSql(m, cur)}, ${measureSql(m, prev)} FROM (${base.sql})${whereSql(conds)}`,
        params: [...sp, ...base.params, ...wp], compare: 'range',
      };
    }
    const d = dayExpr(dcol, kind);
    const conds = controlConds(p, controls, prof, wp, { today: opts.today });
    const recent = `${d} > date("__dbx_latest", '-1 year')`;
    const before = `${d} > date("__dbx_latest", '-2 years') AND ${d} <= date("__dbx_latest", '-1 year')`;
    return {
      sql: `SELECT ${measureSql(m)}, ${measureSql(m, recent)}, ${measureSql(m, before)} FROM (${base.sql})` +
        ` CROSS JOIN (SELECT MIN(MAX(${d}), date('now')) AS "__dbx_latest" FROM (${base.sql})${whereSql(conds)})${whereSql(conds)}`,
      params: [...base.params, ...base.params, ...wp, ...wp], compare: 'latest',
    };
  }

  // Month by month, for the small trend line under a number.
  function sparkQuery(p, base, prof, controls, opts) {
    const dcol = firstDate(prof);
    if (!dcol) return null;
    const wp = [];
    const conds = controlConds(p, controls, prof, wp, { today: opts.today });
    return {
      sql: `SELECT ${keyExpr(dcol, prof.cols[dcol].date, 'month')}, ${measureSql(p.measures[0])} FROM (${base.sql})${whereSql(conds)} GROUP BY 1 ORDER BY 1 LIMIT 600`,
      params: [...base.params, ...wp],
    };
  }

  function latestMonthQuery(p, base, prof, controls, opts) {
    const wp = [];
    const conds = controlConds(p, controls, prof, wp, { today: opts.today });
    return { sql: `SELECT substr(MAX(${dayExpr(p.by, prof.cols[p.by].date)}), 1, 7) FROM (${base.sql})${whereSql(conds)}`, params: [...base.params, ...wp] };
  }

  // ---------- maps ----------
  // Coordinates are often stored as text; a text column compared with a number
  // compares as text in SQLite, so always compare them as numbers.
  const geoNum = (col) => `CAST(${qi(col)} AS REAL)`;
  function geoConds(p, prof, controls, opts, wp) {
    if (!prof.cols[p.lat] || !prof.cols[p.lon]) throw new Error('Choose the latitude and longitude columns');
    const conds = controlConds(p, controls, prof, wp, { today: opts.today });
    conds.push(`${geoNum(p.lat)} BETWEEN -85 AND 85`, `${geoNum(p.lon)} BETWEEN -180 AND 180`);
    return conds;
  }
  function boundsQuery(p, base, prof, controls, opts) {
    const wp = [];
    const conds = geoConds(p, prof, controls, opts, wp);
    return { sql: `SELECT MIN(${geoNum(p.lat)}), MAX(${geoNum(p.lat)}), MIN(${geoNum(p.lon)}), MAX(${geoNum(p.lon)}), COUNT(*) FROM (${base.sql})${whereSql(conds)}`, params: [...base.params, ...wp] };
  }
  // Points are counted into a grid of cells for the area on screen, so a
  // million rows arrive as a few thousand cells.
  function binsQuery(p, base, prof, controls, opts, cell) {
    const wp = [];
    const conds = geoConds(p, prof, controls, opts, wp);
    conds.push(`${geoNum(p.lat)} BETWEEN ? AND ?`, `${geoNum(p.lon)} BETWEEN ? AND ?`);
    wp.push(cell.s, cell.n, cell.w, cell.e);
    return {
      sql: `SELECT CAST(ROUND(${geoNum(p.lat)} / ?) AS INTEGER), CAST(ROUND(${geoNum(p.lon)} / ?) AS INTEGER), ${measureSql(p.measures[0])}` +
        ` FROM (${base.sql})${whereSql(conds)} GROUP BY 1, 2 LIMIT 40001`,
      params: [cell.latStep, cell.lonStep, ...base.params, ...wp],
    };
  }

  // ---------- names for ids ----------
  // An id is shown as the name it stands for: follow the column's foreign key
  // or, when none is declared, a table named like it (venue_id -> venues), to
  // that table's name-like column (name, title, venue, ...).
  const LABEL_NAME = /^(name|title|label|display_?name|full_?name|description)$/i;
  function nameLink(col, schema) {
    if (!col) return null;
    let parent = P.parentOf(col, schema);
    if (!parent) {
      const m = /^(.+?)_?(id|uid|key|code)$/i.exec(col.name);
      if (!m) return null;
      const stem = m[1].toLowerCase();
      const names = [stem, stem + 's', stem + 'es', stem.replace(/y$/, 'ies')];
      const t = Object.values(schema.tables).find((x) => names.includes(x.name.toLowerCase()));
      if (!t || (col.prov && col.prov.table === t.name)) return null; // not a table's own key
      const key = P.primaryKey(t.name, schema) || (t.columns.find((c) => c.name.toLowerCase() === col.name.toLowerCase()) || {}).name;
      if (!key) return null;
      parent = { table: t.name, column: key };
    }
    const t = schema.tables[parent.table];
    const single = parent.table.toLowerCase().replace(/(ies)$/, 'y').replace(/s$/, '');
    const text = t.columns.filter((c) => c.name !== parent.column && c.affinity === 'TEXT');
    const label = text.find((c) => LABEL_NAME.test(c.name)) || text.find((c) => c.name.toLowerCase() === single) ||
      text.find((c) => /name|title/i.test(c.name)) || text[0];
    const extra = text.find((c) => c !== label && /^(city|town|country|region|state|place|location)$/i.test(c.name));
    return label ? { table: parent.table, key: parent.column, label: label.name, extra: extra && extra.name } : null;
  }
  function namesQuery(link, keys) {
    return {
      sql: `SELECT ${qi(link.key)}, MIN(${qi(link.label)})${link.extra ? `, MIN(${qi(link.extra)})` : ''} FROM ${qi(link.table)} WHERE ${qi(link.key)} IN (${keys.map(() => '?').join(', ')}) GROUP BY 1`,
      params: keys,
    };
  }

  // Most common values of a column, for a control's picker. Searching matches
  // the value itself or, for an id, the name it stands for.
  function valuesQuery(base, col, text, link) {
    const params = [...base.params];
    let where = '';
    if (text) {
      const like = '%' + String(text).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      where = ` WHERE CAST(${qi(col)} AS TEXT) LIKE ? ESCAPE '\\'`;
      params.push(like);
      if (link) {
        where += ` OR ${qi(col)} IN (SELECT ${qi(link.key)} FROM ${qi(link.table)} WHERE CAST(${qi(link.label)} AS TEXT) LIKE ? ESCAPE '\\')`;
        params.push(like);
      }
    }
    return { sql: `SELECT ${qi(col)}, COUNT(*) FROM (${base.sql})${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 201`, params };
  }

  function bucketLabel(k, b) {
    if (k == null) return '(empty)';
    const s = String(k);
    switch (b) {
      case 'month': return MONTHS[+s.slice(5, 7) - 1] + ' ' + s.slice(2, 4);
      case 'monthOfYear': return MONTHS[+s - 1] || s;
      case 'weekday': return WEEKDAYS[+s] || s;
      case 'week': return 'w/c ' + +s.slice(8) + ' ' + MONTHS[+s.slice(5, 7) - 1] + ' ' + s.slice(2, 4);
      case 'day': return +s.slice(8) + ' ' + MONTHS[+s.slice(5, 7) - 1] + ' ' + s.slice(2, 4);
      default: return s;
    }
  }
  // The days a bucket covers, so clicking a month can set the date control.
  function bucketRange(k, b) {
    const s = String(k);
    if (b === 'day') return [s, s];
    if (b === 'year') return [s + '-01-01', s + '-12-31'];
    if (b === 'week') return [s, addDays(s, 6)];
    if (b === 'month') return [s + '-01', monthEnd(s)];
    if (b === 'quarter') { const q = +s.slice(6); return [`${s.slice(0, 4)}-${String(q * 3 - 2).padStart(2, '0')}-01`, monthEnd(`${s.slice(0, 4)}-${String(q * 3).padStart(2, '0')}`)]; }
    return null;
  }

  // =====================================================================
  // The interface
  // =====================================================================
  function create(ctx) {
    const { h, fmt, icon, menu, popover, closeLayer } = window.DBXDom;
    const PALETTE = ['#3d9970', '#2d6fb8', '#c1502a', '#b0700f', '#6b5bb5', '#d4537e', '#4f8a9e', '#8c8b84'];
    const TYPES = [['number', 'Number'], ['bars', 'Bars'], ['columns', 'Columns'], ['line', 'Line'], ['table', 'Table'], ['mix', 'Mix'], ['calendar', 'Calendar'], ['map', 'Map']];
    const FORMATS = [['number', '1,234'], ['gbp', '£1,234'], ['usd', '$1,234'], ['eur', '€1,234'], ['percent', '12%']];
    const SYMBOL = { gbp: '£', usd: '$', eur: '€' };
    const DEFAULTS = {
      title: 'New panel', note: '', type: 'bars', by: null, bucket: 'month', measures: [{ fn: 'count' }],
      sort: 'value', top: 10, other: false, color: PALETTE[0], colorBy: false, format: 'number', decimals: null,
      showPct: true, compare: true, spark: true, heat: true, fill: true, follow: true, names: true, blanks: false, w: 4, h: 4,
      lat: null, lon: null, mapStyle: 'heat', tiles: false, view: null, month: null,
    };
    const today = () => new Date().toISOString().slice(0, 10);
    const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const panel = (o) => ({ ...clone(DEFAULTS), id: newId(), ...o });

    // ---------- the page ----------
    const root = document.getElementById('dash-panel');
    const nameBox = h('span', { class: 'dash-name' });
    const controlsBox = h('div', { class: 'dash-controls' });
    const statusBox = h('span', { class: 'dash-status', role: 'status' });
    const layoutBtn = h('button', { class: 'tool', title: 'Drag panels to move them; drag a corner to resize', onclick: () => setLayout(!layoutMode) }, 'Edit layout');
    const grid = h('div', { class: 'dash-grid' });
    const scroller = h('div', { class: 'dash-scroll' }, grid);
    const drawer = h('aside', { class: 'drawer', hidden: true, 'aria-label': 'Edit panel' });
    root.append(
      h('div', { class: 'toolbar dash-toolbar', role: 'toolbar' },
        h('div', { class: 'tool-group' }, h('span', { class: 'tool-label' }, 'Dashboard'), nameBox),
        h('div', { class: 'tool-group' }, h('span', { class: 'tool-label' }, 'Controls'), controlsBox,
          h('button', { class: 'ghost small', title: 'Filter every panel that has a column', onclick: (e) => addControlMenu(e.currentTarget) }, '+ Add control')),
        h('span', { class: 'spacer' }), statusBox, layoutBtn,
        h('button', { class: 'primary', onclick: () => openAdd() }, 'Add panel')),
      h('div', { class: 'dash-body' }, scroller, drawer));
    const tip = h('div', { class: 'dash-tip', hidden: true });
    document.body.append(tip);

    // ---------- state ----------
    let state = null;
    let savedWhere = '';
    let layoutMode = false;
    let editing = null;
    let shown = false;
    const pstate = new Map(); // panel id -> { seq, data, visible, dirty }
    const pst = (id) => { if (!pstate.has(id)) pstate.set(id, { seq: 0, binSeq: 0, data: null, visible: false, dirty: true }); return pstate.get(id); };
    const D = () => state.dashboards.find((d) => d.id === state.active) || state.dashboards[0];
    const byId = (id) => D().panels.find((p) => p.id === id);
    const storeKey = () => 'dbx.dash:' + ctx.db().path;
    const blank = (name) => ({ id: newId(), name, controls: [], colors: {}, panels: [] });

    let loadSeq = 0;
    async function load() {
      const my = ++loadSeq; // only the latest database's dashboards may land
      stopAll();
      epoch++;
      running.clear();
      free.splice(0, free.length, ...LANES);
      pstate.clear();
      results.clear();
      profiles.clear();
      known.clear();
      ideasCache = null;
      closeDrawer();
      state = null;
      let data = null;
      try {
        const r = await ctx.api('dashboards', { id: ctx.db().id });
        data = r.data;
        savedWhere = `${data ? 'Saved to' : 'Will save to'} ${r.file.split(/[\\/]/).pop()}`;
      } catch (e) {
        savedWhere = e.message;
      }
      if (my !== loadSeq) return;
      if (!data) { try { data = JSON.parse(localStorage.getItem(storeKey()) || 'null'); } catch (_) { data = null; } }
      if (!data || !Array.isArray(data.dashboards) || !data.dashboards.length) data = { version: 1, active: null, dashboards: [blank('Dashboard')] };
      for (const d of data.dashboards) {
        d.controls = d.controls || [];
        d.colors = d.colors || {};
        d.panels = (d.panels || []).map((p) => ({ ...clone(DEFAULTS), ...p }));
      }
      data.active = data.dashboards.some((d) => d.id === data.active) ? data.active : data.dashboards[0].id;
      state = data;
      statusBox.textContent = '';
      if (shown) renderAll();
    }

    let saveTimer = null;
    function save() {
      clearTimeout(saveTimer);
      statusBox.replaceChildren(h('span', { class: 'muted' }, 'Saving…'));
      saveTimer = setTimeout(async () => {
        try {
          const r = await ctx.api('dashboards/save', { id: ctx.db().id, data: state });
          savedWhere = `Saved to ${r.file.split(/[\\/]/).pop()}`;
          try { localStorage.removeItem(storeKey()); } catch (_) { /* fine */ }
        } catch (e) {
          // e.g. the database's folder is read-only: keep them in this browser instead.
          try { localStorage.setItem(storeKey(), JSON.stringify(state)); } catch (_) { /* nowhere to keep them */ }
          savedWhere = `Kept in this browser. ${e.message}`;
        }
        showStatus();
      }, 500);
    }

    // ---------- running panel queries ----------
    // Three connections shared by every panel, so a big dashboard never opens
    // dozens. Results are cached by their SQL, so panels only re-query when what
    // they ask for changes. Changing a control drops queued work that's no
    // longer wanted.
    const LANES = ['dash0', 'dash1', 'dash2'];
    const free = [...LANES];
    const queue = [];
    const running = new Set();
    const inflight = new Map();
    const results = new Map();
    let gen = 0;
    let epoch = 0; // bumps when another database is opened

    function run(q, limit) {
      const k = q.sql + '\u0000' + JSON.stringify(q.params);
      if (results.has(k)) return Promise.resolve(results.get(k));
      if (inflight.has(k)) return inflight.get(k);
      const pr = new Promise((resolve, reject) => { queue.push({ q, limit: limit || 1000, resolve, reject, gen }); pump(); })
        .then((r) => {
          results.set(k, r);
          if (results.size > 300) results.delete(results.keys().next().value);
          return r;
        })
        .finally(() => { if (inflight.get(k) === pr) inflight.delete(k); });
      inflight.set(k, pr);
      return pr;
    }
    function pump() {
      while (free.length && queue.length) {
        const job = queue.shift();
        const lane = free.shift();
        const mine = epoch;
        running.add(job);
        job.lane = lane;
        job.dbId = ctx.db() && ctx.db().id;
        // Through a promise, so even an error thrown straight away frees the lane.
        Promise.resolve().then(() => ctx.query(job.q.sql, job.q.params, lane, job.limit)).then(job.resolve, job.reject).finally(() => {
          if (mine !== epoch) return; // from the database that was open before
          running.delete(job);
          free.push(lane);
          pump();
        });
      }
      showStatus();
    }
    // Something changed for every panel: forget queued queries (they'll be asked
    // for again if still wanted). Running ones finish; they're cached.
    function dropQueued() {
      gen++;
      for (const job of queue.splice(0)) job.reject(new ctx.CancelledError('dropped'));
      inflight.clear();
    }
    function stopAll() {
      dropQueued();
      // Each against the database it was sent to (it may not be the one open now).
      const byDb = new Map();
      for (const j of running) byDb.set(j.dbId, [...(byDb.get(j.dbId) || []), j.lane]);
      for (const [id, keys] of byDb) if (id) ctx.api('cancel', { id, keys }).catch(() => {});
    }
    function showStatus() {
      const n = queue.length + running.size;
      if (n) {
        statusBox.replaceChildren(h('span', { class: 'muted' }, `Loading ${n} quer${n === 1 ? 'y' : 'ies'}… `),
          h('button', { class: 'link small', onclick: stopAll }, 'Stop'));
      } else statusBox.replaceChildren(h('span', { class: 'muted', title: savedWhere }, savedWhere));
    }

    // ---------- panel data ----------
    const srcKey = (src) => (src.table ? 't:' + src.table : 's:' + JSON.stringify(src.steps));
    const srcName = (src) => (src.table || src.name || 'query');
    function compileSource(src) {
      const steps = src.table ? [{ type: 'source', table: src.table }] : src.steps;
      if (src.table && !ctx.schema().tables[src.table]) throw new Error(`There's no table “${src.table}” in this database`);
      const c = ctx.compile(steps);
      if (c.error) throw new Error(`This panel's data has a problem: ${c.error.message}`);
      return { sql: c.unsortedSql, params: c.params, cols: c.cols };
    }
    const profiles = new Map();
    const known = new Map(); // the same, once they've arrived
    function profile(src) {
      const k = srcKey(src);
      if (!profiles.has(k)) {
        const pr = (async () => {
          const b = compileSource(src);
          // For a table, 400 rows picked at random from across it (by rowid,
          // so it's instant); the first rows of a big table are rarely typical.
          const t = src.table && ctx.schema().tables[src.table];
          let rows = null, total = null;
          if (t && t.type === 'table') {
            try {
              total = num((await run({ sql: `SELECT MAX(rowid) FROM ${qi(src.table)}`, params: [] }, 1)).rows[0][0]);
              if (total > 600) {
                const ids = new Set();
                while (ids.size < 400) ids.add(1 + Math.floor(Math.random() * total));
                const r = await run({ sql: `SELECT * FROM ${qi(src.table)} WHERE rowid IN (${[...ids].join(',')})`, params: [] }, 400);
                if (r.rows.length >= 100 && r.columns.length === b.cols.length) rows = r.rows;
              }
            } catch (_) { /* a WITHOUT ROWID table: take the first rows instead */ }
          }
          if (!rows) rows = (await run({ sql: `SELECT * FROM (${b.sql}) LIMIT 400`, params: b.params }, 400)).rows;
          const prof = classify(b.cols, rows, ctx.isPk);
          prof.total = total || rows.length;
          known.set(k, prof);
          return prof;
        })();
        profiles.set(k, pr);
        pr.catch(() => profiles.delete(k));
      }
      return profiles.get(k);
    }
    const isMoney = (prof, m) => m.fn !== 'count' && m.fn !== 'distinct' && !!prof.cols[m.col] &&
      (prof.cols[m.col].decimal || MONEY_NAME.test(m.col));

    async function fetchPanel(p) {
      const prof = await profile(p.source);
      const base = compileSource(p.source);
      for (const m of p.measures) if (m.fn !== 'count' && !prof.cols[m.col]) throw new Error(`There's no column “${m.col}” in this panel's data any more`);
      const controls = D().controls;
      const opts = { today: today() };
      const out = { prof, money: p.measures.map((m) => isMoney(prof, m)) };
      if (p.type === 'number') {
        const q = numberQuery(p, base, prof, controls, opts);
        const r = await run(q, 1);
        const row = r.rows[0] || [];
        out.value = row[0];
        if (q.compare === 'range') out.delta = { cur: row[0], prev: row[1], label: 'vs the period before' };
        if (q.compare === 'latest') out.delta = { cur: row[1], prev: row[2], label: 'last 12 months vs the 12 before' };
        const sq = p.spark ? sparkQuery(p, base, prof, controls, opts) : null;
        if (sq) out.spark = (await run(sq, 600)).rows.map((x) => Number(x[1]) || 0);
        return out;
      }
      if (p.type === 'map') {
        out.base = base;
        out.bounds = (await run(boundsQuery(p, base, prof, controls, opts), 1)).rows[0];
        return out;
      }
      if (!p.by) throw new Error('Choose a column to group by (Edit)');
      if (p.type === 'calendar') {
        if (!prof.cols[p.by] || !prof.cols[p.by].date) throw new Error(`“${p.by}” doesn't look like a date column`);
        let month = pst(p.id).month || p.month;
        if (!month) month = (await run(latestMonthQuery(p, base, prof, controls, opts), 1)).rows[0][0] || today().slice(0, 7);
        pst(p.id).month = month;
        opts.month = [month + '-01', monthEnd(month)];
        out.month = month;
      }
      const q = groupQuery(p, base, prof, controls, opts);
      const needTotal = p.showPct || p.other || p.type === 'mix';
      const [r, t] = await Promise.all([run(q, q.limit + 1), needTotal ? run(totalQuery(p, base, prof, controls, opts), 1) : null]);
      out.bucket = q.bucket;
      out.more = r.rows.length > q.limit;
      out.groups = r.rows.slice(0, q.limit).map((row) => ({ key: row[0], label: label(row[0], q.bucket), values: row.slice(1).map(num) }));
      out.total = t ? t.rows[0].map(num) : null;
      await addNames(p, base, out);
      if (p.other && out.more && out.total && ['count', 'sum'].includes(p.measures[0].fn)) {
        const shownSum = (i) => out.groups.reduce((n, g) => n + (g.values[i] || 0), 0);
        out.groups.push({ key: undefined, other: true, label: 'Other', values: p.measures.map((m, i) => (['count', 'sum'].includes(m.fn) ? out.total[i] - shownSum(i) : null)) });
        out.more = false;
      }
      return out;
    }
    // Show the names behind ids (venue_id 12 -> "O2 Arena"): one small lookup
    // for just the ids on show. Repeated names keep their id, to tell them apart.
    async function addNames(p, base, out) {
      if (out.bucket || p.names === false) return;
      const link = labelLink(p) || nameLink(base.cols.find((c) => c.name === p.by), ctx.schema());
      out.link = link;
      const keys = out.groups.filter((g) => !g.other && g.key != null).map((g) => g.key);
      if (!link || !keys.length) return;
      const r = await run(namesQuery(link, keys), keys.length);
      const names = new Map(r.rows.map(([k, v, x]) => [JSON.stringify(k), [v, x]]));
      const seen = new Map();
      for (const [v] of names.values()) seen.set(v, (seen.get(v) || 0) + 1);
      for (const g of out.groups) {
        const [n, x] = names.get(JSON.stringify(g.key)) || [];
        // Venues always get their city ("Grote Zaal, Amsterdam"); other names only when repeated.
        if (n != null && n !== '') g.label = link.alwaysExtra && x ? `${n}, ${x}` : seen.get(n) > 1 ? `${n} (${x || label(g.key)})` : String(n);
      }
    }
    // Grouped by a fast, indexed key (headliner_key) but shown by its readable
    // twin in the same table (headliner): the names are looked up for the top
    // few keys only.
    const labelLink = (p) => (p.labelFrom && p.source.table ? { table: p.source.table, key: p.by, label: p.labelFrom, extra: p.labelExtra || null, alwaysExtra: !!p.labelExtra } : null);
    const num = (v) => (v != null && typeof v === 'object' && v.$int != null ? Number(v.$int) : v);
    function label(v, bucket) {
      if (bucket) return bucketLabel(v, bucket);
      if (v == null) return '(empty)';
      if (v === '') return '(blank)';
      if (typeof v === 'object') return v.$int ?? v.$text ?? (v.$blob != null ? '[binary]' : '');
      return String(v);
    }

    // ---------- formatting ----------
    function fmtV(v, p, data, i, compact) {
      if (v == null || Number.isNaN(v)) return '–';
      const m = p.measures[i] || p.measures[0];
      const whole = m.fn === 'count' || m.fn === 'distinct';
      const money = data && data.money[i] && SYMBOL[p.format];
      const pct = !whole && p.format === 'percent';
      const pre = money ? SYMBOL[p.format] : '';
      if (compact && Math.abs(v) >= 10000) {
        for (const [n, u] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) {
          if (Math.abs(v) >= n) return pre + (v / n).toFixed(Math.abs(v / n) >= 100 ? 0 : 1) + u;
        }
      }
      const d = whole ? 0 : p.decimals ?? (money ? (Math.abs(v) < 100 && !Number.isInteger(v) ? 2 : 0) : Number.isInteger(v) || Math.abs(v) >= 1000 ? 0 : Math.abs(v) < 10 ? 2 : 1);
      return pre + Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) + (pct ? '%' : '');
    }
    const pctOf = (v, t) => (t ? Math.round(100 * v / t) + '%' : '');
    function colourFor(p, g, i) {
      if (g.other) return '#8c8b84';
      const set = D().colors[p.by] || {};
      return set[JSON.stringify(g.key)] || PALETTE[i % PALETTE.length];
    }

    function showTip(e, ...lines) {
      tip.replaceChildren(...lines.filter(Boolean).map((l, i) => h('div', null, i === 0 ? h('b', null, l) : l)));
      tip.hidden = false;
      tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px';
      tip.style.top = Math.max(8, e.clientY - tip.offsetHeight - 10) + 'px';
    }
    const hideTip = () => { tip.hidden = true; };

    // ---------- clicking a chart sets a control ----------
    const chosen = (p) => { const c = D().controls.find((x) => x.col === p.by && x.kind === 'choice'); return c && 'value' in c ? c.value : undefined; };
    const isChosen = (p, g) => { const v = chosen(p); return v !== undefined && same(v, g.key); };
    const dimmed = (p, g) => { const v = chosen(p); return v !== undefined && !same(v, g.key); };
    function crossFilter(p, g, data) {
      if (!p.by || g.other) return;
      const d = D();
      if (data.bucket) {
        const r = bucketRange(g.key, data.bucket);
        if (!r) return ctx.toast('Days of the week and months of the year can’t become a date range.');
        let c = d.controls.find((x) => x.col === p.by && x.kind === 'dates');
        if (!c) d.controls.push(c = { id: newId(), col: p.by, kind: 'dates', preset: 'all' });
        c.preset = 'custom'; c.from = r[0]; c.to = r[1];
        ctx.toast(`${p.by}: ${g.label}. Every panel with ${p.by} follows.`);
      } else {
        let c = d.controls.find((x) => x.col === p.by && x.kind === 'choice');
        if (!c) d.controls.push(c = { id: newId(), col: p.by, kind: 'choice', source: clone(p.source) });
        if ('value' in c && same(c.value, g.key)) { delete c.value; delete c.label; } else { c.value = g.key; c.label = g.label; }
        ctx.toast('value' in c ? `${p.by} = ${g.label}. Every panel with ${p.by} follows.` : `${p.by}: all`);
      }
      controlsChanged();
    }
    function controlsChanged() {
      save();
      dropQueued();
      renderControls();
      renderPanels();
    }

    // ---------- drawing ----------
    const NS = 'http://www.w3.org/2000/svg';
    function s(tag, attrs, ...kids) {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null || v === false) continue;
        if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v);
      }
      for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
      return el;
    }
    function niceTicks(max, n) {
      if (!(max > 0)) return [0, 1];
      const raw = max / n;
      const mag = 10 ** Math.floor(Math.log10(raw));
      const step = [1, 2, 2.5, 5, 10].map((x) => x * mag).find((x) => x >= raw);
      const out = [];
      for (let v = 0; v < max + step * 0.999; v += step) out.push(v);
      return out;
    }
    const note = (text) => h('p', { class: 'muted small' }, text);
    // replaceChildren would show null as the text "null"
    const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false && k !== ''));

    function drawNumber(p, body, data) {
      const w = body.clientWidth;
      let spark = null;
      if (data.spark && data.spark.length > 1 && w > 200) {
        const pts = data.spark;
        const sw = Math.min(w * 0.42, 160), sh = 30, max = Math.max(...pts), min = Math.min(...pts);
        const x = (i) => i / (pts.length - 1) * sw;
        const y = (v) => sh - 2 - (max === min ? 0.5 : (v - min) / (max - min)) * (sh - 4);
        spark = s('svg', { class: 'chart', width: sw, height: sh },
          s('path', { d: pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(''), fill: 'none', stroke: p.color, 'stroke-width': 1.5 }),
          s('circle', { cx: x(pts.length - 1), cy: y(pts[pts.length - 1]), r: 2.5, fill: p.color }));
      }
      const dl = data.delta;
      const pct = dl && dl.prev ? (num(dl.cur) - num(dl.prev)) / Math.abs(num(dl.prev)) * 100 : null;
      put(body, h('div', { class: 'num' },
        h('div', { class: 'num-row' }, h('div', { class: 'num-value' }, fmtV(num(data.value), p, data, 0, w < 200)), spark),
        h('div', { class: 'num-cap' }, p.note || mLabel(p.measures[0])),
        pct != null ? h('div', { class: 'delta ' + (pct >= 0 ? 'up' : 'down') }, (pct >= 0 ? '+' : '') + pct.toFixed(1) + '% ', h('span', null, dl.label)) : null));
    }

    function drawBars(p, body, data) {
      const gs = data.groups;
      const fit = Math.max(1, Math.floor((body.clientHeight - 6) / 19));
      const show = gs.slice(0, fit);
      const max = Math.max(...show.map((g) => g.values[0] || 0), 1);
      const hidden = gs.length - show.length;
      put(body, h('div', { class: 'hb' },
        show.map((g, i) => h('div', {
          class: 'hb-row' + (isChosen(p, g) ? ' on' : '') + (dimmed(p, g) ? ' dim' : ''), onclick: () => crossFilter(p, g, data),
          onmousemove: (e) => showTip(e, g.label, `${mLabel(p.measures[0])}: ${fmtV(g.values[0], p, data, 0)}`, data.total ? `${pctOf(g.values[0], data.total[0])} of the total` : null, g.other ? null : 'Click to filter the dashboard'),
          onmouseleave: hideTip,
        },
        h('div', { class: 'hb-label', title: g.label }, g.label),
        h('div', { class: 'hb-track' }, h('div', { class: 'hb-fill', style: `width:${(100 * Math.max(0, g.values[0] || 0) / max).toFixed(1)}%;background:${p.colorBy ? colourFor(p, g, i) : g.other ? '#8c8b84' : p.color}` })),
        h('div', { class: 'hb-val' }, fmtV(g.values[0], p, data, 0, true), p.showPct && data.total ? h('span', null, pctOf(g.values[0], data.total[0])) : null))),
        !gs.length ? note('No rows.') : null,
        hidden > 0 || data.more ? h('div', { class: 'more-note' }, hidden > 0 ? `+ ${hidden} more: make the panel taller to see them.` : `Showing the top ${gs.length}.`) : null));
    }

    function axes(svgEl, W, m, ticks, y, p, data) {
      for (const t of ticks) {
        svgEl.append(s('line', { class: 'gl', x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }),
          s('text', { x: m.l - 6, y: y(t) + 3.5, 'text-anchor': 'end' }, fmtV(t, p, data, 0, true)));
      }
    }
    function xLabels(svgEl, gs, x, H, m, iw) {
      const every = Math.max(1, Math.ceil(gs.length / Math.max(1, Math.floor(iw / 56))));
      gs.forEach((g, i) => { if (i % every === 0) svgEl.append(s('text', { x: x(i), y: H - m.b + 14, 'text-anchor': 'middle' }, g.label.length > 11 ? g.label.slice(0, 10) + '…' : g.label)); });
    }
    const seriesColour = (p, i) => (i === 0 ? p.color : PALETTE[(PALETTE.indexOf(p.color) + i + PALETTE.length) % PALETTE.length]);

    function drawLine(p, body, data) {
      const gs = data.groups;
      const multi = p.measures.length > 1;
      const W = body.clientWidth - 20, H = body.clientHeight - 8 - (multi ? 20 : 0);
      if (!gs.length) return put(body, note('No rows.'));
      const m = { l: 50, r: 10, t: 8, b: 20 };
      const iw = W - m.l - m.r, ih = H - m.t - m.b;
      const max = Math.max(0, ...gs.flatMap((g) => g.values.filter((v) => v != null)));
      const ticks = niceTicks(max, Math.max(2, Math.floor(ih / 40)));
      const top = ticks[ticks.length - 1] || 1;
      const x = (i) => m.l + (gs.length < 2 ? iw / 2 : i * iw / (gs.length - 1));
      const y = (v) => m.t + ih - (v / top) * ih;
      const svgEl = s('svg', { class: 'chart', width: W, height: H });
      axes(svgEl, W, m, ticks, y, p, data);
      xLabels(svgEl, gs, x, H, m, iw);
      p.measures.forEach((mm, si) => {
        const pts = gs.map((g, i) => [x(i), y(g.values[si] || 0)]);
        const d = pts.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}`).join('');
        if (p.fill && si === 0) svgEl.append(s('path', { d: `${d}L${pts[pts.length - 1][0]},${m.t + ih}L${pts[0][0]},${m.t + ih}Z`, fill: seriesColour(p, 0), opacity: 0.1 }));
        svgEl.append(s('path', { d, fill: 'none', stroke: seriesColour(p, si), 'stroke-width': 2, 'stroke-linejoin': 'round' }));
        if (gs.length === 1) svgEl.append(s('circle', { cx: pts[0][0], cy: pts[0][1], r: 3, fill: seriesColour(p, si) }));
      });
      const guide = s('line', { class: 'guide', y1: m.t, y2: m.t + ih, visibility: 'hidden' });
      const dots = p.measures.map((_, si) => s('circle', { r: 3.5, fill: seriesColour(p, si), visibility: 'hidden' }));
      svgEl.append(guide, ...dots);
      const idx = (e) => { const r = svgEl.getBoundingClientRect(); return clamp(Math.round((e.clientX - r.left - m.l) / (iw / Math.max(1, gs.length - 1))), 0, gs.length - 1); };
      svgEl.append(s('rect', {
        x: m.l, y: m.t, width: Math.max(0, iw), height: Math.max(0, ih), fill: 'transparent', style: 'cursor:pointer',
        onmousemove: (e) => {
          const i = idx(e); const g = gs[i];
          guide.setAttribute('x1', x(i)); guide.setAttribute('x2', x(i)); guide.setAttribute('visibility', 'visible');
          dots.forEach((dt, si) => { dt.setAttribute('cx', x(i)); dt.setAttribute('cy', y(g.values[si] || 0)); dt.setAttribute('visibility', 'visible'); });
          showTip(e, g.label, ...p.measures.map((mm, si) => `${mLabel(mm)}: ${fmtV(g.values[si], p, data, si)}`), data.bucket && bucketRange(g.key, data.bucket) ? 'Click to filter to this ' + data.bucket : null);
        },
        onmouseleave: () => { hideTip(); guide.setAttribute('visibility', 'hidden'); dots.forEach((dt) => dt.setAttribute('visibility', 'hidden')); },
        onclick: (e) => crossFilter(p, gs[idx(e)], data),
      }));
      put(body, multi ? h('div', { class: 'legend' }, p.measures.map((mm, i) => h('span', null, h('i', { style: `background:${seriesColour(p, i)}` }), mLabel(mm)))) : '', svgEl);
    }

    function drawColumns(p, body, data) {
      const gs = data.groups;
      const W = body.clientWidth - 20, H = body.clientHeight - 8;
      if (!gs.length) return put(body, note('No rows.'));
      const m = { l: 46, r: 6, t: 14, b: 20 };
      const iw = W - m.l - m.r, ih = H - m.t - m.b;
      const max = Math.max(0, ...gs.map((g) => g.values[0] || 0));
      const ticks = niceTicks(max, Math.max(2, Math.floor(ih / 40)));
      const top = ticks[ticks.length - 1] || 1;
      const bw = iw / gs.length;
      const x = (i) => m.l + bw * (i + 0.5);
      const y = (v) => m.t + ih - (Math.max(0, v) / top) * ih;
      const svgEl = s('svg', { class: 'chart', width: W, height: H });
      axes(svgEl, W, m, ticks, y, p, data);
      xLabels(svgEl, gs, x, H, m, iw);
      gs.forEach((g, i) => {
        const v = g.values[0] || 0;
        svgEl.append(s('rect', {
          class: 'col' + (dimmed(p, g) ? ' dim' : ''), x: x(i) - bw * 0.36, width: bw * 0.72, y: y(v), height: Math.max(0, m.t + ih - y(v)),
          fill: p.colorBy ? colourFor(p, g, i) : g.other ? '#8c8b84' : p.color, style: 'cursor:pointer',
          onmousemove: (e) => showTip(e, g.label, `${mLabel(p.measures[0])}: ${fmtV(v, p, data, 0)}`, data.total ? `${pctOf(v, data.total[0])} of the total` : null),
          onmouseleave: hideTip, onclick: () => crossFilter(p, g, data),
        }));
        if (bw > 36) svgEl.append(s('text', { class: 'val', x: x(i), y: y(v) - 4, 'text-anchor': 'middle' }, fmtV(v, p, data, 0, true)));
      });
      put(body, svgEl);
    }

    function drawTable(p, body, data) {
      const gs = data.groups;
      const stats = p.measures.map((_, i) => {
        const v = gs.filter((g) => !g.other).map((g) => g.values[i]).filter((x) => x != null).sort((a, b) => a - b);
        return { min: v[0], max: v[v.length - 1], mid: v[Math.floor(v.length / 2)] };
      });
      // Data Golf-style shading: green above the middle value, red below.
      const shade = (v, st) => {
        if (!p.heat || v == null || st.max === st.min) return null;
        const t = v >= st.mid ? (v - st.mid) / ((st.max - st.mid) || 1) : (st.mid - v) / ((st.mid - st.min) || 1);
        return `background:color-mix(in srgb, ${v >= st.mid ? 'var(--green)' : 'var(--danger)'} ${Math.round(6 + 30 * t)}%, transparent)`;
      };
      put(body, h('table', { class: 'dtable' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', { title: data.link ? `${p.by}, shown as ${data.link.table}.${data.link.label}` : null }, data.link && p.names !== false ? data.link.label : p.by), p.measures.map((mm) => h('th', { class: 'n' }, mLabel(mm))))),
        h('tbody', null, gs.map((g, r) => h('tr', { class: dimmed(p, g) ? 'dim' : null, onclick: () => crossFilter(p, g, data), title: g.other ? null : 'Click to filter the dashboard' },
          h('td', { class: 'rank' }, g.other ? '' : r + 1), h('td', { class: g.key == null || g.key === '' ? 'muted' : null }, g.label),
          p.measures.map((mm, i) => h('td', { class: 'n', style: g.other ? null : shade(g.values[i], stats[i]) }, fmtV(g.values[i], p, data, i))))))),
      !gs.length ? note('No rows.') : null,
      data.more ? h('div', { class: 'more-note' }, `Showing the top ${gs.length}.`) : null);
    }

    function drawMix(p, body, data) {
      const gs = data.groups;
      const t = (data.total && data.total[0]) || gs.reduce((n, g) => n + (g.values[0] || 0), 0) || 1;
      const tipFor = (g) => (e) => showTip(e, g.label, `${fmtV(g.values[0], p, data, 0)} · ${pctOf(g.values[0], t)}`, g.other ? null : 'Click to filter the dashboard');
      put(body, 
        h('div', { class: 'mix-bar' }, gs.map((g, i) => h('div', {
          class: dimmed(p, g) ? 'dim' : null, style: `width:${100 * Math.max(0, g.values[0] || 0) / t}%;background:${colourFor(p, g, i)}`,
          onmousemove: tipFor(g), onmouseleave: hideTip, onclick: () => crossFilter(p, g, data),
        }))),
        h('div', { class: 'mix-legend' }, gs.map((g, i) => h('div', { class: 'mix-item' + (dimmed(p, g) ? ' dim' : ''), onclick: () => crossFilter(p, g, data) },
          h('i', { style: `background:${colourFor(p, g, i)}` }), h('span', { class: 'l', title: g.label }, g.label),
          h('b', null, fmtV(g.values[0], p, data, 0, true)), p.showPct ? h('span', { class: 'p' }, pctOf(g.values[0], t)) : null))),
        data.more ? h('div', { class: 'more-note' }, `Showing the top ${gs.length}; tick “Add the rest together as Other” to include the rest.`) : null);
    }

    function drawCalendar(p, body, data) {
      const month = data.month;
      const vals = new Map(data.groups.map((g) => [String(g.key), g.values[0]]));
      const max = Math.max(1, ...data.groups.map((g) => g.values[0] || 0));
      const f = month + '-01';
      const n = +monthEnd(month).slice(8);
      const lead = (new Date(f + 'T00:00:00Z').getUTCDay() + 6) % 7;
      const weeks = Math.ceil((lead + n) / 7);
      const rowH = Math.max(16, Math.floor((body.clientHeight - 44 - weeks * 3) / weeks));
      const go = (d) => {
        const dt = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 + d, 1));
        p.month = pst(p.id).month = dt.toISOString().slice(0, 7);
        save();
        loadPanel(p);
      };
      const monthTotal = data.groups.reduce((a, g) => a + (g.values[0] || 0), 0);
      const cells = [];
      for (let i = 0; i < weeks * 7; i++) {
        const day = i - lead + 1;
        if (day < 1 || day > n) { cells.push(h('div', { class: 'day out', style: `height:${rowH}px` })); continue; }
        const key = month + '-' + String(day).padStart(2, '0');
        const v = vals.get(key);
        const a = v ? Math.round(12 + 70 * v / max) : 0;
        cells.push(h('div', {
          class: 'day', style: `height:${rowH}px;${v ? `background:color-mix(in srgb, ${p.color} ${a}%, var(--surface));${a > 55 ? 'color:#fff' : ''}` : ''}`,
          onmousemove: (e) => showTip(e, bucketLabel(key, 'day'), `${mLabel(p.measures[0])}: ${fmtV(v || 0, p, data, 0)}`, v ? 'Click to filter to this day' : null),
          onmouseleave: hideTip, onclick: () => v && crossFilter(p, { key, label: bucketLabel(key, 'day') }, { bucket: 'day' }),
        }, h('b', null, day), rowH > 30 && v ? h('span', null, fmtV(v, p, data, 0, true)) : ''));
      }
      put(body, 
        h('div', { class: 'cal-nav' },
          h('button', { class: 'icon', title: 'Previous month', onclick: () => go(-1) }, icon('left')),
          h('span', null, MONTHS[+month.slice(5, 7) - 1] + ' ' + month.slice(0, 4)),
          h('button', { class: 'icon', title: 'Next month', onclick: () => go(1) }, icon('right')),
          h('span', { class: 'muted small cal-total' }, `${fmtV(monthTotal, p, data, 0)} this month`)),
        h('div', { class: 'cal' }, WEEKDAYS.map((d) => h('div', { class: 'dow' }, d)), cells));
    }

    // ---------- map ----------
    // Web Mercator, drawn on a canvas. World coordinates run 0..1 across and down.
    const TILE = 256;
    function project(lat, lon) {
      const sn = Math.sin(clamp(lat, -85, 85) * Math.PI / 180);
      return [(lon + 180) / 360, 0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)];
    }
    const unproject = (x, y) => [Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI, x * 360 - 180];
    const tiles = new Map(); // url -> Image
    const HEAT = (() => { // alpha -> colour, light green through green and amber to red
      const c = document.createElement('canvas');
      c.width = 256; c.height = 1;
      const g = c.getContext('2d');
      const gr = g.createLinearGradient(0, 0, 256, 0);
      [[0, '#cfe6da'], [0.3, '#3d9970'], [0.6, '#b0700f'], [1, '#c1502a']].forEach(([o, col]) => gr.addColorStop(o, col));
      g.fillStyle = gr;
      g.fillRect(0, 0, 256, 1);
      return g.getImageData(0, 0, 256, 1).data;
    })();
    const SPRITE = (() => { // one soft blob, stamped for every cell
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(0,0,0,1)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 64, 64);
      return c;
    })();

    function fitView(b, W, H) {
      const [s0, n0, w0, e0] = [num(b[0]), num(b[1]), num(b[2]), num(b[3])];
      if (s0 == null) return { x: 0.5, y: 0.5, z: 1 };
      const [x1, y1] = project(n0, w0);
      const [x2, y2] = project(s0, e0);
      const dx = Math.max(x2 - x1, 1e-7), dy = Math.max(y2 - y1, 1e-7);
      const z = clamp(Math.log2(Math.min((W - 40) / (dx * TILE), (H - 40) / (dy * TILE))), 1, 15);
      return { x: (x1 + x2) / 2, y: (y1 + y2) / 2, z };
    }

    function drawMap(p, body, data) {
      const ps = pst(p.id);
      const W = Math.max(50, body.clientWidth), H = Math.max(50, body.clientHeight);
      if (!data.bounds || !num(data.bounds[4])) return put(body, note('No rows with a latitude and longitude.'));
      if (!ps.view) ps.view = p.view ? { ...p.view } : fitView(data.bounds, W, H);
      const v = ps.view;
      const canvas = h('canvas', { class: 'map-canvas', width: W * devicePixelRatio, height: H * devicePixelRatio, style: `width:${W}px;height:${H}px` });
      const g = canvas.getContext('2d');
      const css = getComputedStyle(document.documentElement);
      const WS = () => TILE * 2 ** v.z;
      const toScreen = (lat, lon) => { const [x, y] = project(lat, lon); return [(x - v.x) * WS() + W / 2, (y - v.y) * WS() + H / 2]; };

      function cellFor() {
        const zq = Math.round(v.z * 2) / 2;
        const lonStep = 360 / (TILE * 2 ** zq) * 7; // about 7px cells
        const [latC] = unproject(v.x, v.y);
        const latStep = lonStep * Math.max(0.05, Math.cos(latC * Math.PI / 180));
        const [n, w] = unproject(v.x - W / WS(), v.y - H / WS());
        const [sLat, e] = unproject(v.x + W / WS(), v.y + H / WS());
        const snap = (x, st, up) => (up ? Math.ceil(x / (st * 20)) : Math.floor(x / (st * 20))) * st * 20;
        return { latStep, lonStep, s: snap(sLat, latStep), n: snap(n, latStep, true), w: snap(w, lonStep), e: snap(e, lonStep, true) };
      }

      let bins = ps.bins && ps.binsFor === JSON.stringify(D().controls) + srcKey(p.source) + p.lat + p.lon + JSON.stringify(p.measures[0]) ? ps.bins : null;
      let fetchTimer = null;
      async function fetchBins() {
        const cell = cellFor();
        const seq = ++ps.binSeq;
        try {
          const r = await run(binsQuery(p, data.base, data.prof, D().controls, { today: today() }, cell), 40001);
          if (seq !== ps.binSeq) return;
          bins = r.rows.map(([i, j, val]) => ({ lat: num(i) * cell.latStep, lon: num(j) * cell.lonStep, v: num(val) || 0 }));
          ps.bins = bins;
          ps.binsFor = JSON.stringify(D().controls) + srcKey(p.source) + p.lat + p.lon + JSON.stringify(p.measures[0]);
          ps.truncated = r.rows.length > 40000 || r.more;
          paint();
        } catch (e) {
          if (!(e instanceof ctx.CancelledError)) body.querySelector('.map-msg')?.replaceChildren(e.message);
        }
      }
      const later = () => { clearTimeout(fetchTimer); fetchTimer = setTimeout(fetchBins, 250); };

      function paint() {
        g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
        g.fillStyle = css.getPropertyValue('--surface-2').trim() || '#f0f0f0';
        g.fillRect(0, 0, W, H);
        if (p.tiles) paintTiles(); else paintGrid();
        if (bins && bins.length) (p.mapStyle === 'dots' ? paintDots : paintHeat)();
      }
      function paintTiles() {
        const tz = clamp(Math.round(v.z), 0, 18);
        const scale = 2 ** (v.z - tz);
        const size = TILE * scale;
        const n = 2 ** tz;
        const cx = v.x * n, cy = v.y * n;
        const x0 = Math.floor(cx - W / 2 / size), x1 = Math.floor(cx + W / 2 / size);
        const y0 = Math.max(0, Math.floor(cy - H / 2 / size)), y1 = Math.min(n - 1, Math.floor(cy + H / 2 / size));
        for (let tx = x0; tx <= x1; tx++) {
          for (let ty = y0; ty <= y1; ty++) {
            const wx = ((tx % n) + n) % n;
            const url = `https://tile.openstreetmap.org/${tz}/${wx}/${ty}.png`;
            let img = tiles.get(url);
            if (!img) {
              img = new Image();
              img.src = url;
              img.onload = () => { if (canvas.isConnected) paint(); };
              tiles.set(url, img);
              if (tiles.size > 400) tiles.delete(tiles.keys().next().value);
            }
            if (img.complete && img.naturalWidth) g.drawImage(img, (tx - cx) * size + W / 2, (ty - cy) * size + H / 2, size + 0.5, size + 0.5);
          }
        }
        g.globalAlpha = 0.25;
        g.fillStyle = css.getPropertyValue('--surface').trim() || '#fff';
        g.fillRect(0, 0, W, H);
        g.globalAlpha = 1;
      }
      function paintGrid() {
        const span = 360 / 2 ** v.z;
        const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30].find((x) => x >= span / 2.5) || 30;
        g.strokeStyle = css.getPropertyValue('--border').trim() || '#ddd';
        g.fillStyle = css.getPropertyValue('--muted').trim() || '#777';
        g.lineWidth = 1;
        g.font = '10px ' + (css.getPropertyValue('--font') || 'sans-serif');
        const [n, w] = unproject(v.x - W / 2 / WS(), v.y - H / 2 / WS());
        const [sLat, e] = unproject(v.x + W / 2 / WS(), v.y + H / 2 / WS());
        const dec = step < 1 ? String(step).split('.')[1].length : 0;
        for (let lon = Math.ceil(w / step) * step; lon <= e; lon += step) {
          const [x] = toScreen(0, lon);
          g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke();
          g.fillText(lon.toFixed(dec) + '°', x + 3, H - 4);
        }
        for (let lat = Math.ceil(sLat / step) * step; lat <= n; lat += step) {
          const [, y] = toScreen(lat, 0);
          g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke();
          g.fillText(lat.toFixed(dec) + '°', 3, y - 3);
        }
      }
      function paintHeat() {
        const off = document.createElement('canvas');
        off.width = W; off.height = H;
        const og = off.getContext('2d');
        const max = Math.max(...bins.map((b) => b.v)) || 1;
        const r = clamp(Math.abs(toScreen(0, cellFor().lonStep)[0] - toScreen(0, 0)[0]) * 2.4, 10, 36);
        for (const b of bins) {
          const [x, y] = toScreen(b.lat, b.lon);
          if (x < -r || y < -r || x > W + r || y > H + r) continue;
          og.globalAlpha = clamp(0.06 + 0.5 * Math.sqrt(b.v / max), 0.04, 1);
          og.drawImage(SPRITE, x - r, y - r, r * 2, r * 2);
        }
        const img = og.getImageData(0, 0, W, H);
        const px = img.data;
        for (let i = 0; i < px.length; i += 4) {
          const a = px[i + 3];
          if (a < 4) { px[i + 3] = 0; continue; }
          const o = a * 4;
          px[i] = HEAT[o]; px[i + 1] = HEAT[o + 1]; px[i + 2] = HEAT[o + 2];
          px[i + 3] = Math.min(235, 70 + a);
        }
        og.putImageData(img, 0, 0);
        g.drawImage(off, 0, 0, W, H);
      }
      function paintDots() {
        const max = Math.max(...bins.map((b) => b.v)) || 1;
        g.fillStyle = p.color;
        g.strokeStyle = 'rgba(255,255,255,.8)';
        g.globalAlpha = 0.7;
        for (const b of bins) {
          const [x, y] = toScreen(b.lat, b.lon);
          if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
          const r = 2 + 9 * Math.sqrt(b.v / max);
          g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
        }
        g.globalAlpha = 1;
      }
      function nearest(e) {
        if (!bins) return null;
        const rc = canvas.getBoundingClientRect();
        const mx = e.clientX - rc.left, my = e.clientY - rc.top;
        let best = null, bd = 14 * 14;
        for (const b of bins) {
          const [x, y] = toScreen(b.lat, b.lon);
          const d = (x - mx) ** 2 + (y - my) ** 2;
          if (d < bd) { bd = d; best = b; }
        }
        return best;
      }
      const remember = () => { p.view = { ...v }; save(); };

      let drag = null;
      canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y }; canvas.setPointerCapture(e.pointerId); hideTip(); });
      canvas.addEventListener('pointermove', (e) => {
        if (drag) {
          v.x = drag.vx - (e.clientX - drag.x) / WS();
          v.y = clamp(drag.vy - (e.clientY - drag.y) / WS(), 0, 1);
          paint();
          return;
        }
        const b = nearest(e);
        if (b) showTip(e, fmtV(b.v, p, data, 0), mLabel(p.measures[0]), `around ${b.lat.toFixed(3)}, ${b.lon.toFixed(3)}`);
        else hideTip();
      });
      canvas.addEventListener('pointerup', () => { if (drag && (drag.vx !== v.x || drag.vy !== v.y)) { later(); remember(); } drag = null; });
      canvas.addEventListener('mouseleave', hideTip);
      const zoomAt = (mx, my, dz) => {
        const wx = v.x + (mx - W / 2) / WS(), wy = v.y + (my - H / 2) / WS();
        v.z = clamp(v.z + dz, 1, 18);
        v.x = wx - (mx - W / 2) / WS();
        v.y = clamp(wy - (my - H / 2) / WS(), 0, 1);
        paint(); later(); remember();
      };
      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rc = canvas.getBoundingClientRect();
        zoomAt(e.clientX - rc.left, e.clientY - rc.top, e.deltaY < 0 ? 0.5 : -0.5);
      }, { passive: false });
      canvas.addEventListener('dblclick', (e) => { const rc = canvas.getBoundingClientRect(); zoomAt(e.clientX - rc.left, e.clientY - rc.top, 1); });

      const controls = h('div', { class: 'map-buttons' },
        h('button', { class: 'small', title: 'Zoom in', onclick: () => zoomAt(W / 2, H / 2, 1) }, '+'),
        h('button', { class: 'small', title: 'Zoom out', onclick: () => zoomAt(W / 2, H / 2, -1) }, '−'),
        h('button', { class: 'small', title: 'Show all the points', onclick: () => { Object.assign(v, fitView(data.bounds, W, H)); paint(); later(); remember(); } }, 'Fit'));
      const foot = p.tiles
        ? h('div', { class: 'map-attrib' }, '© ', h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, 'OpenStreetMap'), ' contributors')
        : h('button', {
          class: 'map-attrib link small', title: 'Loads map pictures from openstreetmap.org, so it needs the internet',
          onclick: () => { p.tiles = true; save(); drawMap(p, body, data); },
        }, 'Show a street map (online)');
      put(body, canvas, controls, foot, h('div', { class: 'map-msg' }, ps.truncated ? 'Busy area: zoom in for more detail.' : ''));
      paint();
      if (!bins) fetchBins();
    }

    const DRAW = { number: drawNumber, bars: drawBars, columns: drawColumns, line: drawLine, table: drawTable, mix: drawMix, calendar: drawCalendar, map: drawMap };

    function glyph(type) {
      const g = { class: 'glyph', viewBox: '0 0 30 20' };
      switch (type) {
        case 'number': return s('svg', g, s('text', { x: 2, y: 15, class: 'gt' }, '123'));
        case 'bars': return s('svg', g, s('rect', { class: 'f', x: 3, y: 3, width: 22, height: 3 }), s('rect', { class: 'f', x: 3, y: 9, width: 15, height: 3 }), s('rect', { class: 'f', x: 3, y: 15, width: 9, height: 3 }));
        case 'columns': return s('svg', g, s('rect', { class: 'f', x: 4, y: 8, width: 4, height: 11 }), s('rect', { class: 'f', x: 11, y: 3, width: 4, height: 16 }), s('rect', { class: 'f', x: 18, y: 11, width: 4, height: 8 }));
        case 'line': return s('svg', g, s('path', { d: 'M2 16L9 9L15 12L21 4L28 7' }));
        case 'table': return s('svg', g, s('path', { d: 'M3 3h24v14H3zM3 8h24M3 12.5h24M11 3v14' }));
        case 'mix': return s('svg', g, s('rect', { class: 'f', x: 2, y: 7, width: 12, height: 6 }), s('rect', { x: 14, y: 7, width: 8, height: 6, style: 'fill:#2d6fb8;stroke:none' }), s('rect', { x: 22, y: 7, width: 6, height: 6, style: 'fill:#b0700f;stroke:none' }));
        case 'map': return s('svg', g, s('path', { d: 'M3 5l7-2 8 2 9-2v12l-9 2-8-2-7 2z' }), s('circle', { class: 'f', cx: 13, cy: 9, r: 2.5 }));
        default: return s('svg', g, s('path', { d: 'M3 3h24v14H3zM3 8h24M11 3v14M19 3v14M3 12.5h24' }), s('rect', { class: 'f', x: 11, y: 8, width: 8, height: 4.5 }));
      }
    }

    // ---------- the grid ----------
    const ro = new ResizeObserver((entries) => {
      for (const en of entries) {
        const p = byId(en.target.dataset.id);
        const ps = p && pst(p.id);
        if (ps && ps.data && ps.drawnAt !== `${en.contentRect.width}x${en.contentRect.height}`) {
          ps.drawnAt = `${en.contentRect.width}x${en.contentRect.height}`;
          const body = en.target;
          requestAnimationFrame(() => { if (body.isConnected) draw(p, body); });
        }
      }
    });
    // Panels only query once they're (nearly) on screen.
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const p = byId(en.target.dataset.id);
        if (!p) continue;
        const ps = pst(p.id);
        ps.visible = en.isIntersecting;
        if (ps.visible && ps.dirty) loadPanel(p);
      }
    }, { root: scroller, rootMargin: '300px' });

    function draw(p, body) {
      const ps = pst(p.id);
      try { DRAW[p.type](p, body, ps.data); } catch (e) { put(body, h('p', { class: 'error small' }, e.message)); }
    }

    async function loadPanel(p) {
      const ps = pst(p.id);
      const el = grid.querySelector(`.dpanel[data-id="${p.id}"]`);
      if (!el) return;
      if (!ps.visible) { ps.dirty = true; return; }
      ps.dirty = false;
      const body = el.querySelector('.panel-body');
      const seq = ++ps.seq;
      const slow = setTimeout(() => el.classList.add('loading'), 120);
      const started = performance.now();
      const clock = setInterval(() => {
        const secs = Math.round((performance.now() - started) / 1000);
        if (secs < 3 || seq !== ps.seq) return;
        let w = el.querySelector('.panel-wait');
        if (!w) { w = h('span', { class: 'panel-wait' }); el.querySelector('.panel-actions').before(w); }
        w.textContent = `reading… ${secs}s`;
        if (secs >= 10) w.title = slowHint(p);
      }, 1000);
      try {
        const data = await fetchPanel(p);
        if (seq !== ps.seq) return;
        ps.data = data;
        draw(p, body);
      } catch (e) {
        if (seq !== ps.seq) return;
        ps.data = null;
        if (e instanceof ctx.CancelledError) {
          if (e.message !== 'dropped') put(body, note('Stopped. '), h('button', { class: 'link small', onclick: () => loadPanel(p) }, 'Load again'));
        } else put(body, h('p', { class: 'error small' }, e.message));
      } finally {
        clearTimeout(slow);
        clearInterval(clock);
        if (seq === ps.seq) { el.classList.remove('loading'); el.querySelector('.panel-wait')?.remove(); }
      }
    }

    // Why a panel is slow: grouping or filtering on a column with no index
    // means reading the whole table.
    function slowHint(p) {
      const t = p.source.table && ctx.schema().tables[p.source.table];
      const col = p.type === 'map' ? p.lat : p.by;
      if (t && col && !(t.indexed || []).includes(col)) {
        return `This reads every row of ${t.name}, because ${col} has no index. An index makes it fast, e.g. in another tool:\nCREATE INDEX ix_${t.name}_${col} ON "${t.name}"("${col}");`;
      }
      return 'This reads a lot of rows. Stop it from the toolbar if you don’t need it.';
    }

    function renderPanels() {
      ro.disconnect();
      io.disconnect();
      hideTip();
      const d = D();
      if (!d.panels.length) {
        grid.replaceChildren(h('div', { class: 'empty-dash' },
          h('p', null, h('b', null, 'This dashboard is empty.')),
          h('p', { class: 'muted' }, 'Start with suggestions worked out from this database’s tables and columns, or add panels one at a time. In Explore, “Add to dashboard” turns any query into a panel.'),
          h('div', { class: 'row', style: 'justify-content:center' },
            h('button', { class: 'primary', onclick: starterPanels }, 'Suggest a starter dashboard'),
            h('button', { onclick: () => openAdd() }, 'Add a panel'))));
        return;
      }
      grid.replaceChildren(...d.panels.map((p, i) => panelEl(p, i)),
        ...(layoutMode ? [h('button', { class: 'add-tile', onclick: () => openAdd() }, icon('plus'), 'Add panel')] : []));
    }

    // Which controls are narrowing this panel, for the line under its title.
    function activeNotes(p) {
      const prof = known.get(srcKey(p.source));
      if (p.follow === false || p.type === 'number' || !prof) return [];
      return D().controls.filter((c) => {
        const col = prof.cols[c.col];
        if (!col) return false;
        if (c.kind === 'choice') return 'value' in c && c.col !== p.by;
        return col.date && c.preset !== 'all';
      }).map((c) => (c.kind === 'choice' ? `${c.col} = ${c.label || label(c.value)}` : `${c.col}: ${c.preset === 'custom' ? `${c.from || '…'} to ${c.to || '…'}` : PRESETS.find((x) => x[0] === c.preset)[1]}`));
    }

    function panelEl(p, i) {
      const ps = pst(p.id);
      // Set once here: changing padding while drawing would resize the body and draw again.
      const body = h('div', { class: 'panel-body' + (p.type === 'table' ? ' scroll' : p.type === 'map' ? ' map' : ''), 'data-id': p.id });
      const notes = activeNotes(p);
      const el = h('section', {
        class: 'dpanel' + (editing === p.id ? ' editing' : ''), 'data-id': p.id,
        style: `grid-column:span ${p.w};grid-row:span ${p.h};order:${i}`,
      },
      h('div', { class: 'panel-head' },
        h('button', { class: 'icon grip', title: 'Drag to move', onpointerdown: (e) => startMove(e, p, el) }, icon('grip')),
        h('span', { class: 'panel-tag', title: p.title }, p.title),
        p.note && p.type !== 'number' ? h('span', { class: 'panel-note', title: p.note }, p.note) : null,
        h('span', { class: 'panel-actions' },
          h('button', { class: 'icon', title: 'Edit this panel', onclick: () => openEditor(p.id) }, icon('edit')),
          h('button', { class: 'icon', title: 'More', onclick: (e) => panelMenu(e.currentTarget, p) }, icon('more')))),
      notes.length ? h('div', { class: 'panel-filters', title: 'Dashboard controls applied to this panel' }, notes.join(' · ')) : null,
      body,
      h('div', { class: 'resize', title: 'Drag to resize', onpointerdown: (e) => startResize(e, p, el) }));
      ps.dirty = true;
      ps.drawnAt = null;
      requestAnimationFrame(() => {
        if (!el.isConnected) return;
        ro.observe(body);
        io.observe(body);
      });
      return el;
    }

    // Re-render one panel (after editing it).
    function refreshPanel(p, keepView) {
      const el = grid.querySelector(`.dpanel[data-id="${p.id}"]`);
      if (!el) return renderPanels();
      const ps = pst(p.id);
      if (!keepView) { ps.view = null; ps.bins = null; }
      const fresh = panelEl(p, D().panels.indexOf(p));
      el.replaceWith(fresh);
    }

    // ---------- panel menu ----------
    function sqlFor(p) {
      const prof = pst(p.id).data && pst(p.id).data.prof;
      if (!prof) return null;
      const base = compileSource(p.source);
      const opts = { today: today() };
      const q = p.type === 'number' ? numberQuery(p, base, prof, D().controls, opts)
        : p.type === 'map' ? boundsQuery(p, base, prof, D().controls, opts)
          : groupQuery(p, base, prof, D().controls, { ...opts, month: p.type === 'calendar' && pst(p.id).month ? [pst(p.id).month + '-01', monthEnd(pst(p.id).month)] : null });
      return q;
    }
    function baseSteps(p) {
      return p.source.table ? [{ type: 'source', table: p.source.table }] : clone(p.source.steps);
    }
    function panelMenu(anchor, p) {
      menu(anchor, [
        { label: 'Edit…', onclick: () => openEditor(p.id) },
        { label: 'Duplicate', onclick: () => { const c = { ...clone(p), id: newId(), title: p.title + ' (copy)' }; D().panels.splice(D().panels.indexOf(p) + 1, 0, c); save(); renderPanels(); } },
        '-',
        { label: 'Open in Explore', hint: 'the rows behind this panel, in a query tab', onclick: () => ctx.openQuery(baseSteps(p), p.title) },
        { label: 'Show SQL', onclick: () => { const q = sqlFor(p); if (q) popover(anchor, h('div', { class: 'sqlpop' }, h('pre', null, ctx.inlineParams(q.sql, q.params)))); } },
        { label: 'Download as Excel', hint: 'the figures this panel shows', disabled: p.type === 'map', onclick: () => {
          const q = sqlFor(p);
          if (q) ctx.startExport([{ name: p.title.slice(0, 31) || 'Panel', sql: q.sql.replace(/ LIMIT \d+$/, ''), params: q.params }], `${p.title || 'panel'}-${today()}.xlsx`);
        } },
        '-',
        { label: 'Remove from dashboard', onclick: () => removePanel(p) },
      ], p.title);
    }
    function removePanel(p) {
      const d = D();
      const i = d.panels.indexOf(p);
      if (i < 0) return;
      d.panels.splice(i, 1);
      if (editing === p.id) closeDrawer();
      save();
      renderPanels();
      statusBox.replaceChildren(h('span', { class: 'muted' }, `Removed “${p.title}”. `),
        h('button', { class: 'link small', onclick: () => { d.panels.splice(i, 0, p); save(); renderPanels(); showStatus(); } }, 'Undo'));
    }

    // ---------- layout: drag to move, drag the corner to resize ----------
    function setLayout(on) {
      layoutMode = on;
      grid.classList.toggle('layout', on);
      layoutBtn.classList.toggle('on', on);
      layoutBtn.textContent = on ? 'Done arranging' : 'Edit layout';
      renderPanels();
    }
    function startMove(e, p, el) {
      e.preventDefault();
      el.classList.add('dragging');
      const move = (ev) => {
        const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.dpanel');
        if (!over || over.dataset.id === p.id) return;
        const list = D().panels;
        const to = list.findIndex((x) => x.id === over.dataset.id);
        list.splice(list.indexOf(p), 1);
        list.splice(to, 0, p);
        list.forEach((x, i) => { const n = grid.querySelector(`.dpanel[data-id="${x.id}"]`); if (n) n.style.order = i; });
      };
      const up = () => { el.classList.remove('dragging'); removeEventListener('pointermove', move); removeEventListener('pointerup', up); save(); };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    }
    function startResize(e, p, el) {
      e.preventDefault();
      const cs = getComputedStyle(grid);
      const gap = parseFloat(cs.columnGap);
      const colW = (grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - gap * 11) / 12;
      const rowH = parseFloat(cs.gridAutoRows);
      const start = { x: e.clientX, y: e.clientY, w: p.w, h: p.h };
      const badge = h('span', { class: 'size-badge' });
      el.append(badge);
      const move = (ev) => {
        p.w = clamp(start.w + Math.round((ev.clientX - start.x) / (colW + gap)), 2, 12);
        p.h = clamp(start.h + Math.round((ev.clientY - start.y) / (rowH + gap)), 2, 14);
        el.style.gridColumn = `span ${p.w}`;
        el.style.gridRow = `span ${p.h}`;
        badge.textContent = `${p.w} × ${p.h}`;
      };
      const up = () => { badge.remove(); removeEventListener('pointermove', move); removeEventListener('pointerup', up); save(); if (editing === p.id) renderEditor(); };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    }

    // ---------- controls ----------
    // Every column in the dashboard's data, with how many panels it would reach.
    async function dashColumns() {
      const d = D();
      const profs = await Promise.all(d.panels.map((p) => profile(p.source).catch(() => null)));
      const cols = new Map();
      profs.forEach((prof, i) => {
        if (!prof) return;
        for (const n of prof.names) {
          const c = prof.cols[n];
          // Categories, names and dates: not codes, copies, bookkeeping or measurements.
          if (!['category', 'name', 'date'].includes(c.role)) continue;
          if (!cols.has(n)) cols.set(n, { name: n, date: c.date, reach: 0, source: d.panels[i].source });
          if (d.panels[i].follow !== false) cols.get(n).reach++;
        }
      });
      return [...cols.values()].sort((a, b) => b.reach - a.reach || a.name.localeCompare(b.name));
    }
    async function addControlMenu(anchor) {
      const d = D();
      if (!d.panels.length) return ctx.toast('Add a panel first: controls filter the panels’ data.');
      const cols = (await dashColumns()).filter((c) => !d.controls.some((x) => x.col === c.name));
      menu(anchor, cols.length ? cols.map((c) => ({
        label: c.name, hint: c.date ? 'a date range' : 'pick a value', badgeText: `${c.reach} panel${c.reach === 1 ? '' : 's'}`,
        onclick: () => {
          d.controls.push(c.date ? { id: newId(), col: c.name, kind: 'dates', preset: 'all' } : { id: newId(), col: c.name, kind: 'choice', source: clone(c.source) });
          save(); renderControls(); renderPanels();
        },
      })) : [{ label: 'Every column already has a control', disabled: true, onclick() {} }], 'Filter every panel by');
    }

    function renderControls() {
      const d = D();
      controlsBox.replaceChildren(...d.controls.map((c) => {
        const x = h('button', { class: 'x', title: 'Remove this control', onclick: () => { d.controls.splice(d.controls.indexOf(c), 1); controlsChanged(); } }, icon('close'));
        if (c.kind === 'choice') {
          return h('span', { class: 'ctl' + ('value' in c ? ' set' : '') },
            h('span', { class: 'ctl-name' }, c.col),
            h('button', { class: 'ctl-value', title: 'Choose a value', onclick: (e) => valuePicker(e.currentTarget, c) }, 'value' in c ? c.label || label(c.value) : 'All', icon('chevron')), x);
        }
        return h('span', { class: 'ctl' + (c.preset !== 'all' ? ' set' : '') },
          h('span', { class: 'ctl-name' }, c.col),
          h('select', {
            onchange: (e) => {
              c.preset = e.target.value;
              if (c.preset === 'custom' && !c.from) { c.from = today().slice(0, 7) + '-01'; c.to = today(); }
              controlsChanged();
            },
          }, PRESETS.map(([k, l]) => h('option', { value: k, selected: c.preset === k }, l))),
          c.preset === 'custom' ? [
            h('input', { type: 'date', value: c.from || '', onchange: (e) => { c.from = e.target.value; controlsChanged(); } }),
            h('span', { class: 'muted small' }, 'to'),
            h('input', { type: 'date', value: c.to || '', onchange: (e) => { c.to = e.target.value; controlsChanged(); } })] : null, x);
      }),
      d.controls.some((c) => ('value' in c) || (c.kind === 'dates' && c.preset !== 'all'))
        ? h('button', { class: 'link small', onclick: () => { d.controls.forEach((c) => { delete c.value; delete c.label; if (c.kind === 'dates') c.preset = 'all'; }); controlsChanged(); } }, 'Clear all') : '');
    }

    // Pick a value for a control: the most common ones, or search them all.
    function valuePicker(anchor, c) {
      const src = c.source || (D().panels.find((p) => { const pr = known.get(srcKey(p.source)); return pr && pr.cols[c.col]; }) || D().panels[0] || {}).source;
      if (!src) return;
      let base;
      try { base = compileSource(src); } catch (e) { return ctx.toast(e.message, true); }
      const link = nameLink(base.cols.find((x) => x.name === c.col), ctx.schema());
      const list = h('div', { class: 'check-list values' }, note('Loading values…'));
      let seq = 0;
      const load = async (text) => {
        const my = ++seq;
        try {
          const r = await run(valuesQuery(base, c.col, text, link), 201);
          if (my !== seq) return;
          const rows = r.rows.slice(0, 200);
          const names = new Map();
          const keys = rows.map(([v]) => v).filter((v) => v != null);
          if (link && keys.length) (await run(namesQuery(link, keys), keys.length)).rows.forEach(([k, n]) => names.set(JSON.stringify(k), n));
          if (my !== seq) return;
          const show = (v) => { const n = names.get(JSON.stringify(v)); return n != null && n !== '' ? String(n) : label(v); };
          list.replaceChildren(
            h('button', { class: 'pick' + (!('value' in c) ? ' on' : ''), onclick: () => { delete c.value; delete c.label; closeLayer(); controlsChanged(); } }, h('span', { class: 'value' }, 'All'), ''),
            ...rows.map(([v, n]) => h('button', {
              class: 'pick' + ('value' in c && same(c.value, v) ? ' on' : ''),
              onclick: () => { c.value = v; c.label = show(v); closeLayer(); controlsChanged(); },
            }, h('span', { class: 'value' + (v == null || v === '' ? ' muted' : ''), title: names.size ? `${c.col} ${label(v)}` : null }, show(v)), h('span', { class: 'n' }, fmt(n)))),
            r.rows.length > 200 ? note('The 200 most common. Search to find others.') : null);
        } catch (e) {
          if (!(e instanceof ctx.CancelledError)) list.replaceChildren(h('p', { class: 'error small' }, e.message));
        }
      };
      let timer = null;
      const search = h('input', { type: 'search', placeholder: link ? `Search ${link.table} by ${link.label}…` : `Search ${c.col}…`, oninput: () => { clearTimeout(timer); timer = setTimeout(() => load(search.value.trim()), 250); } });
      popover(anchor, h('div', { class: 'pop-values' }, h('div', { class: 'row' }, search), list));
      search.focus();
      load('');
    }

    // ---------- dashboards: pick, rename, add, delete ----------
    function renderName() {
      const sel = h('select', {
        class: 'dash-pick', onchange: (e) => {
          const v = e.target.value;
          if (v === '+new') { const d = blank(`Dashboard ${state.dashboards.length + 1}`); state.dashboards.push(d); state.active = d.id; }
          else if (v === '+rename') return rename();
          else if (v === '+delete') {
            if (state.dashboards.length === 1 ? !confirm(`Empty “${D().name}”?`) : !confirm(`Delete the dashboard “${D().name}”?`)) return renderName();
            if (state.dashboards.length === 1) Object.assign(D(), { panels: [], controls: [] });
            else { state.dashboards.splice(state.dashboards.indexOf(D()), 1); state.active = state.dashboards[0].id; }
          } else state.active = v;
          closeDrawer(); stopAll(); save(); renderAll();
        },
      }, state.dashboards.map((d) => h('option', { value: d.id, selected: d.id === D().id }, d.name)),
      h('option', { disabled: true }, '──────────'),
      h('option', { value: '+rename' }, 'Rename…'), h('option', { value: '+new' }, 'New dashboard'),
      h('option', { value: '+delete' }, state.dashboards.length === 1 ? 'Empty this dashboard…' : 'Delete this dashboard…'));
      nameBox.replaceChildren(sel);
      function rename() {
        const inp = h('input', {
          type: 'text', class: 'dash-rename', value: D().name,
          onkeydown: (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = D().name; inp.blur(); } },
          onblur: () => { if (inp.value.trim()) D().name = inp.value.trim(); save(); renderName(); },
        });
        nameBox.replaceChildren(inp);
        inp.select();
      }
    }

    // ---------- suggestions ----------
    // Worked out from each column's role (see classify): a dashboard about one
    // subject, the richest table, rather than a count of everything.
    const human = (n) => { const x = String(n).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase(); return x.charAt(0).toUpperCase() + x.slice(1); };
    const plural = (w) => (/s$/i.test(w) ? w : /[^aeiou]y$/i.test(w) ? w.slice(0, -1) + 'ies' : w + 's');
    const currencyOf = (n) => (/gbp|pound|sterling/i.test(n) ? 'gbp' : /usd|dollar/i.test(n) ? 'usd' : /eur/i.test(n) ? 'eur' : 'number');
    const figureFor = (c) => ({ fn: AVG_NAME.test(c.name) ? 'avg' : 'sum', col: c.name });

    // What a table offers, best first, and how good a subject it makes.
    // On a big table (hundreds of thousands of rows) only what an index makes
    // fast: a name without an index is grouped by an indexed copy of it
    // (headliner by headliner_key) and labelled from the readable one.
    const BIG = 300000;
    function ideasFor(table, prof) {
      const cols = prof.names.map((n) => prof.cols[n]);
      const t = ctx.schema().tables[table];
      const big = (prof.total || 0) > BIG;
      const idx = new Set((t && t.indexed) || []);
      const fast = (c) => {
        if (!big) return true;
        if (idx.has(c.name)) return true;
        const twin = cols.find((o) => o.twinOf === c.name && idx.has(o.name));
        if (twin) { c.via = twin.name; return true; }
        return false;
      };
      // Names: things first (headliners, venues, products), then places.
      // Categories: the fullest first.
      const weight = (c) => (ENTITY_NAME.test(c.name) ? 2 : PLACE_NAME.test(c.name) ? 1 : DIM_NAME.test(c.name) ? 0.5 : 0) + c.filled;
      const best = (list) => list.sort((a, b) => weight(b) - weight(a));
      const dates = cols.filter((c) => c.role === 'date' && c.filled >= 0.5 && fast(c));
      const cats = cols.filter((c) => c.role === 'category' && !c.sparse && fast(c))
        .sort((a, b) => (b.filled * 2 + (DIM_NAME.test(b.name) ? 0.5 : 0)) - (a.filled * 2 + (DIM_NAME.test(a.name) ? 0.5 : 0)));
      const names = best(cols.filter((c) => c.role === 'name' && !c.sparse && fast(c)));
      const place = cols.find((c) => c.role === 'name' && PLACE_NAME.test(c.name) && /city|town/i.test(c.name));
      const measures = big ? [] : cols.filter((c) => c.role === 'measure' && c.filled >= 0.05 &&
          !(/^(avg|average|mean)_/i.test(c.name) && prof.cols[c.name.replace(/^(avg|average|mean)_/i, 'total_')]))
        .sort((a, b) => ((FLOW_NAME.test(b.name) ? 3 : MEASURE_NAME.test(b.name) ? 1 : 0) + b.filled) -
          ((FLOW_NAME.test(a.name) ? 3 : MEASURE_NAME.test(a.name) ? 1 : 0) + a.filled));
      const lat = cols.find((c) => c.geo === 'lat'), lon = cols.find((c) => c.geo === 'lon');
      // The subject of a database is nearly always its biggest table with dates
      // and things to group by, so size leads and richness breaks near-ties.
      // Richness counts every useful column, fast or not.
      const count = (role) => cols.filter((c) => c.role === role && !c.sparse).length;
      const rich = (cols.some((c) => c.role === 'date') ? 2 : 0) + Math.min(count('category') + count('name'), 4) +
        Math.min(cols.filter((c) => c.role === 'measure' && c.filled >= 0.05).length, 2) + (lat && lon ? 1 : 0);
      const score = (rich >= 4 ? Math.log10(Math.max(1, prof.total || 1)) * 2 : 0) + rich;
      // A huge table's own map would read every row; a smaller table with
      // coordinates (venues) can stand in for it.
      const geo = lat && lon ? [lat, lon] : null;
      return { table, prof, big, dates, cats, names, measures, place, geo, lat: big && !idx.has(lat && lat.name) ? null : lat, lon, score };
    }

    // The panels one table suggests, grouped by the part they play.
    function panelsFor(I) {
      const src = { table: I.table };
      const noun = human(plural(I.table));
      const lower = (c) => human(c.name).toLowerCase();
      // Grouped by the column itself, or by its indexed copy with names from it.
      const byCol = (c) => (c.via ? { by: c.via, labelFrom: c.name, labelExtra: /venue|arena|stadium|club/i.test(c.name) && I.place ? I.place.name : null } : { by: c.name });
      const m = I.measures.find((x) => x.filled >= 0.3);
      const known = (c) => (c.sparse ? `where known (${Math.round(c.filled * 100)}% of rows)` : '');
      const out = { kpis: [], line: null, mixes: [], bars: [], tops: [], table: null, map: null };
      out.kpis.push(panel({ title: noun, type: 'number', source: src, note: `rows in ${I.table}` }));
      for (const c of I.names.slice(0, 2)) {
        out.kpis.push(panel({ title: `Different ${plural(lower(c))}`, type: 'number', source: src, measures: [{ fn: 'distinct', col: c.via || c.name }], spark: false, compare: !I.big, note: `in ${I.table}` }));
      }
      if (m) out.kpis.push(panel({ title: human(m.name), type: 'number', source: src, measures: [figureFor(m)], format: currencyOf(m.name), note: known(m) }));
      const d = I.dates[0];
      if (d) {
        // A few stray early dates (1585 in a list of gigs) would squash the
        // line, so it starts where the bulk of the data starts, as a visible step.
        let from = d.first, lineSrc = src, note = '';
        if (d.p02 && d.first && +d.p02.slice(0, 4) - +d.first.slice(0, 4) >= 10) {
          from = d.p02.slice(0, 4) + '-01-01';
          lineSrc = { steps: [{ type: 'source', table: I.table }, { type: 'filter', match: 'all', conditions: [{ col: d.name, op: 'gte', value: from }] }], name: I.table };
          note = `from ${from.slice(0, 4)} (under 2% of rows are earlier)`;
        }
        const years = from && d.last ? daysBetween(from, d.last) / 365 : 5;
        const bucket = years > 8 ? 'year' : years > 1.5 ? 'month' : years > 0.3 ? 'week' : 'day';
        out.line = panel({ title: `${noun} per ${bucket}`, type: 'line', source: lineSrc, by: d.name, bucket, note });
      }
      for (const c of I.cats) {
        if (c.distinct <= 8) out.mixes.push(panel({ title: `${noun} by ${lower(c)}`, type: 'mix', source: src, ...byCol(c) }));
        else out.bars.push(panel({ title: `${noun} by ${lower(c)}`, type: 'bars', source: src, ...byCol(c) }));
      }
      I.names.forEach((c, i) => {
        if (i === 1 && m) {
          out.table = panel({ title: `Top ${plural(lower(c))}`, type: 'table', source: src, ...byCol(c), measures: [{ fn: 'count' }, figureFor(m)], format: currencyOf(m.name), note: m.sparse ? `${lower(m)} ${known(m)}` : '' });
        } else out.tops.push(panel({ title: `Top ${plural(lower(c))}`, type: 'bars', source: src, ...byCol(c), showPct: false, top: 12 }));
      });
      if (I.lat && I.lon) out.map = panel({ title: `${noun} on a map`, type: 'map', source: src, lat: I.lat.name, lon: I.lon.name });
      return out;
    }

    let ideasCache = null;
    async function allIdeas() {
      if (ideasCache) return ideasCache;
      const tables = Object.values(ctx.schema().tables).filter((t) => t.type === 'table' || t.type === 'view').slice(0, 40);
      const out = [];
      for (const t of tables) {
        try {
          const prof = await profile({ table: t.name });
          if (prof.rows >= 20) out.push(ideasFor(t.name, prof));
        } catch (_) { /* a view that fails, say */ }
      }
      ideasCache = out.sort((a, b) => b.score - a.score);
      return ideasCache;
    }

    // Everything worth adding, the best table first.
    async function suggestions() {
      const out = [];
      for (const [i, I] of (await allIdeas()).entries()) {
        const g = panelsFor(I);
        const list = [...g.kpis, g.line, ...g.tops, g.table, ...g.mixes, ...g.bars, g.map].filter(Boolean);
        out.push(...(i === 0 ? list : list.slice(0, 4)));
      }
      return out;
    }

    // Lay panels out in whole rows of 12 columns: widen the panels in a short
    // row, give a row one height, then stretch the rows to fill the window.
    function pack(rows) {
      rows = rows.map((r) => r.filter(Boolean)).filter((r) => r.length);
      for (const r of rows) {
        let spare = 12 - r.reduce((n, p) => n + p.w, 0);
        for (let i = r.length - 1; spare > 0; i = (i - 1 + r.length) % r.length) { r[i].w++; spare--; }
        const hh = Math.max(...r.map((p) => p.h));
        r.forEach((p) => { p.h = hh; });
      }
      const cs = getComputedStyle(grid);
      const unit = parseFloat(cs.gridAutoRows) + parseFloat(cs.rowGap);
      const fit = Math.floor((scroller.clientHeight - parseFloat(cs.paddingTop) - 16 + parseFloat(cs.rowGap)) / unit);
      let spare = fit - rows.reduce((n, r) => n + r[0].h, 0);
      const stretchy = rows.filter((r) => r[0].type !== 'number');
      for (let i = 0; spare > 0 && stretchy.length; i = (i + 1) % stretchy.length, spare--) stretchy[i].forEach((p) => { p.h++; });
      return rows.flat();
    }
    const sized = (p, w, h) => (p ? Object.assign(p, { w, h }) : null);

    async function starterPanels() {
      stopAll(); // whatever the old panels were reading
      statusBox.replaceChildren(h('span', { class: 'muted' }, 'Looking at the tables…'));
      const [I] = await allIdeas();
      if (!I) { showStatus(); return ctx.toast('Couldn’t find a table to build a dashboard from. Add panels one at a time.'); }
      const g = panelsFor(I);
      if (!g.map) {
        const all = await allIdeas();
        // Prefer a table that counts this one's rows (venues.events), then the biggest.
        const weightIn = (x) => x.prof.names.map((n) => x.prof.cols[n]).find((c) => c.role === 'measure' && c.name.toLowerCase() === I.table.toLowerCase());
        const J = all.filter((x) => x !== I && x.geo && (x.prof.total || 0) < 2e6).sort((a, b) => (weightIn(b) ? 1 : 0) - (weightIn(a) ? 1 : 0))[0];
        if (J) {
          const noun = human(plural(J.table));
          const weight = weightIn(J);
          g.map = panel({
            title: `${noun} on a map`, type: 'map', source: { table: J.table }, lat: J.geo[0].name, lon: J.geo[1].name,
            measures: [weight ? { fn: 'sum', col: weight.name } : { fn: 'count' }], note: weight ? `sized by ${human(weight.name).toLowerCase()}` : '',
          });
        }
      }
      const kpis = g.kpis.slice(0, 4);
      kpis.forEach((p) => sized(p, 12 / kpis.length, 2));
      const side = g.mixes[0] || g.bars[0];
      const rest = [...g.bars.filter((p) => p !== side), ...g.mixes.filter((p) => p !== side)];
      const rows = [
        kpis,
        [sized(g.line, 8, 5), sized(side, 4, 5)],
        [sized(g.tops[0], 4, 6), sized(g.table || g.tops[1], g.table ? 5 : 4, 6), sized(rest.shift() || g.tops[2], 3, 6)],
        [sized(g.map, 8, 7), sized(rest.shift() || g.tops[2], 4, 7)],
      ];
      const pick = pack(rows);
      const d = D();
      d.panels = pick;
      if (/^Dashboard( \d+)?$/.test(d.name)) d.name = `${human(plural(I.table))} overview`;
      if (g.line && !d.controls.some((c) => c.col === g.line.by)) d.controls.push({ id: newId(), col: g.line.by, kind: 'dates', preset: 'all' });
      save(); renderAll();
      ctx.toast(`A dashboard about ${I.table}: ${pick.length} panels. Edit any of them, or drag them around with Edit layout.`);
    }

    // ---------- the editor drawer ----------
    function closeDrawer() {
      editing = null;
      drawer.hidden = true;
      grid.querySelectorAll('.dpanel.editing').forEach((e) => e.classList.remove('editing'));
    }
    function addPanel(p) {
      D().panels.push(p);
      save();
      renderPanels();
      openEditor(p.id);
      requestAnimationFrame(() => grid.querySelector(`.dpanel[data-id="${p.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }

    async function openAdd() {
      editing = null;
      grid.querySelectorAll('.dpanel.editing').forEach((e) => e.classList.remove('editing'));
      drawer.hidden = false;
      const sugBox = h('div', { class: 'sug' }, note('Looking at the tables…'));
      const tabs = ctx.queries();
      drawer.replaceChildren(
        h('div', { class: 'drawer-head' }, h('h2', null, 'Add a panel'), h('button', { class: 'icon', title: 'Close', onclick: closeDrawer }, icon('close'))),
        h('div', { class: 'drawer-body' },
          h('div', { class: 'sec' }, h('span', { class: 'tool-label' }, 'Suggested for this database'),
            h('p', { class: 'muted small' }, 'Worked out from the tables and columns. Add one, then change anything.'), sugBox),
          h('div', { class: 'sec' }, h('span', { class: 'tool-label' }, 'Or start from'),
            h('div', { class: 'sug' },
              tabs.map((q) => h('button', { onclick: () => addPanel(panel({ title: q.name, type: 'number', source: { steps: clone(q.steps), name: q.name }, w: 3, h: 2 })) }, glyph('table'),
                h('span', { class: 't' }, `The “${q.name}” tab`, h('span', null, `a copy of its ${q.steps.length} step${q.steps.length === 1 ? '' : 's'}`)))),
              h('button', {
                onclick: () => {
                  const t = Object.values(ctx.schema().tables).find((x) => x.type === 'table') || Object.values(ctx.schema().tables)[0];
                  if (t) addPanel(panel({ title: 'New panel', type: 'number', source: { table: t.name }, w: 3, h: 2 }));
                },
              }, glyph('number'), h('span', { class: 't' }, 'A blank panel', h('span', null, 'choose everything yourself')))))));
      const all = await suggestions();
      sugBox.replaceChildren(...(all.length ? all : []).map((p) => h('button', { onclick: () => addPanel(p) }, glyph(p.type),
        h('span', { class: 't' }, p.title, h('span', null, `${TYPES.find((t) => t[0] === p.type)[1]} · ${srcName(p.source)}${p.by ? ' by ' + p.by : ''}`)))),
      all.length ? '' : note('Nothing to suggest.'));
    }

    function openEditor(id) {
      editing = id;
      grid.querySelectorAll('.dpanel').forEach((e) => e.classList.toggle('editing', e.dataset.id === id));
      drawer.hidden = false;
      renderEditor();
    }

    let edSeq = 0;
    async function renderEditor() {
      const p = byId(editing);
      if (!p) return closeDrawer();
      const my = ++edSeq;
      let prof = null, profErr = null;
      try { prof = await profile(p.source); } catch (e) { profErr = e; }
      if (my !== edSeq || editing !== p.id) return;
      const scroll = drawer.querySelector('.drawer-body')?.scrollTop || 0;
      const names = prof ? prof.names : [];
      const kind = (n) => (prof && prof.cols[n]) || {};
      const numeric = names.filter((n) => kind(n).number);
      const dates = names.filter((n) => kind(n).date);

      // Every change: save, redraw the panel, and redraw the editor.
      const upd = (fn, opts = {}) => (e) => { fn(e); save(); if (!opts.quiet) { refreshPanel(p, opts.keepView); renderEditor(); } else refreshHead(p); };
      const field = (lbl, ...ctl) => h('div', { class: 'field' }, h('label', null, lbl), ...ctl);
      const check = (lbl, prop, hint) => h('label', { class: 'checkline', title: hint || '' },
        h('input', { type: 'checkbox', checked: !!p[prop], onchange: upd((e) => { p[prop] = e.target.checked; }) }), lbl);
      const select = (value, options, onchange) => h('select', { onchange }, options.map(([v, l]) => h('option', { value: v, selected: String(value) === String(v) }, l)));
      const isDate = !!kind(p.by).date;

      const measureRows = p.measures.map((m, i) => field(i === 0 ? (p.type === 'number' ? 'Figure' : 'Value') : '',
        h('div', { class: 'pair' },
          select(m.fn, Object.entries(FN_NAMES), upd((e) => {
            m.fn = e.target.value;
            if (m.fn !== 'count' && (!m.col || (m.fn !== 'distinct' && !numeric.includes(m.col)))) m.col = m.fn === 'distinct' ? names[0] : numeric[numeric.length - 1] || names[0];
            if (m.fn === 'count') delete m.col;
          })),
          m.fn !== 'count' ? select(m.col, (m.fn === 'distinct' ? names : numeric).map((n) => [n, n]), upd((e) => { m.col = e.target.value; })) : null,
          p.measures.length > 1 ? h('button', { class: 'x', title: 'Remove', onclick: upd(() => { p.measures.splice(i, 1); }) }, icon('close')) : null)));

      const opts = [];
      if (['bars', 'columns', 'table', 'mix'].includes(p.type) && p.by) {
        opts.push(field('Order', select(p.sort, [['value', 'Biggest first'], ['value-asc', 'Smallest first'], ['label', isDate ? 'Date order' : 'A to Z']], upd((e) => { p.sort = e.target.value; }))));
        opts.push(field('Show', select(p.top || 0, [[5, 'Top 5'], [10, 'Top 10'], [20, 'Top 20'], [50, 'Top 50'], [0, 'All (up to 500)']], upd((e) => { p.top = +e.target.value; }))));
        if (p.top && ['count', 'sum'].includes(p.measures[0].fn)) opts.push(check('Add the rest together as “Other”', 'other'));
      }
      if (p.type === 'number') {
        opts.push(check('Compare with the period before', 'compare', 'Uses the date control; without one, the latest 12 months vs the 12 before'));
        opts.push(check('Show a trend line', 'spark'));
      }
      const link = prof && p.by && !isDate && ['bars', 'columns', 'table', 'mix'].includes(p.type) ? labelLink(p) || (() => { try { return nameLink(compileSource(p.source).cols.find((c) => c.name === p.by), ctx.schema()); } catch (_) { return null; } })() : null;
      if (link) opts.push(check(`Show names (${link.table}.${link.label}), not ids`, 'names', `Looks up each ${p.by} in ${link.table}`));
      if (p.by && !isDate && ['bars', 'columns', 'table', 'mix'].includes(p.type)) opts.push(check('Include rows with no ' + p.by, 'blanks'));
      if (p.type === 'bars' || p.type === 'mix') opts.push(check('Show % of the total', 'showPct'));
      if (p.type === 'table') opts.push(check('Shade cells: green high, red low', 'heat'));
      if (p.type === 'line') opts.push(check('Fill under the line', 'fill'));
      if ((p.type === 'bars' || p.type === 'columns') && !isDate) opts.push(check('A colour for each value', 'colorBy', 'Colours are shared by every panel on this dashboard'));
      if (p.type === 'map') {
        opts.push(field('Style', h('div', { class: 'segmented' }, [['heat', 'Heatmap'], ['dots', 'Dots']].map(([v, l]) => h('button', { class: 'seg small' + (p.mapStyle === v ? ' on' : ''), onclick: upd(() => { p.mapStyle = v; }, { keepView: true }) }, l)))));
        opts.push(check('Street map background (loads from OpenStreetMap, online)', 'tiles'));
      }

      let valueColours = null;
      const perValue = p.by && !isDate && (p.type === 'mix' || ((p.type === 'bars' || p.type === 'columns') && p.colorBy));
      if (perValue && pst(p.id).data && pst(p.id).data.groups) {
        const gs = pst(p.id).data.groups.filter((g) => !g.other).slice(0, 12);
        valueColours = h('div', { class: 'value-colours' },
          h('div', { class: 'muted small' }, `Colours for ${p.by}, used by every panel on this dashboard:`),
          gs.map((g, i) => h('div', null,
            h('button', {
              class: 'swatch', style: `background:${colourFor(p, g, i)}`, title: 'Change colour',
              onclick: (e) => swatchPicker(e.currentTarget, (c) => { const d = D(); d.colors[p.by] = d.colors[p.by] || {}; d.colors[p.by][JSON.stringify(g.key)] = c; save(); renderPanels(); renderEditor(); }),
            }), h('span', null, g.label))));
      }
      const single = !perValue && p.type !== 'table' && !(p.type === 'map' && p.mapStyle === 'heat');

      const sources = [
        ...Object.values(ctx.schema().tables).map((t) => [srcKey({ table: t.name }), `${t.name} (${t.type})`, { table: t.name }]),
        ...ctx.queries().map((q) => [srcKey({ steps: q.steps }), `${q.name} (query tab: copies its steps)`, { steps: clone(q.steps), name: q.name }]),
      ];
      if (!sources.some(([k]) => k === srcKey(p.source))) sources.unshift([srcKey(p.source), `${srcName(p.source)} (copied query)`, p.source]);

      const W = [[3, '¼'], [4, '⅓'], [6, '½'], [8, '⅔'], [12, 'Full']];
      const HH = [[2, 'Short'], [3, 'Low'], [5, 'Medium'], [7, 'Tall'], [10, 'Taller']];
      const stepsText = [`Source: ${srcName(p.source)}`, ...(p.source.steps ? p.source.steps.slice(1).map(P.describe) : [])];
      drawer.replaceChildren(
        h('div', { class: 'drawer-head' }, h('h2', null, 'Edit panel'), h('button', { class: 'icon', title: 'Close', onclick: closeDrawer }, icon('close'))),
        h('div', { class: 'drawer-body' },
          h('div', { class: 'sec' }, h('span', { class: 'tool-label' }, 'Show as'),
            h('div', { class: 'types' }, TYPES.map(([k, l]) => h('button', {
              class: 'type' + (p.type === k ? ' on' : ''), title: l,
              onclick: upd(() => {
                p.type = k;
                if (k === 'number') p.h = 2;
                if ((k === 'line' || k === 'calendar') && !kind(p.by).date && dates.length) { p.by = dates[0]; p.bucket = k === 'line' ? 'month' : 'day'; }
                if (k === 'calendar') p.h = Math.max(p.h, 6);
                if (k === 'map') {
                  p.lat = p.lat || names.find((n) => kind(n).geo === 'lat') || null;
                  p.lon = p.lon || names.find((n) => kind(n).geo === 'lon') || null;
                  p.h = Math.max(p.h, 6); p.w = Math.max(p.w, 6);
                }
                if (!['number', 'calendar', 'map'].includes(k) && !p.by) p.by = names.find((n) => !kind(n).number && !kind(n).id) || names[0] || null;
                if (k === 'number' && p.measures.length > 1) p.measures = p.measures.slice(0, 1);
              }),
            }, glyph(k), l)))),
          h('div', { class: 'sec' }, h('span', { class: 'tool-label' }, 'Data'),
            field('From', select(srcKey(p.source), sources.map(([k, l]) => [k, l]), upd((e) => {
              p.source = clone(sources.find(([k]) => k === e.target.value)[2]);
              p.view = null;
            }))),
            profErr ? h('p', { class: 'error small' }, profErr.message) : null,
            prof && !['number', 'calendar', 'map'].includes(p.type) ? field(p.type === 'line' || p.type === 'columns' ? 'Along the bottom' : 'Group by', h('div', { class: 'pair' },
              select(p.by || '', [['', '(choose a column)'], ...names.map((n) => [n, n + (kind(n).date ? ' (date)' : '')])], upd((e) => { p.by = e.target.value || null; delete p.labelFrom; delete p.labelExtra; })),
              isDate ? select(p.bucket, BUCKETS, upd((e) => { p.bucket = e.target.value; })) : null)) : null,
            prof && p.type === 'calendar' ? field('Dates', select(p.by || '', [['', '(choose)'], ...dates.map((n) => [n, n])], upd((e) => { p.by = e.target.value || null; }))) : null,
            prof && p.type === 'map' ? [
              field('Latitude', select(p.lat || '', [['', '(choose)'], ...numeric.map((n) => [n, n])], upd((e) => { p.lat = e.target.value || null; p.view = null; }))),
              field('Longitude', select(p.lon || '', [['', '(choose)'], ...numeric.map((n) => [n, n])], upd((e) => { p.lon = e.target.value || null; p.view = null; })))] : null,
            prof ? measureRows : null,
            prof && (p.type === 'table' || p.type === 'line') ? h('div', { class: 'checkline' }, h('button', {
              class: 'link small', onclick: upd(() => { p.measures.push(numeric.length ? { fn: 'sum', col: numeric[numeric.length - 1] } : { fn: 'count' }); }),
            }, p.type === 'line' ? '+ Add another line' : '+ Add a column')) : null,
            check('Follow the dashboard controls', 'follow', 'Untick to keep this panel the same whatever the controls say'),
            h('div', { class: 'steps-read' }, h('b', null, 'Rows from: '), stepsText.join(' → '), ' ',
              h('button', { class: 'link small', onclick: () => ctx.openQuery(baseSteps(p), p.title) }, 'Open in Explore'))),
          h('div', { class: 'sec' }, h('span', { class: 'tool-label' }, 'Look'),
            field('Title', h('input', { type: 'text', value: p.title, oninput: upd((e) => { p.title = e.target.value; }, { quiet: true }) })),
            field(p.type === 'number' ? 'Caption' : 'Note', h('input', {
              type: 'text', value: p.note, placeholder: p.type === 'number' ? mLabel(p.measures[0]) : 'optional, shown by the title',
              oninput: upd((e) => { p.note = e.target.value; }, { quiet: true }),
            })),
            p.type !== 'map' ? field('Numbers', h('div', { class: 'pair' },
              select(p.format, FORMATS, upd((e) => { p.format = e.target.value; })),
              select(p.decimals ?? 'auto', [['auto', 'Auto'], [0, '0 dp'], [1, '1 dp'], [2, '2 dp']], upd((e) => { p.decimals = e.target.value === 'auto' ? null : +e.target.value; })))) : null,
            single ? field('Colour', h('div', { class: 'swatches' }, PALETTE.map((c) => h('button', { class: 'swatch' + (p.color === c ? ' on' : ''), style: `background:${c}`, title: c, onclick: upd(() => { p.color = c; }, { keepView: true }) })))) : null,
            opts, valueColours),
          h('div', { class: 'sec' }, h('span', { class: 'tool-label' }, 'Size'),
            field('Width', h('div', { class: 'segmented' }, W.map(([v, l]) => h('button', { class: 'seg small' + (p.w === v ? ' on' : ''), onclick: upd(() => { p.w = v; }, { keepView: true }) }, l)))),
            field('Height', h('div', { class: 'segmented' }, HH.map(([v, l]) => h('button', { class: 'seg small' + (p.h === v ? ' on' : ''), onclick: upd(() => { p.h = v; }, { keepView: true }) }, l)))),
            h('p', { class: 'muted small indent' }, 'Or use Edit layout to drag and resize.'))),
        h('div', { class: 'drawer-foot' },
          h('button', { class: 'ghost small', onclick: () => removePanel(p) }, 'Remove'),
          h('button', { class: 'ghost small', onclick: (e) => { const q = sqlFor(p); if (q) popover(e.currentTarget, h('div', { class: 'sqlpop' }, h('pre', null, ctx.inlineParams(q.sql, q.params)))); } }, 'Show SQL'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'primary small', onclick: closeDrawer }, 'Done')));
      drawer.querySelector('.drawer-body').scrollTop = scroll;
    }
    function refreshHead(p) {
      const el = grid.querySelector(`.dpanel[data-id="${p.id}"]`);
      if (!el) return;
      el.querySelector('.panel-tag').textContent = p.title;
      const ps = pst(p.id);
      if (p.type === 'number' && ps.data) draw(p, el.querySelector('.panel-body'));
    }
    function swatchPicker(anchor, onPick) {
      popover(anchor, h('div', { class: 'swatches' }, PALETTE.map((c) => h('button', { class: 'swatch', style: `background:${c}`, onclick: () => { closeLayer(); onPick(c); } }))));
    }

    // ---------- from Explore: "Add to dashboard" ----------
    // A query ending in a one-column Group by becomes bars of those groups;
    // anything else becomes a count, ready to change in the drawer.
    const FN_FROM_STEP = { count: 'count', countDistinct: 'distinct', sum: 'sum', avg: 'avg', min: 'min', max: 'max' };
    function addFromQuery(name, steps) {
      const last = steps[steps.length - 1];
      let p;
      if (steps.length > 1 && last.type === 'group' && last.by.length === 1 && last.measures.length && last.measures.every((m) => FN_FROM_STEP[m.fn])) {
        p = panel({
          title: name, type: last.measures.length > 1 ? 'table' : 'bars', source: { steps: clone(steps.slice(0, -1)), name }, by: last.by[0],
          measures: last.measures.map((m) => (m.fn === 'count' ? { fn: 'count' } : { fn: FN_FROM_STEP[m.fn], col: m.col })), w: 6, h: 5,
        });
      } else {
        p = panel({ title: name, type: 'number', source: steps.length === 1 ? { table: steps[0].table } : { steps: clone(steps), name }, w: 3, h: 2 });
      }
      D().panels.push(p);
      save();
      return p;
    }

    // ---------- showing and hiding ----------
    function renderAll() {
      if (!state) return;
      renderName();
      renderControls();
      renderPanels();
      showStatus();
    }
    return {
      load,
      show(focusPanel) {
        shown = true;
        root.hidden = false;
        renderAll();
        if (focusPanel) openEditor(focusPanel);
      },
      hide() {
        shown = false;
        root.hidden = true;
        hideTip();
        if (queue.length || running.size) stopAll(); // nothing on screen needs them
      },
      addFromQuery(name, steps) { return addFromQuery(name, steps).id; },
      ready: () => !!state,
    };
  }

  return {
    create, classify, keyExpr, dayExpr, rangeCond, measureSql, controlConds, groupQuery, totalQuery, numberQuery,
    sparkQuery, boundsQuery, binsQuery, valuesQuery, nameLink, namesQuery, presetRange, bucketLabel, bucketRange, addDays,
  };
});
