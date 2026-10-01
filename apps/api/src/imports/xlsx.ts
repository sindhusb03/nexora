import { strFromU8, unzipSync } from "fflate";

export interface SheetCell {
  readonly row: number;
  readonly col: number;
  readonly kind: "number" | "string" | "boolean" | "error";
  /** The stored text exactly as written in the file (the raw `<v>` for numbers). */
  readonly text: string;
  readonly formula: boolean;
  readonly dateFormat?: boolean;
  readonly date1904?: boolean;
}

export interface Worksheet {
  readonly name: string;
  readonly cells: readonly SheetCell[];
}

export class WorkbookError extends Error {
  override readonly name = "WorkbookError";
}

const MAX_UNZIPPED_BYTES = 64 * 1024 * 1024;

/** Reads an .xlsx package. Only workbook, relationship, shared-string, and worksheet parts are inflated. */
export function readWorkbook(bytes: Uint8Array): readonly Worksheet[] {
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        const wanted =
          file.name === "xl/workbook.xml" ||
          file.name === "xl/_rels/workbook.xml.rels" ||
          file.name === "xl/sharedStrings.xml" ||
          file.name === "xl/styles.xml" ||
          /^xl\/worksheets\/[^/]+\.xml$/.test(file.name);
        if (!wanted) return false;
        total += file.originalSize;
        if (total > MAX_UNZIPPED_BYTES) {
          throw new WorkbookError("The workbook expands past 64 MB; it was not read");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof WorkbookError) throw error;
    throw new WorkbookError("The file is not a readable .xlsx package");
  }

  const workbookXml = files["xl/workbook.xml"];
  const relsXml = files["xl/_rels/workbook.xml.rels"];
  if (!workbookXml || !relsXml) {
    throw new WorkbookError("The .xlsx package has no workbook part");
  }
  const targets = new Map<string, string>();
  for (const rel of strFromU8(relsXml).matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(rel[1] ?? "", "Id");
    const target = attr(rel[1] ?? "", "Target");
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const strings = files["xl/sharedStrings.xml"]
    ? readSharedStrings(strFromU8(files["xl/sharedStrings.xml"]))
    : [];

  const sheets: Worksheet[] = [];
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(strFromU8(workbookXml));
  const styles = files["xl/styles.xml"] ? strFromU8(files["xl/styles.xml"]) : "";
  const dateStyles = readDateStyles(styles);
  for (const sheet of strFromU8(workbookXml).matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const attrs = sheet[1] ?? "";
    const name = decodeXml(attr(attrs, "name") ?? "");
    const relId = attr(attrs, "r:id");
    const path = relId ? targets.get(relId) : undefined;
    const part = path ? files[path] : undefined;
    if (!part) continue;
    sheets.push({ name, cells: readCells(strFromU8(part), strings, dateStyles, date1904) });
  }
  return sheets;
}

function readSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const body = (si[1] ?? "").replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    let text = "";
    for (const t of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += t[1] ?? "";
    out.push(decodeXml(text));
  }
  return out;
}

function readDateStyles(xml: string): ReadonlySet<number> {
  const custom = new Map<number, string>();
  for (const match of xml.matchAll(/<numFmt\b([^>]*?)\/?\s*>/g)) {
    custom.set(
      Number(attr(match[1] ?? "", "numFmtId")),
      decodeXml(attr(match[1] ?? "", "formatCode") ?? ""),
    );
  }
  const styles = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  const dates = new Set<number>();
  [...styles.matchAll(/<xf\b([^>]*?)\/?\s*>/g)].forEach((m, i) => {
    const id = Number(attr(m[1] ?? "", "numFmtId"));
    const format = (custom.get(id) ?? "").replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "");
    if ((id >= 14 && id <= 17) || id === 22 || (id >= 27 && id <= 36) || /[yd]/i.test(format))
      dates.add(i);
  });
  return dates;
}

function readCells(
  xml: string,
  strings: readonly string[],
  dateStyles: ReadonlySet<number>,
  date1904: boolean,
): SheetCell[] {
  const cells: SheetCell[] = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNo = Number.parseInt(attr(rowMatch[1] ?? "", "r") ?? "", 10);
    const body = rowMatch[2] ?? "";
    let lastCol = 0;
    for (const cellMatch of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] ?? "";
      const inner = cellMatch[2] ?? "";
      const ref = attr(attrs, "r");
      const position = ref ? parseRef(ref) : null;
      const row = position?.row ?? rowNo;
      const col = position?.col ?? lastCol + 1;
      lastCol = col;
      if (!Number.isInteger(row)) continue;
      const type = attr(attrs, "t") ?? "n";
      const formula = /<f\b/.test(inner);
      const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      if (type === "inlineStr") {
        let text = "";
        for (const t of inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += t[1] ?? "";
        cells.push({ row, col, kind: "string", text: decodeXml(text), formula });
        continue;
      }
      if (value === undefined) continue;
      if (type === "s") {
        const text = strings[Number.parseInt(value, 10)];
        if (text !== undefined) cells.push({ row, col, kind: "string", text, formula });
      } else if (type === "str" || type === "d") {
        cells.push({ row, col, kind: "string", text: decodeXml(value), formula });
      } else if (type === "b") {
        cells.push({ row, col, kind: "boolean", text: value, formula });
      } else if (type === "e") {
        cells.push({ row, col, kind: "error", text: decodeXml(value), formula });
      } else {
        cells.push({
          row,
          col,
          kind: "number",
          text: value.trim(),
          formula,
          dateFormat: dateStyles.has(Number(attr(attrs, "s") ?? 0)),
          date1904,
        });
      }
    }
  }
  return cells;
}

function parseRef(ref: string): { row: number; col: number } | null {
  const match = /^([A-Z]{1,3})(\d+)$/.exec(ref);
  if (!match) return null;
  let col = 0;
  for (const char of match[1] ?? "") col = col * 26 + (char.charCodeAt(0) - 64);
  return { row: Number.parseInt(match[2] ?? "", 10), col };
}

function attr(attrs: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`).exec(attrs)?.[1] ?? null;
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const code = entity.startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : "";
  });
}
