#!/usr/bin/env python3
"""DB Explorer.

Serves the explorer on http://127.0.0.1 and runs its queries against a SQLite
database on disk. Built for large databases: the data stays in the file, the
page only ever receives the rows on screen, and Excel exports are streamed to
disk row by row. Standard library only - nothing to install.

    python3 dbexplorer.py                      # then type a path in the page
    python3 dbexplorer.py ~/data/sales.sqlite  # open this database straight away

(On Windows, type python instead of python3.)

The database is opened read-only and never modified. Dashboards are the one
thing written to disk: a small <database>.dashboards.json beside it.
"""

import argparse
import atexit
import http.server
import json
import os
import re
import secrets
import shlex
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import webbrowser

from xlsx_writer import XlsxWriter

APP_DIR = os.path.dirname(os.path.abspath(__file__))
SAMPLE_PATH = os.path.join(APP_DIR, "examples", "sample.sqlite")
SQLITE_HEADER = b"SQLite format 3\x00"
STATIC_ROOTS = ("index.html", "css/", "js/")
MAX_PAGE_ROWS = 1000
MAX_SAFE_JS_INT = 2**53 - 1
MAX_DASHBOARD_BYTES = 2_000_000
EXPORT_DIR = tempfile.mkdtemp(prefix="dbexplorer-")
atexit.register(shutil.rmtree, EXPORT_DIR, ignore_errors=True)


class Cancelled(Exception):
    pass


# ---------------------------------------------------------------- opening

def clean_path(raw):
    """Accept paths however they were copied: quoted (Windows "Copy as path"),
    with backslash-escaped spaces (dragged into a Mac Terminal), with ~, or as
    a file:// URL."""
    p = raw.strip()
    if p.startswith("file://"):
        p = urllib.request.url2pathname(urllib.parse.urlparse(p).path)  # handles file:///C:/... on Windows
    elif len(p) > 1 and p[0] in "'\"" and p[-1] == p[0]:
        p = p[1:-1]  # just drop the quotes: shlex would eat Windows backslashes
    elif os.name != "nt" and "\\ " in p:
        try:
            parts = shlex.split(p)
            if len(parts) == 1:
                p = parts[0]
        except ValueError:
            pass
    return os.path.abspath(os.path.expanduser(p))


def check_database(path):
    if not os.path.exists(path):
        raise ValueError(f"No file at {path}")
    if os.path.isdir(path):
        raise ValueError(f"{path} is a folder, not a database file")
    with open(path, "rb") as f:
        if f.read(16) != SQLITE_HEADER:
            raise ValueError(f"{os.path.basename(path)} is not a SQLite database")


# Pragmas whose argument names what to look at rather than setting anything.
LOOKUP_PRAGMAS = {"table_info", "table_xinfo", "table_list", "index_list", "index_info", "index_xinfo",
                  "foreign_key_list", "foreign_key_check", "integrity_check", "quick_check"}


def _authorizer(action, arg1, arg2, dbname, source):
    # Belt and braces on top of the read-only connection: no attaching other
    # files and no changing settings (reading pragmas is fine).
    if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_PRAGMA and arg2 is not None and str(arg1).lower() not in LOOKUP_PRAGMAS:
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def connect(path):
    """A read-only connection. Each new query sees the database as it is now,
    including changes another program has just made."""
    uri = "file:" + urllib.parse.quote(path) + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, check_same_thread=False, isolation_level=None)
    conn.text_factory = lambda b: b.decode("utf-8", "replace")
    conn.execute("PRAGMA query_only = 1")
    conn.execute("PRAGMA cache_size = -65536")  # 64 MB page cache
    conn.execute("PRAGMA mmap_size = 268435456")
    conn.set_authorizer(_authorizer)
    return conn


