import {
  canonicalAccount,
  mapLineLabel,
  mappingIsAutoAcceptable,
  statementAmountsEqual,
} from "@nexora/kernel";
import { excelNumberToDecimal, numberConvention, parseMoneyToken } from "./decimal-text.js";
import { explicitYearEnd, parseLooseDate } from "./period.js";
import { annotationHeader, localizedStatementType } from "./statement-locales.js";
import type { SheetCell, Worksheet } from "./xlsx.js";
import type { StatementLine, StatementSheet, StatementType } from "./statement-xlsx.js";

type Result = readonly StatementSheet[] | { reason: string } | null;
const refused = (): { reason: string } => ({ reason: "layout_unresolved" });
const normalized = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
export function blockTitle(text: string): StatementType | null {
  if (/\b(?:income statement|profit and loss|profit & loss|p&l)\b/i.test(text))
    return "income_statement";
  if (/\bbalance sheet\b/i.test(text)) return "balance_sheet";
  return localizedStatementType(text);
}
export function amountColumnRole(text: string): "gross" | "amort" | "net" | null {
  const s = normalized(text);
  if (/\b(?:gross|cost|brut|bruto|anschaffungskosten)\b/.test(s)) return "gross";
  if (/\b(?:accumulated(?: depreciation)?|depreciation|amort\w*|prov\.?|abschreibungen)\b/.test(s))
    return "amort";
  if (/\b(?:net|neto|nbv|buchwert)\b/.test(s)) return "net";
  return null;
}
const labelHeader = (s: string) =>
  /^(?:particulars|account(?: name)?|description|liabilities|assets|expenses|income|actif|passif)$/i.test(
    s.trim(),
  );
const transfer = (s: string) =>
  /^(?:(?:net|gross) (?:profit|loss)(?:\s+(?:c\/o|b\/f|carried forward|brought forward))?|excess of income over expenditure)$/i.test(
    s.replace(/^(?:to|by)\s+/i, "").trim(),
  );
const total = (s: string) => /^(?:total\b|subtotal\b|sous.total\b)/i.test(s.trim());

/** Partition only on explicit title anchors. An unlabelled competing block is refused. */
export function parseStatementBlocks(
  sheet: Worksheet,
  parseSingle: (sheet: Worksheet, title: string) => StatementSheet | { reason: string },
): Result {
  const titles = sheet.cells.filter((c) => blockTitle(c.text) !== null && !labelHeader(c.text));
  const separated = titles.some((title, i) =>
    titles
      .slice(i + 1)
      .some(
        (next) =>
          next.row === title.row ||
          sheet.cells.some(
            (c) =>
              c.row > title.row &&
              c.row < next.row &&
              c.col > title.col &&
              parseMoneyToken(c.text) !== null,
          ),
      ),
  );
  if (titles.length > 1 && separated) {
    const outputs: StatementSheet[] = [];
    const firstTitleRow = Math.min(...titles.map((t) => t.row));
    const sharedText = sheet.cells
      .filter((c) => c.row < firstTitleRow)
      .map((c) => c.text)
      .join("\n");
    for (const title of titles) {
      const nextCol = Math.min(
        ...titles.filter((c) => c.row === title.row && c.col > title.col).map((c) => c.col),
        Infinity,
      );
      const nextRow = Math.min(
        ...titles
          .filter((c) => c.row > title.row && c.col >= title.col && c.col < nextCol)
          .map((c) => c.row),
        Infinity,
      );
      const cells = sheet.cells.filter(
        (c) => c.row >= title.row && c.row < nextRow && c.col >= title.col && c.col < nextCol,
      );
      if (!cells.length) return refused();
      // Keep source row/column coordinates; only shift the label column for the legacy reader.
      const local = { ...sheet, cells: cells.map((c) => ({ ...c, col: c.col - title.col + 1 })) };
      const special = parseSemanticBlock(local, title.text);
      if (special && "reason" in special) return special;
      const result = special ?? parseSingle(local, title.text);
      if ("reason" in result) return refused();
      outputs.push({
        ...result,
        explicitType: true,
        sourceText: [sharedText, ...cells.map((c) => c.text)].join("\n"),
        statementType: blockTitle(title.text)!,
        periodContext: result.periodContext ?? title.text,
        periods: result.periods.map((p) => ({ ...p, col: p.col + title.col - 1 })),
        lines: result.lines.map((l) => ({
          ...l,
          values: l.values.map((v) => ({
            ...v,
            col: (v.col ?? result.periods.find((p) => p.label === v.period)!.col) + title.col - 1,
          })),
        })),
      });
    }
    return outputs;
  }
  const semantic = parseSemanticBlock(sheet, titles[0]?.text ?? "");
  if (!semantic) {
    const headers = sheet.cells.filter((c) => labelHeader(c.text));
    if (
      headers.some((header) =>
        headers.some(
          (next) =>
            next.row > header.row &&
            sheet.cells.some(
              (c) =>
                c.row > header.row &&
                c.row < next.row &&
                c.col > header.col &&
                parseMoneyToken(c.text) !== null,
            ) &&
            sheet.cells.some(
              (c) => c.row === next.row && c.col > next.col && parseLooseDate(c.text),
            ),
        ),
      )
    )
      return refused();
  }
  return semantic && !("reason" in semantic) ? [semantic] : semantic;
}

