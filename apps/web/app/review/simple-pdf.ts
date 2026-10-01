/** Minimal PDF so the review screen can highlight a bbox with pdf.js. */

export function buildSimplePdf(lines: readonly string[]): string {
  return buildPdf([lines]);
}

/** One entry per page. Text is drawn in Helvetica, 18 points apart from the top. */
export function buildPdf(pages: readonly (readonly string[])[]): string {
  const pageCount = pages.length;
  const fontId = 3 + pageCount * 2;
  const kids = pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  const objects: string[] = [
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
    `2 0 obj<</Type/Pages/Count ${pageCount}/Kids[${kids}]>>endobj\n`,
  ];
  for (const [index, lines] of pages.entries()) {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    const commands = lines
      .map((line, lineIndex) => {
        const text = line.replace(/[()\\]/g, (char) => `\\${char}`);
        return `BT /F1 12 Tf 72 ${720 - lineIndex * 18} Td (${text}) Tj ET`;
      })
      .join("\n");
    const stream = `${commands}\n`;
    objects.push(
      `${pageId} 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents ${contentId} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>endobj\n`,
    );
    objects.push(
      `${contentId} 0 obj<</Length ${stream.length}>>stream\n${stream}endstream\nendobj\n`,
    );
  }
  objects.push(`${fontId} 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n`);

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }
  const xref = body.length;
  const size = fontId + 1;
  let trailer = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const offset of offsets) trailer += `${String(offset).padStart(10, "0")} 00000 n \n`;
  trailer += `trailer<</Size ${size}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return bytesToBase64(new TextEncoder().encode(body + trailer));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
