"""Streaming .xlsx writer - standard library only.

Rows are written straight into the zip as they arrive, so exports of any size
use a small, constant amount of memory.

Every cell's type comes from what SQLite actually stored, so Excel never
reinterprets anything:
    TEXT     -> text cell with the "@" (Text) format: leading zeros, "1E5",
                "2024-01-01", "=SUM()" stay exactly as stored, even if edited
    INTEGER  -> number shown in full (format "0", never 1.23E+13); if it has
                more than 15 digits it's written as text, since Excel would
                silently round it
    REAL     -> number
    NULL     -> empty cell
    BLOB     -> hex text
"""

import math
import re
import zipfile
from collections import Counter
from itertools import chain, islice
from xml.sax.saxutils import escape, quoteattr

MAX_ROWS = 1048576  # Excel's row limit, header included
MAX_CELL_CHARS = 32767
MAX_EXACT_INT = 999_999_999_999_999  # Excel keeps 15 significant digits

# Style indexes into cellXfs in STYLES below.
STYLE_INT, STYLE_HEADER, STYLE_TEXT = 1, 2, 3

# Characters XML 1.0 can't contain; Excel's own escape for them is _xHHHH_.
_ILLEGAL_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
# Text that already looks like an _xHHHH_ escape must itself be escaped, or
# Excel would decode it and change the value.
_LOOKS_ESCAPED = re.compile(r"_(x[0-9A-Fa-f]{4}_)")

NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

STYLES = XML_DECL + f"""<styleSheet xmlns="{NS_MAIN}">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"""


def column_letter(i):
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def _xml_text(s):
    s = _LOOKS_ESCAPED.sub(r"_x005F_\1", s)
    s = _ILLEGAL_XML.sub(lambda m: "_x%04X_" % ord(m.group()), s)
    return escape(s)