function parseSemanticBlock(
  sheet: Worksheet,
  title: string,
): StatementSheet | { reason: string } | null {
  const rows = [...new Set(sheet.cells.map((c) => c.row))]
    .sort((a, b) => a - b)
    .map((r) => sheet.cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col));
  const header =
    rows.find(
      (r) => r.some((c) => amountColumnRole(c.text)) && r.some((c) => labelHeader(c.text)),
    ) ?? rows.find((r) => r.filter((c) => labelHeader(c.text)).length >= 2);
  if (!header) return null;
  const type = blockTitle(title);
  if (!type) return refused();
  const context = rows
    .filter((r) => r[0]!.row <= header[0]!.row)
    .flat()
    .map((c) => c.text)
    .join("\n");
  const convention = numberConvention(
    sheet.cells.filter((c) => c.row > header[0]!.row).map((c) => c.text),
    context,
  );
  if (convention === "conflict") return refused();
  const read = (c: SheetCell | undefined): string | null =>
    !c
      ? null
      : /^[-–—]$/.test(c.text.trim())
        ? "0"
        : c.kind === "number"
          ? excelNumberToDecimal(c.text)
          : parseMoneyToken(c.text, convention);
  const body = rows.filter((r) => r[0]!.row > header[0]!.row);
  const labels = header.filter((c) => labelHeader(c.text));
  const base = {
    sheetName: sheet.name,
    explicitType: true,
    sourceText: sheet.cells.map((c) => c.text).join("\n"),
    statementType: type,
    periodContext: context,
    skippedRows: 0,
    skippedCells: 0,
    droppedAmounts: [],
  };
  if (labels.length >= 2) {
    if (labels.length !== 2) return refused();
    const end = explicitYearEnd(context);
    if (!end) return refused();
    const period = `${end.year}-${String(end.month).padStart(2, "0")}-${String(end.day).padStart(2, "0")}`;
    const sides: StatementLine[][] = [];
    const sums: string[][] = [];
    const totals: string[] = [];
    for (const [i, label] of labels.entries()) {
      const limit = labels[i + 1]?.col ?? Infinity;
      const cols = header
        .filter(
          (c) =>
            c.col > label.col && c.col < limit && /^(?:amount|rs\.?|inr|₹)$/i.test(c.text.trim()),
        )
        .map((c) => c.col);
      if (cols.length < 1 || cols.length > 2) return refused();
      if (
        body.some((r) =>
          r.some(
            (c) => c.col > label.col && c.col < limit && read(c) !== null && !cols.includes(c.col),
          ),
        )
      )
        return refused();
      const lines: StatementLine[] = [];
      const sideAmounts: string[] = [];
      let pending: { amount: string; line: number; details: string[] } | null = null;
      const closeGroup = () => {
        if (!pending) return true;
        if (pending.details.length) {
          if (!statementAmountsEqual([pending.amount], pending.details)) return false;
          lines[pending.line] = { ...lines[pending.line]!, kind: "total" };
        }
        pending = null;
        return true;
      };
      for (const row of body) {
        const name = row.find((c) => c.col === label.col)?.text.trim() ?? "";
        if (row.some((c) => cols.includes(c.col) && c.text.trim() && read(c) === null))
          return refused();
        const amounts = cols
          .map((col) => ({
            col,
            amount: read(row.find((c) => c.col === col)),
            raw: row.find((c) => c.col === col)?.text ?? "",
          }))
          .filter((a) => a.amount !== null);
        if (!amounts.length) continue;
        if (!name || amounts.length > 1) return refused();
        const a = amounts[0]!;
        const outer = cols.length === 1 || a.col === cols[1];
        if (outer && !closeGroup()) return refused();
        if (total(name)) {
          if (totals[i] !== undefined) return refused();
          totals[i] = a.amount!;
          continue;
        }
        if (transfer(name)) {
          sideAmounts.push(a.amount!);
          continue;
        }
        const mapping = mapLineLabel(name.replace(/^(?:to|by)\s+/i, ""));
        const account =
          mapping && mappingIsAutoAcceptable(mapping.confidence)
            ? canonicalAccount(mapping.accountCode)
            : null;
        if (
          account &&
          (type === "income_statement"
            ? account.report !== (i === 0 ? "expense" : "revenue")
            : i === 0
              ? !["liability", "equity"].includes(account.report)
              : account.report !== "asset")
        )
          return refused();
        if (!outer && pending) pending.details.push(a.amount!);
        if (outer) pending = { amount: a.amount!, line: lines.length, details: [] };
        lines.push({
          sheetRow: row[0]!.row,
          label: name.replace(/^(?:to|by)\s+/i, ""),
          kind: "line",
          values: [{ period, amount: a.amount!, raw: a.raw, formula: false, col: a.col }],
        });
      }
      if (!closeGroup()) return refused();
      sideAmounts.push(
        ...lines.filter((l) => l.kind === "line").flatMap((l) => l.values.map((v) => v.amount)),
      );
      if (totals[i] === undefined || !statementAmountsEqual(sideAmounts, [totals[i]!]))
        return refused();
      sums.push(sideAmounts);
      sides.push(lines);
    }
    if (!statementAmountsEqual(sums[0]!, sums[1]!)) return refused();
    return {
      ...base,
      periods: [{ col: labels[0]!.col + 1, label: period, derived: false }],
      lines: sides.flat(),
    };
  }
  const gross = header.filter((c) => amountColumnRole(c.text) === "gross");
  const amort = header.filter((c) => amountColumnRole(c.text) === "amort");
  const explicitNets = header.filter((c) => amountColumnRole(c.text) === "net");
  const nets = explicitNets.length
    ? explicitNets
    : gross.length && amort.length
      ? header
          .filter(
            (c) =>
              c.col > labels[0]!.col &&
              !amountColumnRole(c.text) &&
              !annotationHeader(c.text) &&
              (parseLooseDate(c.text) || /year ended/i.test(c.text)),
          )
          .map((c) => ({
            ...c,
            text: `Net ${parseLooseDate(c.text) ? c.text : (sheet.cells.find((below) => below.row === c.row + 1 && below.col === c.col)?.text ?? "")}`,
          }))
      : [];
  if (
    !nets.length ||
    gross.length > 1 ||
    amort.length > 1 ||
    (gross.length > 0 && amort.length !== 1) ||
    (amort.length > 0 && gross.length !== 1)
  )
    return refused();
  const end = explicitYearEnd(
    type === "balance_sheet" ? context.replace(/\bau\s+(?=\d)/gi, "as at ") : context,
  );
  const periods = nets.map((c) => {
    let label = c.text.replace(/^(?:neto|net(?: book value)?|nbv|buchwert)\b\s*/i, "").trim();
    if (/^(?:n(?:\s*-\s*1)?|current|prior)?$/i.test(label) && end) {
      const prior = /(?:-\s*1|prior)/i.test(label);
      label = `${end.year - (prior ? 1 : 0)}-${String(end.month).padStart(2, "0")}-${String(end.day).padStart(2, "0")}`;
    }
    return { col: c.col, label, derived: false };
  });
  if (
    periods.some((p) => !parseLooseDate(p.label)) ||
    new Set(periods.map((p) => p.label)).size !== periods.length
  )
    return refused();
  const allowed = new Set(
    [...nets, ...gross, ...amort, ...header.filter((c) => annotationHeader(c.text))].map(
      (c) => c.col,
    ),
  );
  const lines: StatementLine[] = [];
  for (const row of body) {
    const name = row.find((c) => c.col === labels[0]?.col)?.text.trim() ?? "";
    // A second date-header row is metadata, not a financial line.
    if (!name && row.filter((c) => c.text.trim()).every((c) => parseLooseDate(c.text) !== null))
      continue;
    if (
      row.some(
        (c) =>
          allowed.has(c.col) &&
          !annotationHeader(header.find((h) => h.col === c.col)?.text ?? "") &&
          c.text.trim() &&
          read(c) === null,
      )
    )
      return refused();
    if (row.some((c) => c.col > labels[0]!.col && read(c) !== null && !allowed.has(c.col)))
      return refused();
    const values = periods.flatMap((p) => {
      const c = row.find((c) => c.col === p.col);
      const amount = read(c);
      return amount === null
        ? []
        : [{ period: p.label, amount, raw: c!.text, formula: c!.formula, col: p.col }];
    });
    if (!values.length) {
      if (row.some((c) => [...gross, ...amort].some((h) => h.col === c.col) && read(c) !== null))
        return refused();
      continue;
    }
    if (!name) return refused();
    if (gross.length) {
      const g = read(row.find((c) => c.col === gross[0]!.col));
      const amortCell = row.find((c) => c.col === amort[0]!.col);
      const a = amortCell?.text.trim() ? read(amortCell) : "0";
      const net = values.find((v) => v.col === nets[0]!.col);
      if (g === null || a === null || !net || !statementAmountsEqual([g], [a, net.amount]))
        return refused();
    }
    lines.push({
      sheetRow: row[0]!.row,
      label: name,
      kind: total(name) ? "total" : "line",
      values,
    });
  }
  const annualPeriods = periods.map((p) => ({ ...p, label: `as at ${p.label}` }));
  return {
    ...base,
    periods: annualPeriods,
    lines: lines.map((l) => ({
      ...l,
      values: l.values.map((v) => ({ ...v, period: `as at ${v.period}` })),
    })),
  };
}
