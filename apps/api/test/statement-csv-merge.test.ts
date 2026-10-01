import { describe, expect, it } from "vitest";
import { parseGrid, parseStatementCsv } from "../src/imports/statement-csv.js";
import { selectDocumentParser } from "../src/imports/document-parser.js";
import { statementPeriodCorpus } from "./fixtures/statement-period-corpus.js";
import { localizedCorpus } from "./fixtures/localized-corpus.js";
import { bankRound3aCorpus } from "./fixtures/bank-round3a-corpus.js";
import { bankValueCorpus } from "./fixtures/bank-value-corpus.js";
import { AnalyticalDecimal } from "@nexora/kernel";

describe("merged CSV delimiter handling", () => {
  it("strips a BOM for direct grid consumers", () => {
    expect(parseGrid('\uFEFF"Date";"Amount"\r\n2025-01-01;12.50')).toEqual([
      ["Date", "Amount"],
      ["2025-01-01", "12.50"],
    ]);
  });

  it("ignores delimiters and escaped quotes inside multiline quoted cells", () => {
    expect(parseGrid('"Report;\t\n""quoted""",2025\nCash,12.50')).toEqual([
      ['Report;\t\n"quoted"', "2025"],
      ["Cash", "12.50"],
    ]);
  });

  it.each([";", "\t"])("finds %j after title rows with decimal commas", (delimiter) => {
    expect(parseGrid(`Report\nDate${delimiter}Amount\n2025-01-01${delimiter}1,234,567.89`)).toEqual(
      [["Report"], ["Date", "Amount"], ["2025-01-01", "1,234,567.89"]],
    );
  });

  it.each(['"Cash"oops,10', 'Ca"sh,10', '"Cash,10'])("rejects malformed quoting: %s", (text) => {
    expect(() => parseGrid(text)).toThrow(/CSV quot/);
  });
});

