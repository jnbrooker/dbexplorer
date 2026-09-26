// Run with:  node --test tests/
// Compiles step lists and runs the SQL against examples/sample.sqlite using
// Python's sqlite3 (so there's nothing to npm install).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const P = require('../js/pipeline.js');

const SAMPLE = path.join(__dirname, '..', 'examples', 'sample.sqlite');

function sql(query, params = []) {
  const script = `
import json, sqlite3, sys
q, p = json.loads(sys.stdin.read())
p = [int(x["$int"]) if isinstance(x, dict) else x for x in p]
print(json.dumps(sqlite3.connect(${JSON.stringify(SAMPLE)}).execute(q, p).fetchall()))`;
  return JSON.parse(execFileSync('python3', ['-c', script], { input: JSON.stringify([query, params]) }));
}

// Build the schema the same way the app does, from the sample database.
const schema = (() => {
  const tables = {};
  for (const [name] of sql("SELECT name FROM sqlite_master WHERE type IN ('table','view')")) {
    const columns = sql('SELECT name, type, pk FROM pragma_table_info(?)', [name])
      .map(([n, t, pk]) => ({ name: n, type: t, pk, affinity: P.affinity(t) }));
    const fks = sql('SELECT id, "table", "from", "to" FROM pragma_foreign_key_list(?)', [name])
      .map(([id, t, from, to]) => ({ id, table: t, pairs: [[from, to]] }));
    tables[name] = { name, columns, fks };
  }
  return { tables };
})();

const run = (steps) => {
  const q = P.compile(steps, schema);
  assert.ifError(q.error && new Error(q.error.message));
  return { q, rows: sql(q.sql, q.params), count: sql(q.countSql, q.countParams)[0][0] };
};

test('source table, counted directly', () => {
  const { q, count } = run([{ type: 'source', table: 'customers' }]);
  assert.strictEqual(q.countSql, 'SELECT COUNT(*) FROM "customers"');
  assert.strictEqual(count, 120);
});

test('link, filter on a linked column, sort, rename, remove', () => {
  const { q, rows } = run([
    { type: 'source', table: 'order_items' },
    { type: 'link', table: 'orders', pairs: [['order_id', 'id']], columns: ['status', 'customer_id'] },
    { type: 'link', table: 'customers', pairs: [['orders.customer_id', 'id']], columns: ['name'] },
    { type: 'filter', conditions: [{ col: 'orders.status', op: 'eq', value: 'shipped' }] },
    { type: 'sort', by: [{ col: 'unit_price', dir: 'desc' }] },
    { type: 'rename', from: 'customers.name', to: 'Customer' },
    { type: 'remove', cols: ['id'] },
  ]);
  assert.deepStrictEqual(q.cols.map((c) => c.name),
    ['order_id', 'sku', 'quantity', 'unit_price', 'orders.status', 'orders.customer_id', 'Customer']);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r[4] === 'shipped'));
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1][3] >= rows[i][3], 'sorted desc');
  // Renamed column still knows it came from customers.name
  assert.deepStrictEqual(q.cols[6].prov, { table: 'customers', column: 'name' });
});

test('filter after grouping filters the groups', () => {
  const { rows } = run([
    { type: 'source', table: 'orders' },
    { type: 'group', by: ['status'], measures: [{ fn: 'count' }] },
    { type: 'filter', conditions: [{ col: 'Number of rows', op: 'gt', value: '100' }] },
    { type: 'sort', by: [{ col: 'status', dir: 'asc' }] },
  ]);
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r[1] > 100));
});

test('values keep their type: leading zeros and big integers', () => {
  const zeros = run([{ type: 'source', table: 'products' },
    { type: 'filter', conditions: [{ col: 'sku', op: 'eq', value: '000017' }] }]).rows;
  assert.strictEqual(zeros.length, 1);
  const big = run([{ type: 'source', table: 'customers' },
    { type: 'filter', conditions: [{ col: 'loyalty_card', op: 'eq', value: { $int: '9007199254741021' } }] }]).rows;
  assert.strictEqual(big.length, 1);
  assert.strictEqual(big[0][0], 3);
});

test('value list filter with empty, and its negation', () => {
  const steps = (negate) => [{ type: 'source', table: 'customers' },
    { type: 'filter', conditions: [{ col: 'email', op: 'in', value: [null], negate }] }];
  const nulls = run(steps(false)).count;
  const others = run(steps(true)).count;
  assert.ok(nulls > 0);
  assert.strictEqual(nulls + others, 120);
});

test('a broken step reports which one and keeps the earlier result', () => {
  const q = P.compile([
    { type: 'source', table: 'orders' },
    { type: 'remove', cols: ['status'] },
    { type: 'filter', conditions: [{ col: 'status', op: 'eq', value: 'x' }] },
  ], schema);
  assert.strictEqual(q.error.step, 2);
  assert.match(q.error.message, /status/);
  assert.ok(!q.cols.some((c) => c.name === 'status'));
});

