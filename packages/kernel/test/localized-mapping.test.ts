import { describe, expect, it } from "vitest";
import { mapLineLabel, mappingIsAutoAcceptable, statementRole } from "../src/ingestion-mapping.js";

const goldens: [string, string][] = [
  ["Chiffre d’affaires", "revenue"],
  ["Coût des ventes", "cogs"],
  ["Charges de personnel", "operating_expenses"],
  ["Dotations aux amortissements", "depreciation"],
  ["Autres charges d’exploitation", "operating_expenses"],
  ["Charges financières", "interest_expense"],
  ["Impôt sur les bénéfices", "tax_expense"],
  ["Résultat net", "net_income"],
  ["Disponibilités", "cash"],
  ["Créances clients", "accounts_receivable"],
  ["Stocks", "inventory"],
  ["Immobilisations corporelles", "fixed_assets"],
  ["Dettes fournisseurs", "accounts_payable"],
  ["Emprunts à long terme", "long_term_debt"],
  ["Capital social", "common_stock"],
  ["Réserves", "retained_earnings"],
  ["Umsatzerlöse", "revenue"],
  ["Herstellungskosten", "cogs"],
  ["Personalaufwand", "operating_expenses"],
  ["Abschreibungen", "depreciation"],
  ["Sonstige betriebliche Aufwendungen", "operating_expenses"],
  ["Zinsaufwendungen", "interest_expense"],
  ["Steuern vom Einkommen und vom Ertrag", "tax_expense"],
  ["Jahresüberschuss", "net_income"],
  ["Kassenbestand", "cash"],
  ["Forderungen aus Lieferungen und Leistungen", "accounts_receivable"],
  ["Vorräte", "inventory"],
  ["Sachanlagen", "fixed_assets"],
  ["Verbindlichkeiten aus Lieferungen und Leistungen", "accounts_payable"],
  ["Langfristige Darlehen", "long_term_debt"],
  ["Gezeichnetes Kapital", "common_stock"],
  ["Gewinnrücklagen", "retained_earnings"],
  ["Importe neto de la cifra de negocios", "revenue"],
  ["Coste de ventas", "cogs"],
  ["Gastos de personal", "operating_expenses"],
  ["Amortización del inmovilizado", "depreciation"],
  ["Otros gastos de explotación", "operating_expenses"],
  ["Gastos financieros", "interest_expense"],
  ["Impuesto sobre beneficios", "tax_expense"],
  ["Resultado del ejercicio", "net_income"],
  ["Efectivo y otros activos líquidos equivalentes", "cash"],
  ["Clientes", "accounts_receivable"],
  ["Existencias", "inventory"],
  ["Inmovilizado material", "fixed_assets"],
  ["Proveedores", "accounts_payable"],
  ["Deudas a largo plazo", "long_term_debt"],
  ["Reservas", "retained_earnings"],
  ["売上高", "revenue"],
  ["売上原価", "cogs"],
  ["人件費", "operating_expenses"],
  ["減価償却費", "depreciation"],
  ["その他の営業費用", "operating_expenses"],
  ["支払利息", "interest_expense"],
  ["法人税等", "tax_expense"],
  ["当期純利益", "net_income"],
  ["現金及び預金", "cash"],
  ["売掛金", "accounts_receivable"],
  ["棚卸資産", "inventory"],
  ["有形固定資産", "fixed_assets"],
  ["買掛金", "accounts_payable"],
  ["長期借入金", "long_term_debt"],
  ["短期借入金", "short_term_debt"],
  ["資本金", "common_stock"],
  ["利益剰余金", "retained_earnings"],
];
describe("localized exact financial synonyms", () => {
  it.each(goldens)("maps only the complete label %s", (label, code) => {
    expect(mapLineLabel(label)?.accountCode).toBe(code);
    expect(mappingIsAutoAcceptable(mapLineLabel(label)!.confidence)).toBe(true);
    expect(mappingIsAutoAcceptable(mapLineLabel(`Unbekannt ${label}`)?.confidence ?? "0")).toBe(
      false,
    );
  });
  it.each(["1. ", "IV. ", "a) "])("removes only a structural prefix %s", (prefix) => {
    expect(mapLineLabel(`${prefix}Résultat net`)?.accountCode).toBe("net_income");
    expect(statementRole(`${prefix}Résultat net`)).toBe("total");
  });
});
