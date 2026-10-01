import type { ExtractedValue } from "@nexora/contracts";

export function SheetPreview({
  window,
}: {
  readonly window: NonNullable<ExtractedValue["sheetWindow"]>;
}) {
  return (
    <div className="review-source" data-testid="source-sheet">
      <table className="review-table" data-testid="sheet-grid">
        <caption className="sr-only">Source cells around the extracted value</caption>
        <tbody>
          {window.cells.map((row, rowIndex) => {
            const rowNumber = window.originRow + rowIndex;
            return (
              <tr key={rowNumber}>
                <th scope="row">{rowNumber}</th>
                {row.map((cell, colIndex) => {
                  const colNumber = window.originCol + colIndex;
                  const highlighted =
                    rowNumber === window.highlightRow && colNumber === window.highlightCol;
                  return (
                    <td
                      key={`${rowNumber}-${colNumber}`}
                      className={highlighted ? "sheet-highlight" : undefined}
                      data-testid={highlighted ? "sheet-highlight" : undefined}
                    >
                      {cell.length > 0 ? cell : "—"}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