test('keep top rows respects the sort', () => {
  const { rows } = run([
    { type: 'source', table: 'products' },
    { type: 'sort', by: [{ col: 'price', dir: 'desc' }] },
    { type: 'top', n: 3 },
  ]);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0][3], Math.max(...sql('SELECT price FROM products').map((r) => r[0])));
});

test('relationships: parents, and where a key is used elsewhere', () => {
  const q = P.compile([{ type: 'source', table: 'order_items' }], schema);
  const orderId = q.cols.find((c) => c.name === 'order_id');
  assert.deepStrictEqual(P.parentOf(orderId, schema), { table: 'orders', column: 'id' });
  const custId = P.compile([{ type: 'source', table: 'customers' }], schema).cols.find((c) => c.name === 'id');
  assert.deepStrictEqual(P.relatedFor(custId, schema), [{ table: 'orders', column: 'customer_id' }]);
  const links = P.outgoingLinks(q.cols, schema).map((l) => l.table).sort();
  assert.deepStrictEqual(links, ['orders', 'products']);
});

test('step descriptions read naturally', () => {
  assert.strictEqual(P.describe({ type: 'filter', conditions: [{ col: 'sku', op: 'eq', value: '000017' }] }), 'Filtered: sku = 000017');
  assert.strictEqual(P.describe({ type: 'sort', by: [{ col: 'price', dir: 'desc' }] }), 'Sorted by price, descending');
  assert.strictEqual(P.describe({ type: 'filter', conditions: [{ col: 'status', op: 'in', value: ['a', 'b', 'c', 'd'] }] }), 'Filtered: status is one of a, b, c +1 more');
});

// ---------- combining ----------
const merge = (kind, extra = {}) => [
  { type: 'source', table: 'customers' },
  { type: 'merge', source: { table: 'orders' }, kind, on: [['id', 'customer_id']], columns: ['id', 'status'], ...extra },
];
const customersWithOrders = sql('SELECT COUNT(DISTINCT customer_id) FROM orders')[0][0];

test('merge: all four kinds', () => {
  const left = run(merge('left'));
  const inner = run(merge('inner'));
  const anti = run(merge('anti'));
  const full = run(merge('full'));
  assert.strictEqual(inner.count, 400);                       // every order matches a customer
  assert.strictEqual(anti.count, 120 - customersWithOrders);  // customers who never ordered
  assert.strictEqual(left.count, inner.count + anti.count);
  assert.strictEqual(full.count, left.count);                 // no orphan orders in the sample
  assert.deepStrictEqual(anti.q.cols.map((c) => c.name).slice(-1), ['notes']); // anti brings no columns
  assert.deepStrictEqual(inner.q.cols.slice(-2).map((c) => c.name), ['orders.id', 'orders.status']);
});

test('summarise matches adds one figure per row without multiplying rows', () => {
  const { q, rows, count } = run([
    { type: 'source', table: 'customers' },
    { type: 'lookup', source: { table: 'orders' }, on: [['id', 'customer_id']], measures: [{ fn: 'count' }] },
    { type: 'lookup', source: { table: 'order_totals' }, on: [['id', 'customer_id']], measures: [{ fn: 'sum', col: 'total' }] },
  ]);
  assert.strictEqual(count, 120);
  assert.deepStrictEqual(q.cols.slice(-2).map((c) => c.name), ['orders: Number of rows', 'order_totals: Total of total']);
  const orders = rows.reduce((n, r) => n + r[10], 0);
  assert.strictEqual(orders, 400);
  assert.ok(rows.some((r) => r[10] === 0), 'customers with no orders show 0, not empty');
});

test('append stacks rows and matches columns by name', () => {
  const { q, count } = run([
    { type: 'source', table: 'regions' },
    { type: 'append', source: { table: 'products' } },
  ]);
  assert.strictEqual(count, 6 + 20);
  assert.deepStrictEqual(q.cols.map((c) => c.name), ['id', 'name', 'sku', 'category', 'price']);
});

test('merge with another query, and loops are caught', () => {
  const queries = {
    big: { name: 'Big spenders', steps: [
      { type: 'source', table: 'order_totals' },
      { type: 'filter', conditions: [{ col: 'total', op: 'gt', value: '500' }] },
    ] },
    loopA: { name: 'A', steps: [{ type: 'source', table: 'orders' }, { type: 'append', source: { query: 'loopB', name: 'B' } }] },
    loopB: { name: 'B', steps: [{ type: 'source', table: 'orders' }, { type: 'append', source: { query: 'loopA', name: 'A' } }] },
  };
  const ctx = { resolveQuery: (id) => queries[id] };
  const q = P.compile([
    { type: 'source', table: 'customers' },
    { type: 'merge', source: { query: 'big', name: 'Big spenders' }, kind: 'inner', on: [['id', 'customer_id']], columns: ['total'] },
  ], schema, null, ctx);
  assert.ifError(q.error && new Error(q.error.message));
  const rows = sql(q.sql, q.params);
  assert.ok(rows.length > 0 && rows.every((r) => r[10] > 500));
  assert.strictEqual(q.cols.at(-1).name, 'Big spenders.total');

  const loop = P.compile(queries.loopA.steps, schema, null, { ...ctx, self: 'loopA' });
  assert.match(loop.error.message, /loop/);
});

