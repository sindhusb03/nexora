import { describe, expect, it } from "vitest";
import { parseAmount, splitCsv } from "./csv";
import { parseSourceTable } from "./data-source";

describe("CSV source amounts (decimal-text-v1)", () => {
  it("reads quotes, escaped quotes, embedded newlines, CRLF and BOM", () => {
    expect(splitCsv('\uFEFFAccount,Amount\r\n"A, ""B""\nC","1,234.56"\r\n')).toEqual([
      ["Account", "Amount"],
      ['A, "B"\nC', "1,234.56"],
    ]);
  });
  it("detects semicolon and tab only outside header quotes", () => {
    expect(splitCsv('"Account,,,";Amount\nCash;1,23')).toEqual([
      ["Account,,,", "Amount"],
      ["Cash", "1,23"],
    ]);
    expect(splitCsv("Account\tAmount\nCash\t20")).toEqual([
      ["Account", "Amount"],
      ["Cash", "20"],
    ]);
  });
  it.each([
    ["-20.00", "-2000", 2],
    ["20.00-", "-2000", 2],
    ["(1,234.50)", "-123450", 2],
    ["1,234.50 CR", "123450", 2],
    ["1,234.50 DR", "-123450", 2],
    ["12,34,567.89", "123456789", 2],
    ["1999", "1999", 0],
    ["2050", "2050", 0],
    ["2025.00", "202500", 2],
    ["₹1,00,000", "100000", 0],
    ["USD 20.00", "2000", 2],
    ["$20.00", "2000", 2],
    ["9007199254740993.01", "900719925474099301", 2],
  ])("parses %s exactly", (text, minor, scale) => {
    expect(parseAmount(String(text), { decimal: "auto" })).toEqual({ ok: true, minor, scale });
  });
  it.each(["1,23", "1.234", "1,234", "12,3456.00", "-20 CR", "(20)-", "1e3", "", "20oops"])(
    "flags %s for review",
    (text) => {
      expect(parseAmount(text, { decimal: "auto" }).ok).toBe(false);
    },
  );
  it("uses an explicit decimal convention", () => {
    expect(parseAmount("1.234,56", { decimal: "," })).toEqual({
      ok: true,
      minor: "123456",
      scale: 2,
    });
    expect(parseAmount("1.234", { decimal: "." })).toEqual({ ok: true, minor: "1234", scale: 3 });
  });
  it("keeps invalid source rows visible for review", () => {
    expect(parseSourceTable('Account,Amount\nCash,"1,23"\nSales,"1,234.56"')).toEqual([
      { rowNo: 1, account: "Cash", amount: "1,23" },
      { rowNo: 2, account: "Sales", amount: "1,234.56" },
    ]);
    const extra = parseSourceTable("Account,Amount\nCash,1,23")[0];
    expect(extra?.amount).toBe("1 | 23");
    expect(parseAmount(extra?.amount ?? "", { decimal: "auto" }).ok).toBe(false);
  });
});
