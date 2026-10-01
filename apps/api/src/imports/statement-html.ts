import type { SheetCell, Worksheet } from "./xlsx.js";

/** True when the bytes are an HTML document or contain a table. */
export function looksLikeHtml(text: string): boolean {
  return /<table\b|<html\b/i.test(text);
}

/** Turns HTML tables into the same sheet shape as an .xlsx upload. */
export function htmlToWorksheets(html: string): readonly Worksheet[] {
  const decoded = decodeHtml(html);
  const tables = decoded.split(/<table\b/i).slice(1);
  return tables.map((table, index) => {
    const body = table.split(/<\/table>/i)[0] ?? table;
    const rows = body.split(/<tr\b/i).slice(1);
    const cells: SheetCell[] = [];
    rows.forEach((row, rowIndex) => {
      const rowBody = row.split(/<\/tr>/i)[0] ?? row;
      const parts = rowBody.split(/<t[dh]\b/i).slice(1);
      parts.forEach((part, colIndex) => {
        const inner = part.replace(/^[^>]*>/, "").split(/<\/t[dh]>/i)[0] ?? part;
        const text = inner
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (text.length === 0) return;
        const numeric = htmlNumber(text);
        cells.push({
          row: rowIndex + 1,
          col: colIndex + 1,
          kind: numeric === null ? "string" : "number",
          text: numeric ?? text,
          formula: false,
        });
      });
    });
    return { name: `Table ${index + 1}`, cells };
  });
}

function htmlNumber(value: string): string | null {
  if (/^(19|20)\d{2}$/.test(value)) return null;
  const negative = /^\(.*\)$/.test(value) || /\bDR\b/i.test(value);
  const body = value
    .replace(/[$£€₹,]/g, "")
    .replace(/[()]/g, "")
    .replace(/\b(?:CR|DR)\b/gi, "")
    .trim();
  if (!/^-?\d+(\.\d+)?$/.test(body)) return null;
  const unsigned = body.replace(/^-/, "");
  return negative || body.startsWith("-") ? `-${unsigned}` : unsigned;
}

function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}