describe("CSV display and ingestion compatibility", () => {
  it("keeps ambiguous and conflicting source conventions unresolved for ingestion", () => {
    for (const values of [
      ["1,234", "2,345"],
      ["1234,5", "1234.5"],
    ]) {
      const book = parseStatementCsv(
        `Compte de résultat;\nAccount;Year ended 31 March 2025\nChiffre d’affaires;${values[0]}\nCharges de personnel;${values[1]}`,
        "income.csv",
      );
      expect(book.layoutUnresolved).toBe(true);
    }
  });

  it("retains the original rejected token as dropped-amount evidence", () => {
    const book = parseStatementCsv("Account;2024;2025\nCash;1,23;0", "Balance Sheet.csv");
    expect(book.droppedAmounts).toContainEqual({ raw: "1,23", page: null });
  });

  it("preserves printed zero dashes", () => {
    const book = parseStatementCsv("Account;2024;2025\nCash;—;10", "Balance Sheet.csv");
    expect(book.sheets[0]?.lines[0]?.values.map((value) => value.amount)).toEqual(["0", "10"]);
  });

  it.each(localizedCorpus().filter((fixture) => fixture.fileName.endsWith(".csv")))(
    "preserves round 3C CSV values: $id",
    async (fixture) => {
      const parsed = await selectDocumentParser(fixture.fileName, fixture.bytes).parse(fixture);
      const factor =
        fixture.scale === "lakhs" ? "100000" : fixture.scale === "thousands" ? "1000" : "1";
      expect(
        parsed.cells.map((cell) => [
          cell.label,
          new AnalyticalDecimal(cell.amount).mul(factor).toFixed(),
          cell.periodEnd,
        ]),
      ).toEqual(fixture.labels.map((label, index) => [label, fixture.scaled[index], "2025-03-31"]));
      expect(parsed.issues).toEqual([]);
    },
  );

  it.each(
    [...bankRound3aCorpus(), ...bankValueCorpus()].filter((fixture) =>
      fixture.fileName.endsWith(".csv"),
    ),
  )("preserves bank CSV values and review decisions: $id", async (fixture) => {
    const parsed = await selectDocumentParser(fixture.fileName, fixture.bytes).parse(fixture);
    expect(
      parsed.cells.map((cell) => [
        cell.label,
        new AnalyticalDecimal(cell.amount).toFixed(),
        cell.txnDate,
      ]),
    ).toEqual(fixture.facts);
    if (fixture.issue) expect(parsed.issues.map((issue) => issue.code)).toContain(fixture.issue);
    else expect(parsed.issues).toEqual([]);
    expect(
      parsed.cells.every(
        (cell) => cell.currency === fixture.currency && cell.statementType === "bank",
      ),
    ).toBe(true);
  });

  it.each([
    ["-20.00", "-20.00"],
    ["20.00-", "-20.00"],
    ["1999", "1999"],
    ["2050", "2050"],
    ["2025.00", "2025.00"],
    ["(300.00)", "-300.00"],
    ["1,234.50 CR", "1234.50"],
    ["1,234.50 DR", "-1234.50"],
    ["12,34,567.89", "1234567.89"],
    ["₹1,00,000", "100000"],
    ["USD 20.00", "20.00"],
    ["9007199254740993.01", "9007199254740993.01"],
    ["99.999999", "99.999999"],
  ])("retains main's exact CSV amount %s", (input, expected) => {
    const book = parseStatementCsv(`Account;2024;2025\nCash;${input};0`, "Balance Sheet.csv");
    expect(book.sheets[0]?.lines[0]?.values[0]?.amount).toBe(expected);
    expect(book.sheets[0]?.periods.map((period) => period.label)).toEqual(["2024", "2025"]);
  });

  it("keeps repeated year columns displayable but unresolved for ingestion", () => {
    const book = parseStatementCsv("Account;2025;2025\nCash;10;20", "Balance Sheet.csv");
    expect(book.sheets[0]?.lines[0]?.values.map((v) => v.amount)).toEqual(["10", "20"]);
    expect(book.layoutUnresolved).toBe(true);
  });

  it("keeps unlabelled amounts displayable without inventing ingestion periods", () => {
    const book = parseStatementCsv("Cash;1999;2050\nAssets;25000;40000", "Balance Sheet.csv");
    expect(book.sheets[0]?.lines.map((l) => l.values.map((v) => v.amount))).toEqual([
      ["1999", "2050"],
      ["25000", "40000"],
    ]);
    expect(book.layoutUnresolved).toBe(true);
  });

  it.each(["1,23", "1.234", "1,234", "-20 CR", "(20)-", "12,3456.00"])(
    "retains main's skipped-amount review for %s",
    (amount) => {
      const book = parseStatementCsv(`Account;2024;2025\nCash;${amount};0`, "Balance Sheet.csv");
      expect(book.sheets[0]?.skippedCells).toBe(1);
      expect(book.sheets[0]?.lines[0]?.values.map((v) => v.amount)).toEqual(["0"]);
    },
  );

  it("preserves exact localized amounts using the statement's number convention", () => {
    const book = parseStatementCsv(
      '"Bilan"\n"en euros EUR"\n"";"Références";"Year ended 31 March 2025"\n"Disponibilités";"71";"12 345,6"\n"Créances clients";"72";"234,5-"',
      "localized.csv",
    );
    expect(book.sheets[0]?.lines.map((l) => l.values.map((v) => v.amount))).toEqual([
      ["12345.6"],
      ["-234.5"],
    ]);
    expect(book.layoutUnresolved).toBe(false);
  });

  it.each(statementPeriodCorpus().filter((fixture) => fixture.fileName.endsWith(".csv")))(
    "preserves round 3B CSV periods and amounts: $id",
    async (fixture) => {
      const parsed = await selectDocumentParser(fixture.fileName, fixture.bytes).parse(fixture);
      const expected = fixture.ends.flatMap((end, col) =>
        end
          ? [
              ["Revenue", `${1200 + col * 100}.25`, end],
              ["Rent expense", `${200 + col * 10}.5`, end],
            ]
          : [],
      );
      expect(
        parsed.cells.map((c) => [c.label, c.amount.replace(/\.50$/, ".5"), c.periodEnd]).sort(),
      ).toEqual(expected.sort());
      expect(parsed.issues.map((issue) => issue.code)).toEqual(
        fixture.ends.includes(null) ? expect.arrayContaining(["confirm_period_end"]) : [],
      );
    },
  );
});