class XlsxWriter:
    """
        with open("out.xlsx", "wb") as f:
            w = XlsxWriter(f)
            w.add_sheet("customers", ["id", "name"], rows_iterable)
            w.close()
    """

    def __init__(self, fileobj, compresslevel=1):
        # Fast compression: exports are dominated by compression time and
        # level 1 is still ~10x smaller than the raw XML.
        self.zf = zipfile.ZipFile(fileobj, "w", zipfile.ZIP_DEFLATED, compresslevel=compresslevel)
        self.sheets = []  # (name, last_cell)
        self._used_names = set()
        self.warnings = Counter()
        self.rows_written = 0

    # ---- cells ----
    def _text_cell(self, ref, s):
        if len(s) > MAX_CELL_CHARS:
            self.warnings["truncated"] += 1
            s = s[:MAX_CELL_CHARS]
        return f'<c r="{ref}" s="{STYLE_TEXT}" t="inlineStr"><is><t xml:space="preserve">{_xml_text(s)}</t></is></c>'

    def _row_xml(self, r, row, letters):
        out = [f'<row r="{r}">']
        for i, v in enumerate(row):
            if v is None:
                continue
            ref = letters[i] + str(r)
            t = type(v)
            if t is str:
                out.append(self._text_cell(ref, v))
            elif t is int:
                if -MAX_EXACT_INT <= v <= MAX_EXACT_INT:
                    out.append(f'<c r="{ref}" s="{STYLE_INT}"><v>{v}</v></c>')
                else:
                    self.warnings["big_ints"] += 1
                    out.append(self._text_cell(ref, str(v)))
            elif t is float:
                if math.isfinite(v):
                    out.append(f'<c r="{ref}"><v>{v!r}</v></c>')
                else:
                    out.append(self._text_cell(ref, str(v)))
            elif t is bytes:
                n = min(len(v), (MAX_CELL_CHARS - 2) // 2)
                if n < len(v):
                    self.warnings["truncated"] += 1
                out.append(self._text_cell(ref, "0x" + v[:n].hex()))
            else:
                out.append(self._text_cell(ref, str(v)))
        out.append("</row>")
        return "".join(out)

    def _header_xml(self, columns, letters):
        cells = "".join(
            f'<c r="{letters[i]}1" s="{STYLE_HEADER}" t="inlineStr"><is><t xml:space="preserve">{_xml_text(str(c))}</t></is></c>'
            for i, c in enumerate(columns)
        )
        return f'<row r="1">{cells}</row>'

    # ---- sheets ----
    def _sheet_name(self, name):
        base = re.sub(r"[\[\]:*?/\\]", "_", str(name or "Sheet")).strip("'")[:31] or "Sheet"
        candidate, i = base, 2
        while candidate.lower() in self._used_names:
            suffix = f" ({i})"
            candidate = base[: 31 - len(suffix)] + suffix
            i += 1
        self._used_names.add(candidate.lower())
        return candidate

    def add_sheet(self, name, columns, rows, progress=None):
        """Write rows (any iterable of sequences). Results longer than Excel's
        row limit continue on extra sheets named "<name> (2)", etc.
        progress(rows_written_total) is called periodically; raise from it to abort."""
        columns = list(columns)
        letters = [column_letter(i) for i in range(len(columns))]
        rows = iter(rows)

        # Size columns and judge the need for zip64 from a sample of the rows.
        sample = list(islice(rows, 1000))
        widths = [max(8, len(str(c))) for c in columns]
        sample_bytes = 0
        for row in sample:
            for i, v in enumerate(row):
                if v is not None and i < len(widths):
                    widths[i] = max(widths[i], len(str(v)) if not isinstance(v, bytes) else 2 + 2 * len(v))
        if sample:
            probe = Counter(self.warnings)
            sample_bytes = sum(len(self._row_xml(2, r, letters)) for r in sample) / len(sample)
            self.warnings = probe  # the probe mustn't count warnings twice
        # A sheet's XML over 2 GB needs zip64; only use it when it could happen.
        zip64 = sample_bytes * MAX_ROWS > 1.8e9

        pending = chain(sample, rows)
        part = 1
        while True:
            sheet_name = self._sheet_name(name if part == 1 else f"{str(name)[:24]} ({part})")
            index = len(self.sheets) + 1
            r = 1
            with self.zf.open(f"xl/worksheets/sheet{index}.xml", "w", force_zip64=zip64) as f:
                head = [XML_DECL, f'<worksheet xmlns="{NS_MAIN}" xmlns:r="{NS_REL}">',
                        '<sheetViews><sheetView workbookViewId="0">'
                        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
                        '<selection pane="bottomLeft"/></sheetView></sheetViews>',
                        '<sheetFormatPr defaultRowHeight="15"/>']
                if columns:
                    head.append("<cols>" + "".join(
                        f'<col min="{i + 1}" max="{i + 1}" width="{min(w + 2, 60)}" customWidth="1"/>'
                        for i, w in enumerate(widths)) + "</cols>")
                head.append("<sheetData>")
                head.append(self._header_xml(columns, letters))
                f.write("".join(head).encode("utf-8"))

                buf = []
                for row in pending:
                    r += 1
                    buf.append(self._row_xml(r, row, letters))
                    if len(buf) >= 1000:
                        f.write("".join(buf).encode("utf-8"))
                        buf.clear()
                        self.rows_written += 1000
                        if progress:
                            progress(self.rows_written)
                    if r == MAX_ROWS:
                        break
                if buf:
                    f.write("".join(buf).encode("utf-8"))
                    self.rows_written += len(buf)
                    if progress:
                        progress(self.rows_written)

                last = f"{letters[-1] if letters else 'A'}{r}"
                tail = "</sheetData>"
                if columns:
                    tail += f'<autoFilter ref="A1:{last}"/>'
                f.write((tail + "</worksheet>").encode("utf-8"))
            self.sheets.append((sheet_name, last))

            if r < MAX_ROWS:
                return
            nxt = next(pending, None)
            if nxt is None:
                return
            self.warnings["split"] += 1
            pending = chain([nxt], pending)
            part += 1

    def close(self):
        n = len(self.sheets)
        if not n:  # a workbook needs at least one sheet
            self.add_sheet("Sheet1", [], [])
            n = 1
        zf = self.zf
        zf.writestr("[Content_Types].xml", XML_DECL +
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            + "".join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(1, n + 1))
            + "</Types>")
        zf.writestr("_rels/.rels", XML_DECL +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>")
        zf.writestr("xl/_rels/workbook.xml.rels", XML_DECL +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + "".join(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, n + 1))
            + f'<Relationship Id="rId{n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            "</Relationships>")
        sheets = "".join(f'<sheet name={quoteattr(name)} sheetId="{i}" r:id="rId{i}"/>' for i, (name, _) in enumerate(self.sheets, 1))
        filters = "".join(
            f'<definedName name="_xlnm._FilterDatabase" localSheetId="{i}" hidden="1">'
            f"{escape(_abs_ref(name, last))}</definedName>"
            for i, (name, last) in enumerate(self.sheets))
        zf.writestr("xl/workbook.xml", XML_DECL +
            f'<workbook xmlns="{NS_MAIN}" xmlns:r="{NS_REL}"><bookViews><workbookView/></bookViews>'
            f"<sheets>{sheets}</sheets><definedNames>{filters}</definedNames></workbook>")
        zf.writestr("xl/styles.xml", STYLES)
        zf.close()

    def describe_warnings(self):
        w, out = self.warnings, []
        if w["big_ints"]:
            out.append(f"{w['big_ints']:,} whole number(s) had more than 15 digits and were written as text so no digits are lost.")
        if w["truncated"]:
            out.append(f"{w['truncated']:,} cell(s) were longer than Excel's 32,767-character limit and were cut short.")
        if w["split"]:
            out.append("Results over 1,048,575 rows continue on extra sheets.")
        return out


def _abs_ref(sheet, last):
    m = re.match(r"([A-Z]+)(\d+)", last)
    return "'" + sheet.replace("'", "''") + f"'!$A$1:${m.group(1)}${m.group(2)}"
