import { describe, expect, it } from "vitest";
import { AnalyticalDecimal } from "@nexora/kernel";
import { selectDocumentParser } from "../src/imports/document-parser.js";
import { encodeGrid } from "./fixtures/adversarial-corpus.js";

async function parse(rows: string[][], format: "xlsx" | "csv" | "pdf" = "xlsx") {
  const bytes = encodeGrid(rows, format, "Report");
  const fileName = `round4d.${format}`;
  return selectDocumentParser(fileName, bytes).parse({ fileName, bytes });
}

describe("round 4D synthetic parser goldens", () => {
  it.each([
    {
      title: "Conto economico EUR",
      date: "31 dicembre 2024",
      header: "Esercizio",
      scale: "importi in migliaia di euro",
      expectedScale: "thousands",
      format: "xlsx",
    },
    {
      title: "Conto economico EUR",
      date: "31 dicembre 2024",
      header: "Esercizio",
      scale: "valori in euro",
      expectedScale: "units",
      format: "pdf",
    },
    {
      title: "Winst-en-verliesrekening EUR",
      date: "31 december 2024",
      header: "Boekjaar",
      scale: "x € 1.000",
      expectedScale: "thousands",
      format: "xlsx",
    },
    {
      title: "Jaarrekening EUR",
      date: "31 december 2024",
      header: "",
      scale: "bedragen in euro",
      expectedScale: "units",
      format: "csv",
    },
    {
      title: "Demonstração do Resultado do Exercício BRL",
      date: "31 de dezembro de 2024",
      header: "Exercício",
      scale: "em milhares de reais",
      expectedScale: "thousands",
      format: "xlsx",
    },
    {
      title: "DRE BRL",
      date: "31 de dezembro de 2024",
      header: "",
      scale: "R$ mil",
      expectedScale: "thousands",
      format: "csv",
    },
  ] as const)("binds printed dates and exact values: $title / $scale / $format", async (f) => {
    const result = await parse(
      [
        [f.title],
        [f.date],
        [f.scale],
        ["Account", `${f.header} 2024`.trim(), `${f.header} 2023`.trim()],
        ["Synthetic income", "1234.50", "987.25"],
      ],
      f.format,
    );
    expect(result.issues).toEqual([]);
    expect(
      result.cells.map((c) => [
        new AnalyticalDecimal(c.amount).toFixed(),
        c.periodEnd,
        c.scale,
        c.statementType,
      ]),
    ).toEqual([
      ["1234.5", "2024-12-31", f.expectedScale, "income_statement"],
      ["987.25", "2023-12-31", f.expectedScale, "income_statement"],
    ]);
  });

  it.each([
    {
      title: "Cuenta de pérdidas y ganancias EUR",
      range: "Del 1 de enero al 31 de diciembre de 2024",
      printed: "Date printed: 15 January 2025",
      header: "Importe",
      end: "2024-12-31",
      start: "2024-01-01",
    },
    {
      title: "Cuenta de pérdidas y ganancias EUR",
      range: "Del 1 de enero al 31 de diciembre de 2024",
      printed: "Printed on 15 January 2025",
      header: "Monto",
      end: "2024-12-31",
      start: "2024-01-01",
    },
    {
      title: "損益計算書 JPY",
      range: "自 2024年4月1日 至 2025年3月31日",
      printed: "印刷日: 2025年4月15日",
      header: "金額",
      end: "2025-03-31",
      start: "2024-04-01",
    },
    {
      title: "Income statement USD",
      range: "1 April 2024 to 31 March 2025",
      printed: "Date printed: 15 April 2025",
      header: "Amount",
      end: "2025-03-31",
      start: "2024-04-01",
    },
    {
      title: "Income statement USD",
      range: "for the year ended 31 March 2025",
      printed: "Printed on 15 April 2025",
      header: "Total",
      end: "2025-03-31",
      start: "2024-04-01",
    },
  ])("binds lone $header to the title despite metadata", async (f) => {
    const result = await parse([
      [f.title],
      [f.range],
      [f.printed],
      ["Account", f.header],
      ["Synthetic income", "1234.25"],
    ]);
    expect(result.issues).toEqual([]);
    expect(
      result.cells.map((c) => [
        new AnalyticalDecimal(c.amount).toFixed(),
        c.periodStart,
        c.periodEnd,
      ]),
    ).toEqual([["1234.25", f.start, f.end]]);
  });

  it("binds a PDF amount header despite a separate print date", async () => {
    const result = await parse(
      [
        ["Income statement USD"],
        ["1 April 2024 to 31 March 2025"],
        ["Printed on 15 April 2025"],
        ["Account", "Amount"],
        ["Revenue", "1234.25"],
      ],
      "pdf",
    );
    expect(result.issues).toEqual([]);
    expect(result.cells.map((c) => [c.amount, c.periodEnd])).toEqual([["1234.25", "2025-03-31"]]);
  });

  it.each(["Esercizio 2024", "Importe", "金額"])(
    "holds an undated title with %s",
    async (header) => {
      const result = await parse([
        ["Conto economico EUR valori in euro"],
        ["Date printed: 15 January 2025"],
        ["Account", header],
        ["Synthetic income", "1234.25"],
      ]);
      expect(result.cells).toEqual([]);
      expect(result.issues.map((i) => i.code)).toContain("confirm_period_end");
    },
  );

  it.each([false, true])(
    "only emits explicitly printed bank closing balances: %s",
    async (explicit) => {
      const rows = [
        ["Bank statement USD"],
        ["Period 2024-01-01 to 2024-01-31"],
        ["Opening balance", "1000.00"],
        ["Date", "Description", "Debit", "Credit", "Balance"],
        ["2024-01-05", "Synthetic deposit", "", "250.25", "1250.25"],
        ["2024-01-10", "Synthetic payment", "50.50", "", "1199.75"],
      ];
      if (explicit) rows.push(["Closing balance", "1199.75"]);
      const result = await parse(rows, "csv");
      expect(
        result.cells
          .filter((c) => c.balanceKind === "closing")
          .map((c) => new AnalyticalDecimal(c.amount).toFixed()),
      ).toEqual(explicit ? ["1199.75"] : []);
      expect(
        result.cells
          .filter((c) => c.balanceKind === "movement")
          .map((c) => new AnalyticalDecimal(c.amount).toFixed()),
      ).toEqual(["250.25", "-50.5"]);
      expect(result.issues).toEqual([]);
    },
  );
});
