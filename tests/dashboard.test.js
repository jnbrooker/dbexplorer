// Run with:  node --test tests/
// Dashboard panels' SQL, run against examples/sample.sqlite using Python's
// sqlite3 (so there's nothing to npm install).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const P = require('../js/pipeline.js');
const D = require('../js/dashboard.js');

const SAMPLE = path.join(__dirname, '..', 'examples', 'sample.sqlite');

function sql(query, params = []) {
  const script = `
import json, sqlite3, sys
q, p = json.loads(sys.stdin.read())
print(json.dumps(sqlite3.connect(${JSON.stringify(SAMPLE)}).execute(q, p).fetchall()))`;
  return JSON.parse(execFileSync('python3', ['-c', script], { input: JSON.stringify([query, params]) }));
}
const run = (q) => sql(q.sql, q.params);

const schema = (() => {
  const tables = {};
  for (const [name] of sql("SELECT name FROM sqlite_master WHERE type IN ('table','view')")) {
    const columns = sql('SELECT name, type, pk FROM pragma_table_info(?)', [name])
      .map(([n, t, pk]) => ({ name: n, type: t, pk, affinity: P.affinity(t) }));
    tables[name] = { name, columns, fks: [] };
  }
  return { tables };
})();

// A panel's source, compiled and profiled the way the app does it.
function source(table) {
  const c = P.compile([{ type: 'source', table }], schema, 0, {});
  const rows = sql(`SELECT * FROM (${c.unsortedSql}) LIMIT 300`, c.params);
  return { base: { sql: c.unsortedSql, params: c.params }, prof: D.classify(c.cols, rows) };
}
const opts = { today: '2024-12-31' };
const panel = (o) => ({ type: 'bars', measures: [{ fn: 'count' }], sort: 'value', top: 10, follow: true, ...o });

test('columns are recognised from their values', () => {
  const { prof } = source('orders');
  assert.strictEqual(prof.cols.ordered_at.date, 'iso');
  assert.strictEqual(prof.cols.id.number, true);
  assert.strictEqual(prof.cols.status.date, null);
  assert.strictEqual(prof.cols.status.number, false);
  const geo = D.classify([{ name: 'latitude' }, { name: 'lng' }, { name: 'created_at' }],
    [[51.5, -0.12, 1700000000], [48.8, 2.35, 1700086400]]);
  assert.strictEqual(geo.cols.latitude.geo, 'lat');
  assert.strictEqual(geo.cols.lng.geo, 'lon');
  assert.strictEqual(geo.cols.created_at.date, 'unix');
});

test('codes, copies, bookkeeping and empty columns are told apart from useful ones', () => {
  const cols = ['event_id', 'artist_mbid', 'venue_key', 'headliner', 'headliner_norm', 'artists', 'country', 'countryCode',
    'category', 'tour', 'tickets', 'price_avg', 'loaded_at', 'source', 'latitude', 'event_date', 'setlist_url'].map((name) => ({ name }));
  const cats = ['A', 'B', 'C'];
  const names = ['Elton John', 'B.B. King', 'Tom Jones', 'Santana', 'Jethro Tull', 'The Wiggles'];
  const rows = Array.from({ length: 120 }, (_, i) => {
    const who = names[i % names.length];
    return [`2024-01-${i}|x`, `89ad4ac3-39f7-470e-963a-${String(i).padStart(12, '0')}`, `venue ${i % 40}|city`, who, who.toLowerCase(),
      who, ['United Kingdom', 'France', 'Spain'][i % 3], ['GB', 'FR', 'ES'][i % 3], cats[i % 3], i % 5 ? null : `Tour ${i}`,
      i * 13, (i % 9) + 20.5, '2026-09-28T08:00:00Z', 'setlistfm', String(51 + i / 100), `2024-0${1 + (i % 9)}-1${i % 10}`, `https://x/${i}`];
  });
  const c = D.classify(cols, rows).cols;
  const role = (n) => c[n].role;
  assert.strictEqual(role('event_id'), 'code');
  assert.strictEqual(role('artist_mbid'), 'code');
  assert.strictEqual(role('venue_key'), 'code');
  assert.strictEqual(role('setlist_url'), 'code');
  assert.strictEqual(role('headliner'), 'category');
  assert.strictEqual(role('headliner_norm'), 'twin');
  assert.strictEqual(role('artists'), 'twin'); // the same values as headliner
  assert.strictEqual(role('countryCode'), 'twin');
  assert.strictEqual(role('category'), 'category');
  assert.strictEqual(c.tour.sparse, true);
  assert.strictEqual(role('tickets'), 'measure');
  assert.strictEqual(role('loaded_at'), 'constant');
  assert.strictEqual(role('source'), 'constant');
  assert.strictEqual(role('latitude'), 'geo'); // numbers stored as text
  assert.strictEqual(role('event_date'), 'date');
});

test('blanks are left out of grouped panels unless asked for', () => {
  const base = { sql: "SELECT 'a' AS v UNION ALL SELECT 'a' UNION ALL SELECT '' UNION ALL SELECT NULL UNION ALL SELECT 'b'", params: [] };
  const prof = D.classify([{ name: 'v' }], [['a'], ['a'], [''], [null], ['b']]);
  assert.deepStrictEqual(run(D.groupQuery(panel({ by: 'v' }), base, prof, [], opts)), [['a', 2], ['b', 1]]);
  assert.strictEqual(run(D.groupQuery(panel({ by: 'v', blanks: true }), base, prof, [], opts)).length, 4);
});

