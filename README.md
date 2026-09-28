# DB Explorer

Point it at a SQLite database, however large, and explore and filter it
without writing SQL. Then download exactly what you see as an Excel file, with
nothing reformatted.

## Run it

```bash
python3 dbexplorer.py
```

On Windows, type `python` instead of `python3`.

This opens the explorer in your browser. Type or paste the path to a database:

- **Mac:** in Finder, select the file, press ⌥⌘C, then paste.
- **Windows:** in File Explorer, select the file, press Ctrl+Shift+C (or
  right-click it and choose *Copy as path*), then paste. The quotes it adds are fine.

Or open one straight away:

```bash
python3 dbexplorer.py ~/Documents/sales.sqlite
python dbexplorer.py "C:\Users\you\Documents\sales.sqlite"
```

Keyboard shortcuts are shown for your computer: ⌘ on a Mac, Ctrl on Windows.

Needs only Python 3.8+ (standard library). Nothing to install. Nothing leaves
your machine: the server listens on 127.0.0.1 only.

## How it works

It's built like Power Query. Every change you make becomes a step in
**Applied steps** on the right, such as *Source: orders → Merged with
customers → Filtered: status = shipped → Sorted by date ↓*. Click a step to see
the data at that point, edit it (✎), move it, or delete it. Steps apply in
order, so a filter after a Group by filters the groups. **Undo** (⌘Z / Ctrl+Z) steps
back. Queries open as tabs and are remembered for each database.

**Click the data instead of building filters.**

- **Click any cell:** *Keep only this value*, *Remove this value*,
  *Keep this or more / less* (numbers and dates), *Keep values containing…*.
- **Click a key and follow it.** A primary key instantly lists every table
  that uses it, with live row counts: *Find in order_items where
  order_id = 5 (3 rows)* opens those rows in a new tab. A foreign key opens
  its parent record.
- **Record inspector:** see one record's fields plus every linked record
  elsewhere. Click through the chain (customer → orders → items → product)
  with back/forward, like browsing.
- **Click a column heading:** sort, *Filter by values…* (an Excel-style tick
  list with counts), remove empty rows, group by, rename, remove, and for key
  columns *Expand* (bring in the linked table's columns, ⤢) or *Count
  matching …*. Searching the value list searches the whole column in the
  database, so it finds values beyond the 1,000 listed.
- **Search this data:** type into the box above the grid and one pass over
  the rows shows which columns contain it, with counts (*name 14 · email 14*).
  Matches are highlighted. Click a column, or *Any of these*, to turn the
  search into a filter step. Choose *contains*, *starts with* or *is exactly*;
  numbers and dates are searched as text, so "2024-03" finds March. On big
  tables it searches the first 200,000 rows straight away, then *Search all
  rows* when you want everything.

The typed filters are still there (contains, between, is one of…) for when
you need them.

**Combining tables:**

- **Merge**: join another table *or another open query*. Matching columns are
  suggested from foreign keys and names, and it checks how many rows find a
  match before you commit. Choose how to keep rows: all rows here, only
  matching rows, only rows with no match (e.g. customers who never ordered),
  or all rows from both. Then choose which columns to keep. *Both*, *Only
  events* or *Only this query* are one click each, or tick columns
  individually. For example: filter venues to the one you want, merge with
  events, choose *Only events*, and you have that venue's events with just
  the events columns.
- **Add figures**: add a count, total, average, min or max from matching rows
  in a related table, one figure per row. Rows are never duplicated.
- **Append**: stack another table or query underneath, matching columns by
  name.
- **Expand linked**: follow a foreign key and pick columns to bring in.

Also: **Group by**, **Remove duplicates**, **Keep top rows**, **Choose
columns**, **Show SQL** / **Write SQL**, and **Download as Excel**, which
exports exactly the step you're looking at, every row.

## Design

The look is modelled on [Data Golf](https://datagolf.com): Trebuchet MS,
dense data-first panels, thin rules, square corners, dark-green section tags
and a green accent. Icons are simple line drawings, with no emoji. It follows
your system's light or dark setting.

## Built for big databases

The data never gets loaded wholesale. Queries run in Python against the file
on disk, and the page only receives the 100 rows on screen.

- **Browsing is instant at any size.** The first page appears straight away.
  Row counts (which need a full scan) run separately in the background.
- **Nothing queues up.** If you change a filter while a slow sort or count is
  running, the old query is interrupted rather than finished.
- **You can see what's running.** Anything that takes more than half a second
  shows in an activity bar ("Summarising… 4.2s") with a Cancel button that
  stops it in the database. (SQLite can't say how far through a query it is,
  so this shows time taken rather than a percentage; exports, where the total
  is known, show a real progress bar.)
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
python3 -m unittest discover tests             # server + Excel writer (openpyxl, if installed, adds round-trip checks)
node --test                                    # query engine: steps -> SQL, run against the sample database
python3 scripts/make_sample.py                 # rebuild examples/sample.sqlite
python3 scripts/make_sample.py --big 4000000 /tmp/big.sqlite   # ~10M-row test database
```

- `dbexplorer.py`: local server that opens databases, runs queries, runs exports
- `xlsx_writer.py`: streaming, typed Excel writer
- `index.html`, `css/`, `js/app.js`: the interface
- `js/pipeline.js`: the query engine; turns applied steps into SQL and knows the relationships between tables (values are always bound parameters)
- `js/dom.js`: small UI toolkit (menus, popovers, dialogs)
- `examples/sample.sqlite`: demo database full of values spreadsheets like to mangle
