export interface PdfTextRun {
  readonly x: number;
  readonly text: string;
}

export interface PdfTextRow {
  readonly items: readonly PdfTextRun[];
}

/** Builds a text-layer PDF (Helvetica, PDF points, origin bottom-left) that pdf.js can read. */
export function renderTextPdf(pages: readonly (readonly PdfTextRow[])[]): Uint8Array {
  const pageObjects: string[] = [];
  const contentObjects: string[] = [];
  pages.forEach((rows, index) => {
    const content = rows
      .map((row, rowIndex) => {
        const y = 740 - rowIndex * 14;
        return row.items
          .map(
            (item) => `BT /F1 11 Tf 1 0 0 1 ${item.x} ${y} Tm (${escapePdfText(item.text)}) Tj ET`,
          )
          .join("\n");
      })
      .join("\n");
    contentObjects.push(content);
    pageObjects.push(String(index));
  });

  const objects: string[] = [];
  const kids = pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((_, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> >>`,
    );
    const stream = contentObjects[index] ?? "";
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  objects.forEach((object, index) => {
    offsets.push(byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) {
    body += `${String(offsets[index] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body, "latin1");
}

export function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "latin1");
}