def load_schema(conn):
    qi = lambda n: '"' + n.replace('"', '""') + '"'
    objects = conn.execute(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') "
        "AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name COLLATE NOCASE").fetchall()
    estimates = {}
    try:  # row-count estimates gathered by ANALYZE, if the database has them
        for tbl, stat in conn.execute("SELECT tbl, stat FROM sqlite_stat1 WHERE stat IS NOT NULL"):
            n = int(str(stat).split()[0])
            estimates[tbl] = max(estimates.get(tbl, 0), n)
    except (sqlite3.Error, ValueError):
        pass
    tables = []
    for name, kind in objects:
        try:
            cols = conn.execute("SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid", (name,)).fetchall()
            fks = conn.execute('SELECT id, "table", "from", "to" FROM pragma_foreign_key_list(?) ORDER BY id, seq',
                               (name,)).fetchall() if kind == "table" else []
        except sqlite3.Error:
            continue  # e.g. a virtual table whose module isn't available
        if not cols:
            continue
        # Columns that lead an index: grouping or filtering on these is fast
        # even on a huge table, so dashboards prefer them.
        indexed = [c for c, _, pk in cols if pk == 1]
        try:
            for (iname,) in conn.execute("SELECT name FROM pragma_index_list(?)", (name,)).fetchall():
                first = conn.execute("SELECT name FROM pragma_index_info(?) WHERE seqno = 0", (iname,)).fetchone()
                if first and first[0] and first[0] not in indexed:
                    indexed.append(first[0])
        except sqlite3.Error:
            pass
        tables.append({
            "name": name,
            "type": kind,
            "columns": [{"name": c, "type": t or "", "pk": pk} for c, t, pk in cols],
            "fks": [{"id": i, "table": t, "from": f, "to": to} for i, t, f, to in fks],
            "estimate": estimates.get(name),
            "indexed": indexed,
        })
    return tables


# ---------------------------------------------------------------- queries

class Slot:
    """One connection per (database, purpose) - e.g. the page of rows on
    screen, the row count, the SQL tab. A new request for the same purpose
    interrupts the one still running, so the app never queues behind a slow
    query the user has already moved on from."""

    def __init__(self, path):
        self.conn = connect(path)
        self.lock = threading.Lock()
        self.meta = threading.Lock()
        self.generation = 0


DATABASES = {}  # id -> path
SLOTS = {}
SLOTS_LOCK = threading.Lock()


def get_slot(db_id, key):
    path = DATABASES.get(db_id)
    if path is None:
        raise ValueError("That database is no longer open - please open it again")
    with SLOTS_LOCK:
        slot = SLOTS.get((db_id, key))
        if slot is None:
            slot = SLOTS[(db_id, key)] = Slot(path)
        return slot


def encode_value(v):
    """JSON-safe cell values. Integers too big for JavaScript to hold exactly
    are sent as strings so the page shows every digit."""
    if isinstance(v, int) and not -MAX_SAFE_JS_INT <= v <= MAX_SAFE_JS_INT:
        return {"$int": str(v)}
    if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
        return {"$text": str(v)}
    if isinstance(v, bytes):
        return {"$blob": len(v)}
    return v


def decode_params(params):
    """Values the page picked from cells come back in the same wrapped form
    they were sent in; turn them back into real values for binding."""
    out = []
    for p in params:
        if isinstance(p, dict) and "$int" in p:
            p = int(p["$int"])
        elif isinstance(p, dict) and "$text" in p:
            p = str(p["$text"])
        elif isinstance(p, (dict, list)):
            raise ValueError("Unsupported parameter")
        out.append(p)
    return out


def run_query(db_id, key, sql, params, limit):
    params = decode_params(params)
    slot = get_slot(db_id, key)
    with slot.meta:
        slot.generation += 1
        mine = slot.generation
    slot.conn.interrupt()  # stop whatever this slot is still running
    with slot.lock:
        if slot.generation != mine:
            raise Cancelled()  # an even newer request is waiting
        started = time.monotonic()
        try:
            cur = slot.conn.execute(sql, params)
        except sqlite3.OperationalError as e:
            if "interrupt" in str(e):
                raise Cancelled()
            raise
        try:
            if cur.description is None:
                return {"columns": [], "rows": [], "more": False, "ms": 0}
            columns = [d[0] for d in cur.description]
            rows = cur.fetchmany(limit + 1)
        except sqlite3.OperationalError as e:
            if "interrupt" in str(e):
                raise Cancelled()
            raise
        finally:
            cur.close()
        return {
            "columns": columns,
            "rows": [[encode_value(v) for v in r] for r in rows[:limit]],
            "more": len(rows) > limit,
            "ms": round((time.monotonic() - started) * 1000),
        }


# ---------------------------------------------------------------- dashboards

def dashboards_file(db_id):
    """Dashboards live in a small JSON file next to the database, so they
    travel with it. Only ever this one derived name: never a path from the page."""
    path = DATABASES.get(db_id)
    if path is None:
        raise ValueError("That database is no longer open - please open it again")
    return path + ".dashboards.json"


