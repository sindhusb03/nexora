import { describe, expect, it } from "vitest";
import { selectDocumentParser } from "../src/imports/document-parser.js";
import { decimalToMinor } from "../src/ingestion/service.js";
import { round1Corpus } from "./fixtures/round1-corpus.js";
import { parseBankPdfLines, parseBankText } from "../src/imports/bank-tabular.js";
import { detectCurrency } from "../src/imports/document-parser.js";
import { parseMoneyToken } from "../src/imports/decimal-text.js";

// These source documents print running balances but no explicit closing balance.
const inferredClosing = new Set([
  "bank-india-0",
  "bank-india-1",
  "bank-india-2",
  "fees-0",
  "fees-1",
  "fees-2",
  "row-currency-EUR",
  "row-currency-AUD",
  "serial-bank-0",
  "serial-bank-1",
]);

describe("blind FAIL round 1 regression families", () => {
  it("does not infer a currency from shared symbols", () => {
    expect(parseMoneyToken("1 234,56", "comma")).toBe("1234.56");
    expect(parseMoneyToken("1'234.56", "dot")).toBe("1234.56");
    for (const symbol of ["$", "¥", "kr", "Rs"]) expect(detectCurrency(symbol)).toBeNull();
    expect(detectCurrency("S$", "AUD")).toBe("AUD");
    expect(detectCurrency("US$")).toBe("USD");
    expect(detectCurrency("Statement currency SGD", "AUD")).toBe("SGD");
  });
  it("holds missing completed dates and ambiguous fee semantics", () => {
    for (const [date, amount, fee] of [
      ["", "100", "2"],
      ["2025-02-30", "100", "2"],
      ["2025-02-20", "100", "-2"],
    ]) {
      const parsed = parseBankText(
        `Account currency GBP\nStarted Date,Completed Date,Description,Amount,Fee,Balance\n2025-02-01,2025-02-01,Opening balance,,,500\n2025-02-19,${date},Receipt,${amount},${fee},598`,
      );
      expect(parsed.bank?.transactions ?? []).toEqual([]);
      expect(parsed.issues.length).toBeGreaterThan(0);
    }
  });
  it("aligns split PDF headers, right-aligned amounts, and repeated page headers", () => {
    const header = {
      page: 1,
      y: 700,
      items: [
        { x: 20, text: "Date", width: 25 },
        { x: 110, text: "Description", width: 70 },
        { x: 300, text: "Withdrawal", width: 60 },
        { x: 362, text: "(Dr)", width: 20 },
        { x: 410, text: "Deposit", width: 45 },
        { x: 457, text: "(Cr)", width: 20 },
        { x: 510, text: "Balance", width: 50 },
      ],
    };
    const result = parseBankPdfLines([
      header,
      {
        page: 1,
        y: 680,
        items: [
          { x: 110, text: "Balance Brought Forward", width: 150 },
          { x: 528, text: "1000.00", width: 32 },
        ],
      },
      { ...header, page: 2 },
      {
        page: 2,
        y: 680,
        items: [
          { x: 20, text: "2025-08-18", width: 70 },
          { x: 110, text: "Receipt", width: 40 },
          { x: 445, text: "250.00", width: 32 },
          { x: 528, text: "1250.00", width: 32 },
        ],
      },
    ]);
    expect(result.bank?.opening).toBe("1000.00");
    expect(result.bank?.transactions.map((t) => t.amount)).toEqual(["250.00"]);
    expect(result.issues).toEqual([]);
  });
  it.each(round1Corpus())("$id", async (fixture) => {
    const parsed = await selectDocumentParser(fixture.fileName, fixture.bytes).parse(fixture);
    expect(
      parsed.cells.map((cell) => ({
        label: cell.label,
        minor: decimalToMinor(
          cell.amount,
          cell.currency ?? fixture.functionalCurrency,
          cell.scale,
          false,
        ),
        currency: cell.currency ?? fixture.functionalCurrency,
        end: cell.periodEnd,
        date: cell.txnDate,
      })),
      JSON.stringify(parsed.issues),
    ).toEqual(
      fixture.expected.filter(
        ({ label }) => label !== "Closing balance" || !inferredClosing.has(fixture.id),
      ),
    );
    if (!fixture.expected.length) expect(parsed.issues.length).toBeGreaterThan(0);
  });
});
