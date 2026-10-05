import { strToU8, zipSync } from "fflate";

export interface XlsxCell {
  readonly row: number;
  readonly col: number;
  readonly value: string;
  readonly kind: "string" | "number";
}

export interface XlsxSheetInput {
  readonly name: string;
  readonly cells: readonly XlsxCell[];
}

/** Minimal .xlsx package. The reader in this app only needs workbook, rels, and worksheets. */
export function writeXlsx(sheets: readonly XlsxSheetInput[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const sheetTags = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("");
  files["xl/workbook.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`,
  );
  const rels = sheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join("");
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  );
  sheets.forEach((sheet, index) => {
    const rows = new Map<number, XlsxCell[]>();
    for (const cell of sheet.cells) {
      const list = rows.get(cell.row) ?? [];
      list.push(cell);
      rows.set(cell.row, list);
    }
    const rowXml = [...rows.keys()]
      .sort((a, b) => a - b)
      .map((rowNo) => {
        const cells = (rows.get(rowNo) ?? [])
          .sort((a, b) => a.col - b.col)
          .map((cell) => {
            const ref = `${columnName(cell.col)}${cell.row}`;
            if (cell.kind === "number") return `<c r="${ref}"><v>${escapeXml(cell.value)}</v></c>`;
            return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(cell.value)}</t></is></c>`;
          })
          .join("");
        return `<row r="${rowNo}">${cells}</row>`;
      })
      .join("");
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`,
    );
  });
  return zipSync(files);
}

function columnName(col: number): string {
  let value = col;
  let name = "";
  while (value > 0) {
    const rem = (value - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