test('dates are bucketed into sortable keys', () => {
  const row = (b) => sql(`SELECT ${D.keyExpr('d', 'iso', b)} FROM (SELECT '2024-01-03 18:30:00' AS d)`)[0][0];
  assert.strictEqual(row('month'), '2024-01');
  assert.strictEqual(row('year'), '2024');
  assert.strictEqual(row('quarter'), '2024-Q1');
  assert.strictEqual(row('day'), '2024-01-03');
  assert.strictEqual(row('week'), '2024-01-01'); // the Monday
  assert.strictEqual(row('weekday'), 2); // Wednesday, counting Monday as 0
  assert.strictEqual(sql(`SELECT ${D.keyExpr('d', 'unix', 'day')} FROM (SELECT 1704240000 AS d)`)[0][0], '2024-01-03');
});

test('a date range includes the whole last day, times and all', () => {
  const params = [];
  const cond = D.rangeCond('d', 'iso', '2024-01-01', '2024-01-31', params);
  const n = sql(`SELECT COUNT(*) FROM (SELECT '2024-01-31 23:59:59' AS d UNION ALL SELECT '2024-02-01' UNION ALL SELECT '2023-12-31') WHERE ${cond}`, params)[0][0];
  assert.strictEqual(n, 1);
});

test('grouped panels add up to the whole, most common first', () => {
  const { base, prof } = source('orders');
  const q = D.groupQuery(panel({ by: 'status', top: 0 }), base, prof, [], opts);
  const rows = run(q);
  const total = sql('SELECT COUNT(*) FROM orders')[0][0];
  assert.strictEqual(rows.reduce((n, r) => n + r[1], 0), total);
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1][1] >= r[1]));
  const byMonth = run(D.groupQuery(panel({ type: 'line', by: 'ordered_at', bucket: 'month' }), base, prof, [], opts));
  assert.ok(byMonth.every((r, i) => i === 0 || byMonth[i - 1][0] < r[0]), 'line charts run in date order');
});

test('controls filter panels that have the column, and not their own chart', () => {
  const { base, prof } = source('orders');
  const controls = [{ col: 'status', kind: 'choice', value: 'shipped' }, { col: 'nope', kind: 'choice', value: 1 },
    { col: 'ordered_at', kind: 'dates', preset: 'custom', from: '2024-01-01', to: '2024-06-30' }];
  const [[want]] = sql("SELECT COUNT(*) FROM orders WHERE status = 'shipped' AND ordered_at >= '2024-01-01' AND ordered_at < '2024-07-01'");
  const num = D.numberQuery(panel({ type: 'number', compare: false }), base, prof, controls, opts);
  assert.strictEqual(run(num)[0][0], want);
  // A chart of status itself keeps every status (and highlights the chosen one).
  const own = run(D.groupQuery(panel({ by: 'status' }), base, prof, controls, opts));
  assert.ok(own.length > 1);
  // Opting out ignores the controls.
  const all = run(D.numberQuery(panel({ type: 'number', compare: false, follow: false }), base, prof, controls, opts));
  assert.strictEqual(all[0][0], sql('SELECT COUNT(*) FROM orders')[0][0]);
});

test('numbers compare with the period before', () => {
  const { base, prof } = source('orders');
  const controls = [{ col: 'ordered_at', kind: 'dates', preset: 'custom', from: '2024-04-01', to: '2024-06-30' }];
  const q = D.numberQuery(panel({ type: 'number', compare: true }), base, prof, controls, opts);
  assert.strictEqual(q.compare, 'range');
  const [[cur, prev]] = run(q);
  const count = (f, t) => sql('SELECT COUNT(*) FROM orders WHERE ordered_at >= ? AND ordered_at < ?', [f, t])[0][0];
  assert.strictEqual(cur, count('2024-04-01', '2024-07-01'));
  assert.strictEqual(prev, count('2024-01-01', '2024-04-01')); // the 91 days before
  const latest = D.numberQuery(panel({ type: 'number', compare: true }), base, prof, [], opts);
  assert.strictEqual(latest.compare, 'latest');
  const [[all, recent, before]] = run(latest);
  assert.strictEqual(all, sql('SELECT COUNT(*) FROM orders')[0][0]);
  assert.ok(recent + before <= all);
});

test('map points are counted into cells', () => {
  const base = { sql: 'SELECT 51.50 AS lat, -0.12 AS lon UNION ALL SELECT 51.501, -0.121 UNION ALL SELECT 48.85, 2.35 UNION ALL SELECT NULL, 1', params: [] };
  const prof = D.classify([{ name: 'lat' }, { name: 'lon' }], [[51.5, -0.12], [48.85, 2.35]]);
  const p = panel({ type: 'map', lat: 'lat', lon: 'lon' });
  const [[s, n, w, e, count]] = run(D.boundsQuery(p, base, prof, [], opts));
  assert.deepStrictEqual([s, n, w, e, count], [48.85, 51.501, -0.121, 2.35, 3]);
  const cells = run(D.binsQuery(p, base, prof, [], opts, { latStep: 0.1, lonStep: 0.1, s: 40, n: 60, w: -10, e: 10 }));
  assert.deepStrictEqual(cells.map((c) => c[2]).sort(), [1, 2]); // London's two points share a cell
});

test('values for a control, optionally searched', () => {
  const { base } = source('orders');
  const rows = run(D.valuesQuery(base, 'status', 'ship'));
  assert.ok(rows.length >= 1 && rows.every(([v]) => String(v).includes('ship')));
});
