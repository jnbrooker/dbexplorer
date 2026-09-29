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
order, so a filter after a Group by filters the groups. **Remove all steps**
under the steps takes you back to the plain table, and empties the search
box (so does moving to another table). **Undo** (⌘Z / Ctrl+Z) steps
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

- **Facets:** open the *Facets* panel (right-hand edge, hidden to start with)
  to see the most common values of a few columns, with counts that follow
  your steps, like Datasette. Click a value to keep only it, or its × to
  remove it. *Full table* shows every value and its count in the grid (a
  Group by, most common first). It picks likely columns for you; add others with *Add* or
  *Show in facets* on a column heading. It costs nothing while hidden. Open,
  it waits until the rows are on screen, then counts every facet in one pass
  over the first 200,000 rows (*Count all rows* for the rest). Results are
  cached, so Undo, sorting and page turns are instant.

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

## Dashboards

The **Dashboards** tab puts figures, charts, tables and maps on the front of
any database. Every panel can be edited.

- **Start quickly.** *Suggest a starter dashboard* works out what each column
  is from a random sample of rows: dates, categories, names, measures and
  coordinates, and what to leave alone (ids and codes such as UUIDs or
  `venue|city` keys, copies like `city_norm` or `countryCode`, bookkeeping
  like `loaded_at` or `source`, and mostly-empty columns). It builds one
  dashboard about the database's main subject (its biggest table with dates
  and things to group by, including ids that point at other tables, so
  `orders` with a `customer_id` gets "Top customers") and lays it out to fill
  the screen, topping up a narrow table with panels from related ones ("Order
  items by product"). Long numbers that are all different (`account_number`)
  count as ids, never as amounts, and a table's own name column isn't charted
  as "top names". On a huge table a name is grouped by an indexed copy when
  there is one (`headliner_key`, shown as `headliner`), and the map uses a
  smaller table with coordinates (venues, sized by their events). Views are
  only used if no table will do, since they run their whole query for every
  panel. Blanks never top a chart. *Add panel* lists more suggestions.
  In Explore, **Add to dashboard** turns whatever you're looking at into a
  panel; a query ending in a Group by becomes a chart of those groups.
- **Edit any panel** with its pencil. A drawer on the right sets:
  - what to *show as*: number (with a trend line and "+8% vs the period
    before"), bars, columns, line, table (green/red shading), mix, a month
    calendar, or a map;
  - the *data*: a table or a copy of a query tab's steps; what to group by
    (dates by day, week, month, quarter, year or day of the week); and the
    figures (count, total, average, smallest, largest, number of different);
  - the *look*: title, note, number format (£ $ € %), colours, sort, top N and
    "Other";
  - the *size*. **Edit layout** also lets you drag panels around and resize
    them from the corner.
- **Names, not ids.** A panel grouped by an id (`venue_id`) shows the names
  it stands for ("O2 Arena"), looked up through the foreign key or, when none
  is declared, a table named like the column (`venues`). The same goes for
  controls, and you can search them by name.
- **Controls** across the top (a date range, "venue = X") filter every panel
  whose data has that column. Clicking a bar, a table row, a slice of a mix or
  a month on a line chart sets them too; the chart you clicked keeps every
  value and highlights your pick. A panel can opt out.
- **Maps** find latitude and longitude columns by their names, and show a
  heatmap or dots sized by any figure. Points are counted into a grid in the
  database for the area on screen, so millions of rows arrive as a few
  thousand cells. Drag to pan, scroll to zoom. A street map background is
  one tick away; it loads map pictures from OpenStreetMap, so it's off until
  you turn it on.
- **Every panel is a query.** *Show SQL*, *Open in Explore* and *Download as
  Excel* are in its menu.
- **Quick estimates on big tables.** On a table of 200,000+ rows a panel is
  drawn first from about 2% of the rows (evenly spaced blocks, read straight
  off the table, so about 50 times faster and typically within a few %),
  marked *≈ estimate*, then replaced by the exact figures. Top-N charts of
  things with only a few rows each (top customers) wait for the exact
  figures, as a sample can't pick those out. Hover the note for why a panel
  is slow and which index would help.
- **Export PDF** saves the dashboard as a PDF (or prints it) on A4
  landscape: every panel loaded with exact figures and redrawn to fit the
  page, headed with the dashboard's name, the database, the date and any
  controls that are set.
- **Light on the database.** Panels load only when they're on screen, share
  three connections, reuse results they already have, and drop queued work
  when a control changes. Headline figures find the latest date once (off an
  index, if there is one) rather than reading the table twice. Searching a
  control's values stops the previous search. The toolbar shows what's
  loading, with Stop.

Dashboards are saved to a small file beside the database,
`<database>.dashboards.json`, so they travel with it. If that folder can't be
written to, they're kept in the browser instead, and the toolbar says so.

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

The only file DB Explorer writes is `<database>.dashboards.json` beside the
database, when you change a dashboard. Nothing else leaves your machine
unless you turn on a map's street map background, which fetches map pictures
of the area on screen from openstreetmap.org (not your data).

The page and its API only answer on 127.0.0.1, only to requests from the page
itself, not to other websites.

## Development

```bash
python3 -m unittest discover tests             # server + Excel writer (openpyxl, if installed, adds round-trip checks)
node --test                                    # query engine and dashboard SQL, run against the sample database
python3 scripts/make_sample.py                 # rebuild examples/sample.sqlite
python3 scripts/make_sample.py --big 4000000 /tmp/big.sqlite   # ~10M-row test database
```

- `dbexplorer.py`: local server that opens databases, runs queries, runs exports
- `xlsx_writer.py`: streaming, typed Excel writer
- `index.html`, `css/`, `js/app.js`: the interface
- `js/pipeline.js`: the query engine; turns applied steps into SQL and knows the relationships between tables (values are always bound parameters)
- `js/dashboard.js`: the Dashboards tab; panel SQL (tested with node), charts, maps and the editor drawer
- `js/dom.js`: small UI toolkit (menus, popovers, dialogs)
- `examples/sample.sqlite`: demo database full of values spreadsheets like to mangle
