#!/usr/bin/env python3
"""Build test databases.

    python3 scripts/make_sample.py                  # examples/sample.sqlite (small demo)
    python3 scripts/make_sample.py --big 5000000 /tmp/big.sqlite
                                                    # same shape, millions of order lines

The sample is deliberately full of values spreadsheets like to mangle:
leading zeros, 19-digit IDs, date strings, text that looks like a formula, NULLs.
"""

import argparse
import os
import random
import sqlite3
from datetime import datetime, timedelta

SCHEMA = """
CREATE TABLE regions (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE customers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, postcode TEXT,
  account_number TEXT, loyalty_card INTEGER, region_id INTEGER REFERENCES regions(id),
  joined TEXT, notes TEXT);
CREATE TABLE products (sku TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT, price REAL);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
  ordered_at TEXT, status TEXT);
CREATE TABLE order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
  sku TEXT NOT NULL REFERENCES products(sku), quantity INTEGER, unit_price REAL);
CREATE VIEW order_totals AS
  SELECT o.id AS order_id, o.customer_id, o.ordered_at,
         ROUND(SUM(i.quantity * i.unit_price), 2) AS total
  FROM orders o JOIN order_items i ON i.order_id = o.id
  GROUP BY o.id;
"""

FIRST = ["Ada", "Grace", "Alan", "Linus", "Margaret", "Tim", "Barbara", "Dennis", "Radia", "Ken", "Frances", "John"]
LAST = ["Lovelace", "Hopper", "Turing", "Torvalds", "Hamilton", "Berners-Lee", "Liskov", "Ritchie", "Perlman", "Thompson", "Allen", "Backus"]
CATEGORIES = {"Widget": 4.99, "Gadget": 19.5, "Gizmo": 7.25, "Doohickey": 0.1, "Thingamajig": 123.456}
STATUSES = ["pending", "shipped", "delivered", "cancelled"]


def build(path, customers, orders):
    if os.path.exists(path):
        os.remove(path)
    rnd = random.Random(42)
    db = sqlite3.connect(path)
    db.executescript("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;" + SCHEMA)
    db.executemany("INSERT INTO regions VALUES (?, ?)",
                   enumerate(["North", "South", "East", "West", "Scotland", "Wales"], 1))

    def customer(i):
        f, l = rnd.choice(FIRST), rnd.choice(LAST)
        notes = ("=SUM(A1:A9) is not a formula, just text" if i == 3 else
                 "0044 should stay as typed" if i == 7 else
                 None if i % 9 == 0 else f"Customer since {2015 + i % 10}")
        return (i, f"{f} {l}", None if i % 11 == 0 else f"{f}.{l}{i}@example.com".lower(),
                f"+44 07{rnd.randrange(10**9):09d}", f"{rnd.randrange(99999):05d}",
                f"{rnd.randrange(10**9):010d}{i:09d}",  # 19 digits stored as text
                9007199254741000 + i * 7,                # too big for Excel or JavaScript to hold exactly
                i % 6 + 1, f"20{15 + i % 10}-{i % 12 + 1:02d}-{i % 28 + 1:02d}", notes)

    db.executemany("INSERT INTO customers VALUES (?,?,?,?,?,?,?,?,?,?)", (customer(i) for i in range(1, customers + 1)))

    skus, prices, n = [], {}, 1
    for cat, base in CATEGORIES.items():
        for k in range(4):
            sku = f"{n:06d}"  # SKUs with leading zeros
            n += 1
            prices[sku] = round(base * (1 + k * 0.3), 3)
            skus.append(sku)
            db.execute("INSERT INTO products VALUES (?,?,?,?)", (sku, f"{cat} Mk {k + 1}", cat, prices[sku]))

    start = datetime(2023, 1, 1)
    item_id = 0

    def order_rows():
        for o in range(1, orders + 1):
            when = start + timedelta(seconds=rnd.randrange(600 * 86400))
            yield (o, rnd.randrange(1, customers + 1), when.strftime("%Y-%m-%d %H:%M:%S"), rnd.choice(STATUSES))

    def item_rows():
        nonlocal item_id
        for o in range(1, orders + 1):
            for _ in range(rnd.randrange(1, 5)):
                item_id += 1
                sku = rnd.choice(skus)
                yield (item_id, o, sku, rnd.randrange(1, 6), prices[sku])

    db.executemany("INSERT INTO orders VALUES (?,?,?,?)", order_rows())
    db.executemany("INSERT INTO order_items VALUES (?,?,?,?,?)", item_rows())
    db.commit()
    db.close()
    print(f"Wrote {path}: {customers:,} customers, {orders:,} orders, {item_id:,} order lines, "
          f"{os.path.getsize(path) / 1e6:,.1f} MB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--big", type=int, metavar="ORDERS", help="number of orders for a large test database")
    ap.add_argument("path", nargs="?")
    args = ap.parse_args()
    here = os.path.dirname(os.path.abspath(__file__))
    if args.big:
        build(args.path or "big.sqlite", customers=max(120, args.big // 20), orders=args.big)
    else:
        build(args.path or os.path.join(here, "..", "examples", "sample.sqlite"), customers=120, orders=400)


if __name__ == "__main__":
    main()