test('suggested match columns', () => {
  const cust = P.compile([{ type: 'source', table: 'customers' }], schema).cols;
  const orders = P.compile([{ type: 'source', table: 'orders' }], schema).cols;
  assert.deepStrictEqual(P.suggestMatches(cust, orders, schema, 'orders')[0], ['id', 'customer_id']);
  assert.deepStrictEqual(P.suggestMatches(orders, cust, schema, 'customers')[0], ['customer_id', 'id']);
});

// ---------- searching ----------
test('search counts matches per column and in any column, in one pass', () => {
  const c = P.compile([{ type: 'source', table: 'customers' }], schema);
  const { sql: s, params } = P.searchQuery(c, 'LOVELACE', 'contains');
  const [scanned, ...rest] = sql(s, params)[0];
  const any = rest.pop();
  const byCol = Object.fromEntries(c.cols.map((col, i) => [col.name, rest[i]]));
  const expected = sql("SELECT COUNT(*) FROM customers WHERE name LIKE '%lovelace%'")[0][0];
  assert.strictEqual(scanned, 120);
  assert.ok(expected > 0);
  assert.strictEqual(byCol.name, expected);         // case-insensitive
  assert.strictEqual(byCol.email, expected);
  assert.strictEqual(byCol.id, 0);
  assert.strictEqual(any, expected);                 // same rows, counted once
});

test('search treats numbers and dates as text, and escapes wildcards', () => {
  const c = P.compile([{ type: 'source', table: 'products' }], schema);
  const run1 = (text, mode) => sql(...Object.values(P.searchQuery(c, text, mode)))[0];
  const price = c.cols.findIndex((x) => x.name === 'price') + 1;
  assert.ok(run1('123.4', 'contains')[price] > 0);   // REAL searched as text
  assert.strictEqual(run1('%', 'contains').at(-1), 0); // literal %, not "anything"
  const sku = c.cols.findIndex((x) => x.name === 'sku') + 1;
  assert.strictEqual(run1('000017', 'eq')[sku], 1);
  assert.strictEqual(run1('00001', 'starts')[sku], 10);
});

test('search can be limited to a sample of rows', () => {
  const c = P.compile([{ type: 'source', table: 'order_items' }], schema);
  assert.strictEqual(sql(...Object.values(P.searchQuery(c, 'x', 'contains', 50)))[0][0], 50);
});

test('value search finds values in a column, most common first', () => {
  const c = P.compile([{ type: 'source', table: 'orders' }], schema);
  const { sql: s, params } = P.valueSearchQuery(c, 'status', 'PED', 'contains', 10);
  const rows = sql(s, params);
  assert.deepStrictEqual(rows.map((r) => r[0]).sort(), ['shipped']);
  assert.strictEqual(rows[0][1], sql("SELECT COUNT(*) FROM orders WHERE status = 'shipped'")[0][0]);
});

test('merge can keep only the other table\'s columns', () => {
  // "Find these customers' orders, and keep just the orders"
  const { q, rows } = run([
    { type: 'source', table: 'customers' },
    { type: 'filter', conditions: [{ col: 'id', op: 'in', value: [1, 2] }] },
    { type: 'merge', source: { table: 'orders' }, kind: 'inner', on: [['id', 'customer_id']], leftColumns: [], prefix: '' },
  ]);
  assert.deepStrictEqual(q.cols.map((c) => c.name), ['id', 'customer_id', 'ordered_at', 'status']);
  assert.deepStrictEqual(q.cols[0].prov, { table: 'orders', column: 'id' }); // still follows keys
  assert.strictEqual(rows.length, sql('SELECT COUNT(*) FROM orders WHERE customer_id IN (1, 2)')[0][0]);
  assert.ok(rows.every((r) => r[1] === 1 || r[1] === 2));
  assert.match(P.describe({ type: 'merge', source: { table: 'orders' }, on: [['id', 'customer_id']], kind: 'inner', leftColumns: [] }), /keeping only orders columns/);
  const some = P.compile([{ type: 'source', table: 'customers' },
    { type: 'merge', source: { table: 'orders' }, on: [['id', 'customer_id']], leftColumns: ['name'], columns: ['status'] }], schema);
  assert.deepStrictEqual(some.cols.map((c) => c.name), ['name', 'orders.status']);
});

test('two tables\' "id" primary keys are not suggested as a match', () => {
  const cust = P.compile([{ type: 'source', table: 'customers' }], schema).cols;
  const orders = P.compile([{ type: 'source', table: 'orders' }], schema).cols;
  assert.deepStrictEqual(P.suggestMatches(cust, orders, schema, 'orders'), [['id', 'customer_id']]);
});