def load_dashboards(db_id):
    f = dashboards_file(db_id)
    try:
        with open(f, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        data = None
    except (OSError, ValueError) as e:
        raise ValueError(f"Couldn't read {os.path.basename(f)}: {e}")
    return {"data": data, "file": f}


def save_dashboards(db_id, data):
    f = dashboards_file(db_id)
    text = json.dumps(data, ensure_ascii=False, indent=1)
    if len(text.encode("utf-8")) > MAX_DASHBOARD_BYTES:
        raise ValueError("Those dashboards are too big to save")
    tmp = f + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, f)  # all or nothing: a crash never leaves half a file
    except OSError as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise ValueError(f"Couldn't save next to the database ({e.strerror or e})")
    return {"ok": True, "file": f}


# ---------------------------------------------------------------- exports

EXPORTS = {}  # token -> job dict


def run_export(job):
    conn = None
    try:
        conn = connect(job["path"])
        job["conn"] = conn

        def progress(n):
            job["rows"] = n
            if job["cancel"]:
                raise Cancelled()

        with open(job["file"], "wb") as f:
            writer = XlsxWriter(f)
            for sheet in job["sheets"]:
                job["sheet"] = sheet["name"]
                cur = conn.execute(sheet["sql"], decode_params(sheet.get("params") or []))
                if cur.description is None:
                    raise ValueError("That query doesn't return any rows to export")
                columns = sheet.get("columns") or [d[0] for d in cur.description]

                def rows(cur=cur):
                    while True:
                        batch = cur.fetchmany(5000)
                        if not batch:
                            return
                        yield from batch

                writer.add_sheet(sheet["name"], columns, rows(), progress)
                cur.close()
            writer.close()
        job["rows"] = writer.rows_written
        job["warnings"] = writer.describe_warnings()
        job["state"] = "done"
    except Cancelled:
        job["state"] = "cancelled"
    except sqlite3.OperationalError as e:
        job["state"] = "cancelled" if job["cancel"] else "error"
        job["error"] = str(e)
    except Exception as e:  # report anything else to the page
        job["state"] = "error"
        job["error"] = str(e)
    finally:
        if conn:
            conn.close()
        job.pop("conn", None)
        if job["state"] != "done":
            try:
                os.remove(job["file"])
            except OSError:
                pass


def safe_filename(name):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", str(name)).strip() or "export"
    return name if name.lower().endswith(".xlsx") else name + ".xlsx"


# ---------------------------------------------------------------- HTTP

