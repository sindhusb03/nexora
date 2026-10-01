import { AnalyticalDecimal, mapLineLabel, mappingIsAutoAcceptable } from "@nexora/kernel";
import { describe, expect, it } from "vitest";

import { selectDocumentParser, type ParsedCell } from "../src/imports/document-parser.js";
import { heldOutDocs, type HeldCell } from "./heldout-corpus.js";

/**
 * Synthetic layouts authored before the parser changes that target them.
 * A miss is an expected cell that was not extracted. A wrong value is an
 * extracted cell that is not in the ground truth. Neither is the judge's blind set.
 */
describe("held-out extraction", () => {
  it("extracts at least 80 percent with no wrong amount and no wrong auto-accept", async () => {
    const docs = heldOutDocs();
    expect(docs.length).toBeGreaterThanOrEqual(15);
    const rows: string[] = [];
    let expected = 0;
    let matched = 0;
    const wrong: string[] = [];
    const wrongAuto: string[] = [];
    for (const doc of docs) {
      const parsed = await selectDocumentParser(doc.fileName, doc.bytes).parse({
        fileName: doc.fileName,
        bytes: doc.bytes,
      });
      const used = new Set<number>();
      let hits = 0;
      for (const cell of doc.cells) {
        const index = parsed.cells.findIndex(
          (candidate, candidateIndex) => !used.has(candidateIndex) && sameCell(candidate, cell),
        );
        if (index >= 0) {
          used.add(index);
          hits += 1;
        }
      }
      for (const [index, cell] of parsed.cells.entries()) {
        if (!used.has(index)) {
          wrong.push(
            `${doc.id}:${cell.label}:${cell.amount}:${cell.periodEnd}:${cell.statementType}`,
          );
        }
      }
      for (const cell of parsed.cells) {
        const hit = mapLineLabel(cell.label);
        if (!hit || !mappingIsAutoAcceptable(hit.confidence)) continue;
        const truth = doc.cells.find((candidate) => candidate.label === cell.label);
        if (!truth?.autoAccept || truth.accountCode !== hit.accountCode) {
          wrongAuto.push(`${doc.id}:${cell.label}->${hit.accountCode}`);
        }
      }
      expected += doc.cells.length;
      matched += hits;
      rows.push(`${doc.id} ${hits}/${doc.cells.length}`);
    }
    const rate = expected === 0 ? 0 : matched / expected;
    const summary = `${matched}/${expected} (${rate.toFixed(3)}) ${rows.join("; ")}`;
    expect(wrong, summary).toEqual([]);
    expect(wrongAuto, summary).toEqual([]);
    expect(rate, summary).toBeGreaterThanOrEqual(0.8);
  });
});

function sameCell(actual: ParsedCell, expected: HeldCell): boolean {
  if (actual.label !== expected.label) return false;
  if (actual.statementType !== expected.statementType) return false;
  if (!new AnalyticalDecimal(actual.amount).eq(expected.amount)) return false;
  if (actual.periodStart !== expected.periodStart || actual.periodEnd !== expected.periodEnd) {
    return false;
  }
  if (actual.scale !== expected.scale || actual.currency !== expected.currency) return false;
  if (expected.balanceKind === "movement" && actual.txnDate !== expected.txnDate) return false;
  if (expected.balanceKind !== undefined && actual.balanceKind !== expected.balanceKind)
    return false;
  return true;
}
