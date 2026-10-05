import type { SheetCell, Worksheet } from "./xlsx.js";

/** True when the bytes are an HTML document or contain a table. */
export function looksLikeHtml(text: string): boolean {
  return /<table\b|<html\b/i.test(text);
}

/** Turns HTML tables into the same sheet shape as an .xlsx upload. */
export function htmlToWorksheets(html: string): readonly Worksheet[] {
  const decoded = decodeHtml(html);
  const parts = decoded.split(/<table\b/i);
  const tables = parts.slice(1);
  return tables.map((table, index) => {
    const body = table.split(/<\/table>/i)[0] ?? table;
    const rows = body.split(/<tr\b/i).slice(1);
    const cells: SheetCell[] = [];
    const preamble = (parts[index] ?? "")
      .split(/<\/table>/i)
      .at(-1)
      ?.replace(/<[^>]+>/g, " ")
      .trim();
    if (preamble) cells.push({ row: 0, col: 1, kind: "string", text: preamble, formula: false });
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
        cells.push({
          row: rowIndex + 1,
          col: colIndex + 1,
          // Printed HTML numbers have locale-dependent punctuation, unlike an
          // XLSX numeric <v>. Keep their original text for document inference.
          kind: "string",
          text,
          formula: false,
        });
      });
    });
    return { name: `Table ${index + 1}`, cells };
  });
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