class Handler(http.server.SimpleHTTPRequestHandler):
    startup_path = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def host_ok(self):
        # Guards against DNS rebinding: only answer requests addressed to us.
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        return host in ("127.0.0.1", "localhost")

    def api_ok(self):
        # A custom header can't be sent cross-site without a CORS preflight
        # (which we never approve), so other websites can't drive the API.
        return self.headers.get("X-DBX") == "1"

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        if not self.host_ok():
            return self.send_error(403)
        url = urllib.parse.urlparse(self.path)
        parts = url.path.strip("/").split("/")

        if parts[:1] == ["download"] and len(parts) == 2:
            return self.download(parts[1])
        if parts[:1] == ["api"]:
            if not self.api_ok():
                return self.send_error(403)
            if parts == ["api", "startup"]:
                return self.send_json(200, {"path": Handler.startup_path, "samplePath": SAMPLE_PATH})
            if parts[:2] == ["api", "export"] and len(parts) == 3:
                job = EXPORTS.get(parts[2])
                if not job:
                    return self.send_json(404, {"error": "Unknown export"})
                return self.send_json(200, {k: job.get(k) for k in ("state", "rows", "sheet", "error", "warnings", "filename")})
            return self.send_error(404)

        rel = urllib.parse.unquote(url.path).lstrip("/") or "index.html"
        if ".." in rel.split("/") or not rel.startswith(STATIC_ROOTS):
            return self.send_error(404)
        if rel == "index.html":
            return self.send_index()
        super().do_GET()

    def end_headers(self):
        # Make the browser check for a newer copy every time, so an updated
        # app never runs with a stale script left over in the cache.
        if not self.path.startswith(("/api/", "/download/")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_index(self):
        """The page, with each script and stylesheet address stamped with the
        file's last-modified time, so updates are always fetched fresh."""
        with open(os.path.join(APP_DIR, "index.html"), encoding="utf-8") as f:
            html = f.read()

        def stamp(m):
            path = os.path.join(APP_DIR, m.group(2))
            try:
                version = int(os.path.getmtime(path))
            except OSError:
                return m.group(0)
            return f'{m.group(1)}="{m.group(2)}?v={version}"'

        html = re.sub(r'(src|href)="((?:js|css)/[^"?]+)"', stamp, html)
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not self.host_ok() or not self.api_ok():
            return self.send_error(403)
        route = urllib.parse.urlparse(self.path).path.strip("/")
        try:
            body = self.read_body()
            if route == "api/open":
                return self.open_database(body)
            if route == "api/query":
                key = str(body.get("key") or "default")
                if not re.fullmatch(r"\w{1,32}", key):
                    raise ValueError("Bad query key")
                limit = max(1, min(int(body.get("limit") or 100), MAX_PAGE_ROWS))
                result = run_query(body.get("id"), key, body["sql"], body.get("params") or [], limit)
                return self.send_json(200, result)
            if route == "api/cancel":
                # Stop running queries (the page's Cancel button). Interrupting
                # an idle connection does nothing.
                for key in body.get("keys") or []:
                    slot = SLOTS.get((body.get("id"), str(key)))
                    if slot:
                        slot.conn.interrupt()
                return self.send_json(200, {"ok": True})
            if route == "api/dashboards":
                return self.send_json(200, load_dashboards(body.get("id")))
            if route == "api/dashboards/save":
                if not isinstance(body.get("data"), dict):
                    raise ValueError("Nothing to save")
                return self.send_json(200, save_dashboards(body.get("id"), body["data"]))
            if route == "api/export":
                return self.start_export(body)
            m = re.fullmatch(r"api/export/(\w+)/cancel", route)
            if m:
                job = EXPORTS.get(m.group(1))
                if job:
                    job["cancel"] = True
                    if job.get("conn"):
                        job["conn"].interrupt()
                return self.send_json(200, {"ok": True})
            self.send_error(404)
        except Cancelled:
            self.send_json(409, {"cancelled": True})
        except (ValueError, KeyError, sqlite3.Error) as e:
            self.send_json(400, {"error": str(e)})

    def open_database(self, body):
        raw = str(body.get("path") or "")
        if not raw.strip():
            raise ValueError("Type the path to a database file")
        path = clean_path(raw)
        check_database(path)
        conn = connect(path)
        try:
            tables = load_schema(conn)
        finally:
            conn.close()
        db_id = secrets.token_hex(8)
        DATABASES[db_id] = path
        self.send_json(200, {"id": db_id, "path": path, "name": os.path.basename(path),
                             "size": os.path.getsize(path), "tables": tables,
                             "sqliteVersion": sqlite3.sqlite_version})

    def start_export(self, body):
        path = DATABASES.get(body.get("id"))
        if path is None:
            raise ValueError("That database is no longer open - please open it again")
        sheets = body.get("sheets") or []
        if not sheets:
            raise ValueError("Nothing to export")
        token = secrets.token_urlsafe(16)
        job = {
            "path": path, "sheets": sheets, "state": "running", "rows": 0, "sheet": None,
            "error": None, "warnings": [], "cancel": False,
            "filename": safe_filename(body.get("filename") or "export"),
            "file": os.path.join(EXPORT_DIR, token + ".xlsx"),
        }
        EXPORTS[token] = job
        threading.Thread(target=run_export, args=(job,), daemon=True).start()
        self.send_json(200, {"token": token})

    def download(self, token):
        job = EXPORTS.get(token)
        if not job or job["state"] != "done" or not os.path.exists(job["file"]):
            return self.send_error(404, "This download has expired - export again")
        name = job["filename"]
        ascii_name = name.encode("ascii", "replace").decode().replace("?", "_").replace('"', "_")
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        self.send_header("Content-Length", str(os.path.getsize(job["file"])))
        self.send_header("Content-Disposition",
                         f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{urllib.parse.quote(name)}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(job["file"], "rb") as f:
            shutil.copyfileobj(f, self.wfile, 1024 * 1024)
        EXPORTS.pop(token, None)
        try:
            os.remove(job["file"])
        except OSError:
            pass


def start_server(preferred):
    """Use the preferred port, or the next free one if something else has it."""
    for port in range(preferred, preferred + 50):
        try:
            server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
            server.daemon_threads = True
            return server
        except OSError:
            continue
    raise SystemExit("No free port found")


def main():
    ap = argparse.ArgumentParser(description="Explore a SQLite database and export to Excel.")
    ap.add_argument("database", nargs="?", help="path to a SQLite database to open")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser window")
    args = ap.parse_args()

    if args.database:
        path = clean_path(args.database)
        try:
            check_database(path)
            connect(path).close()
        except (ValueError, OSError, sqlite3.Error) as e:
            sys.exit(f"Can't open {path}: {e}")
        Handler.startup_path = path

    server = start_server(args.port)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"DB Explorer running at {url}  (Ctrl+C to stop)", flush=True)
    if not args.no_browser:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
