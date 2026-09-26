# DB Explorer

Point it at a SQLite database, however large, and explore and filter it
without writing SQL. Then download exactly what you see as an Excel file, with
nothing reformatted.

## Run it

```bash
python3 dbexplorer.py
```

This opens the explorer in your browser. Type or paste the path to a database
(in Finder: select the file, press ⌥⌘C, paste). Or open one straight away:

```bash
python3 dbexplorer.py ~/Documents/sales.sqlite
```

Needs only Python 3.8+ (standard library). Nothing to install. Nothing leaves
your machine: the server listens on 127.0.0.1 only.

## What it does

- **Browse** every table and view, with row counts.
- **Columns**: choose which to show.
- **Filters**: contains, is exactly, starts with, greater than, between,
  is one of, is empty… (match all or any). Suggestions appear as you type.
- **Link related data**: follow the database's foreign keys to pull in columns
  from other tables (e.g. order items → orders → customers).
- **Summarise**: group rows and show counts, totals, averages, min/max.
- **Sort** by clicking a column heading.
- **Show SQL** reveals the query it built; **Write SQL** is there for anyone
  who wants it.
- **Download as Excel** exports the full result (not just the page on screen);
  **Export all tables** puts every table on its own sheet.

## Built for big databases

The data never gets loaded wholesale. Queries run in Python against the file
on disk, and the page only receives the 100 rows on screen.

- **Browsing is instant at any size.** The first page appears straight away.
  Row counts (which need a full scan) run separately in the background.
- **Nothing queues up.** If you change a filter while a slow sort or count is
  running, the old query is interrupted rather than finished.
- **Exports stream to disk** row by row, with a progress bar and Cancel.
  Memory use stays flat whatever the size. Results beyond Excel's
  1,048,575-row limit continue on extra sheets (`orders`, `orders (2)`, …).

Measured on a 500 MB database with 10 million rows (MacBook, warm cache):

| Action                                         | Time    |
|------------------------------------------------|---------|
| Open, first page of rows                       | instant |
| Filter / sort / join three tables, first page  | < 0.5 s |
| Count all 10 million rows                      | ~3 s    |
| Summarise all 10 million rows by a linked column | ~9 s  |
| Export 1.2 million rows to Excel               | ~5.5 s  |

Anything that has to read every row (counts, summaries, sorting on a column
without an index) grows with the size of the data. For tables you sort or
filter on constantly, an index on that column makes those instant.

## "None of the formatting messed with"

The export writes a real `.xlsx` with each cell's type taken from what SQLite
stored. It never goes through CSV, which is where Excel usually mangles things.

| Stored in SQLite            | In Excel                                               |
|-----------------------------|--------------------------------------------------------|
| Text (`00123`, `2024-01-01`, `=SUM(..)`, `+44 0770…`) | Text, exactly as stored, and formatted as Text so it stays that way if edited. No dropped zeros, date conversion or formulas |
| Whole numbers               | Numbers, shown in full (no `1.23E+13`)                 |
| Whole numbers > 15 digits   | Text, because Excel would round them otherwise |
| Decimals                    | Numbers                                                |
| NULL                        | Empty cell                                             |

Headers are bold and frozen, with filter drop-downs, and columns are sized to fit.

## Safety

The database is opened read-only. On top of that, the connection refuses
writes, attaching other files and changing settings, so nothing typed into
Write SQL can change your data. Each query sees the database as it is right
now, including recent changes from other programs.

The page and its API only answer on 127.0.0.1, only to requests from the page
itself, not to other websites.

## Development

```bash
python3 -m unittest discover tests             # openpyxl, if installed, adds Excel round-trip checks
python3 scripts/make_sample.py                 # rebuild examples/sample.sqlite
python3 scripts/make_sample.py --big 4000000 /tmp/big.sqlite   # ~10M-row test database
```

- `dbexplorer.py`: local server that opens databases, runs queries, runs exports
- `xlsx_writer.py`: streaming, typed Excel writer
- `index.html`, `css/`, `js/app.js`: the interface
- `js/query.js`: turns the point-and-click choices into SQL (values are always bound parameters)
- `examples/sample.sqlite`: demo database full of values spreadsheets like to mangle
