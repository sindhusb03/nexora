import { AnalyticalDecimal } from "@nexora/kernel";

import { findMoneyTokens, parseMoneyToken, numberConvention } from "./decimal-text.js";
import { bankDates } from "./bank-dates.js";
import { currencyEvidence } from "./currency.js";
import type { PdfLine } from "./bank-pdf.js";
import { parseGrid } from "./statement-csv.js";
import { bankLabel, bankDateToken } from "./bank-labels.js";

export interface TabularBankTransaction {
  readonly date: string;
  readonly description: string;
  readonly amount: string;
  readonly raw: string;
  readonly page: number | null;
  readonly row: number | null;
  readonly bbox: { x0: number; y0: number; x1: number; y1: number } | null;
}

export interface BankIssue {
  readonly code:
    | "ambiguous_date"
    | "dropped_amount"
    | "zero_extraction"
    | "layout_unresolved"
    | "confirm_period_end"
    | "balance_mismatch";
  readonly message: string;
  readonly raw: string;
  readonly page: number | null;
}

export interface TabularBank {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: string | null;
  readonly opening: string | null;
  readonly closing: string | null;
  readonly openingRaw: string;
  readonly closingRaw: string;
  readonly openingPage: number | null;
  readonly closingPage: number | null;
  readonly openingBBox: TabularBankTransaction["bbox"];
  readonly closingBBox: TabularBankTransaction["bbox"];
  readonly transactions: readonly TabularBankTransaction[];
  readonly issues: readonly BankIssue[];
}

interface SourceLine {
  readonly page: number | null;
  readonly row: number | null;
  readonly text: string;
  readonly cells: readonly string[];
  readonly bbox: TabularBankTransaction["bbox"];
  readonly unaligned?: boolean;
}

export interface BankParse {
  readonly bank: TabularBank | null;
  readonly issues: readonly BankIssue[];
}

export function parseTabularBankText(lines: readonly string[]): TabularBank | null {
  return parseBankSource(lines.map((text, index) => sourceFromText(text, index + 1, null))).bank;
}

export function parseTabularBankPdf(lines: readonly PdfLine[]): TabularBank | null {
  return parseBankPdfLines(lines).bank;
}

export function parseBankPdfLines(lines: readonly PdfLine[]): BankParse {
  return parseBankSource(alignPdfBank(lines));
}

export function parseBankText(text: string): BankParse {
  return parseBankSource(
    parseGrid(text).map((cells, index) => ({
      page: null,
      row: index + 1,
      text: cells.join(" "),
      cells,
      bbox: null,
    })),
  );
}

export function recognizesBankGrid(text: string): boolean {
  if (!/[,;\t]/.test(text)) return false;
  const rows = parseGrid(text);
  return (
    rows.some(isHeader) ||
    rows.filter(
      (cells) =>
        cells.length >= 3 &&
        cells.some((cell) =>
          /^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})$/.test(cell.trim()),
        ) &&
        cells.some((cell) => parseMoneyToken(cell) !== null),
    ).length >= 2
  );
}

export function parseBankSource(lines: readonly SourceLine[]): BankParse {
  const text = lines.map((line) => line.text).join("\n");
  const matrix = parseMatrix(lines);
  if (matrix && (matrix.bank || matrix.issues.length > 0)) return matrix;
  const inferred = inferHeaderless(lines);
  if (inferred) return inferred;
  // Numeric column order alone cannot establish debit, credit, or balance.
  return parseNarrative(lines, text);
}

export function decimalAmount(value: string): string | null {
  return findMoneyTokens(value)[0]?.amount ?? null;
}

function isLegend(text: string): boolean {
  return /^(?:\*\s*denotes\b|(?:legend|key)\s*:|txn\s+types\s*:|dr\s*=\s*debit\b|cr\s*=\s*credit\b)/i.test(
    text.trim(),
  );
}

/** Headerless roles are accepted only when the complete table has one
 * reconciled interpretation. Balances are evidence, never fabricated values. */
function inferHeaderless(lines: readonly SourceLine[]): BankParse | null {
  const dateLike = (raw: string) =>
    /^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})$/.test(raw.trim());
  const first = lines.findIndex((l) => l.cells.some(dateLike));
  if (first < 0) return null;
  const unresolved = (): BankParse => ({
    bank: null,
    issues: [
      {
        code: "layout_unresolved",
        message:
          "Headerless bank roles or direction are not uniquely supported by complete reconciliation",
        raw: lines[first]!.text,
        page: lines[first]!.page,
      },
    ],
  });
  const body = lines.slice(first).filter((l) => !summaryKind(l) && !isLegend(l.text));
  if (
    lines
      .slice(0, first)
      .some((l) => !summaryKind(l) && l.cells.some((cell) => parseMoneyToken(cell) !== null))
  )
    return unresolved();
  const width = body[0]!.cells.length;
  if (width < 3 || body.some((l) => l.cells.length !== width)) return unresolved();
  const dateCols = Array.from({ length: width }, (_, i) => i).filter((i) =>
    body.every((l) => dateLike(l.cells[i]!)),
  );
  if (dateCols.length !== 1) return unresolved();
  const dateCol = dateCols[0]!;
  const convention = numberConvention(body.flatMap((l) => l.cells.filter((_, i) => i !== dateCol)));
  const numeric = Array.from({ length: width }, (_, i) => i).filter(
    (i) =>
      i !== dateCol &&
      body.every((l) => !l.cells[i]!.trim() || parseMoneyToken(l.cells[i]!, convention) !== null) &&
      body.some((l) => parseMoneyToken(l.cells[i]!, convention) !== null),
  );
  const signCols = Array.from({ length: width }, (_, i) => i).filter(
    (i) =>
      i !== dateCol &&
      !numeric.includes(i) &&
      body.every((l) => applyDrCr("1", l.cells[i]!) !== null),
  );
  const textCols = Array.from({ length: width }, (_, i) => i).filter(
    (i) => i !== dateCol && !numeric.includes(i) && !signCols.includes(i),
  );
  if (textCols.length !== 1 || numeric.length < 1 || numeric.length > 3) return unresolved();
  const candidates: BankParse[] = [];
  for (const balanceCol of [-1, ...numeric]) {
    const flows = numeric.filter((i) => i !== balanceCol);
    if (flows.length < 1 || flows.length > 2) continue;
    const openingLine = lines.slice(0, first).find((l) => summaryKind(l) === "opening");
    const opening = openingLine?.cells
      .map((c) => parseMoneyToken(c, convention))
      .find((a) => a !== null);
    if (
      flows.length === 1 &&
      balanceCol >= 0 &&
      opening == null &&
      !signCols.length &&
      !body.every((l) => /(?:^[-(]|(?:CR|DR)\s*$|-\s*$)/i.test(l.cells[flows[0]!]!))
    )
      continue;
    if (
      balanceCol < 0 &&
      (flows.length !== 1 ||
        (!signCols.length &&
          !body.every((l) => /(?:^[-(]|(?:CR|DR)\s*$|-\s*$)/i.test(l.cells[flows[0]!]!))))
    )
      continue;
    for (const reverse of flows.length === 2 ? [false, true] : [false]) {
      const header = Array.from({ length: width }, () => "Note");
      header[dateCol] = "Date";
      header[textCols[0]!] = "Description";
      if (balanceCol >= 0) header[balanceCol] = "Balance";
      for (const i of signCols) header[i] = "Dr Cr";
      if (flows.length === 1) header[flows[0]!] = "Amount";
      else {
        header[flows[reverse ? 1 : 0]!] = "Debit";
        header[flows[reverse ? 0 : 1]!] = "Credit";
      }
      let running = opening == null ? null : new AnalyticalDecimal(opening);
      let invalid = false;
      const adjusted = body.map((l) => {
        const cells = [...l.cells];
        if (balanceCol < 0) return l;
        const balance = parseMoneyToken(cells[balanceCol]!, convention);
        if (balance === null) {
          invalid = true;
          return l;
        }
        const delta = running === null ? null : new AnalyticalDecimal(balance).sub(running);
        running = new AnalyticalDecimal(balance);
        if (flows.length === 1) {
          const raw = cells[flows[0]!]!;
          const amount = parseMoneyToken(raw, convention);
          if (
            amount === null ||
            (delta !== null && !delta.abs().eq(new AnalyticalDecimal(amount).abs())) ||
            (delta !== null && /(?:^[-(]|DR\s*$|CR\s*$|-\s*$)/i.test(raw) && !delta.eq(amount))
          )
            invalid = true;
          // Direction comes from the reconciled balance delta. Keep original
          // raw text and provenance while giving the matrix an explicit cue.
          if (delta !== null && !signCols.length)
            cells[flows[0]!] =
              `${raw.replace(/\s*(?:CR|DR)$/i, "")} ${delta.isNegative() ? "Dr" : "Cr"}`;
        }
        return { ...l, cells };
      });
      if (invalid) continue;
      const replacements = new Map(body.map((l, i) => [l, adjusted[i]!]));
      const source = [
        ...lines.slice(0, first),
        { ...lines[first]!, text: header.join(" "), cells: header, row: 0 },
        ...lines.slice(first).map((l) => replacements.get(l) ?? l),
      ];
      const parsed = parseMatrix(source);
      if (
        parsed?.bank &&
        parsed.bank.transactions.length === body.length &&
        parsed.issues.every(
          (issue) =>
            issue.code === "balance_mismatch" &&
            issue.message.startsWith("Bank requires independently stated"),
        )
      )
        candidates.push(parsed);
    }
  }
  return candidates.length === 1 ? candidates[0]! : unresolved();
}

function sourceFromText(text: string, row: number, page: number | null): SourceLine {
  return { page, row, text: text.trim(), cells: splitCsv(text), bbox: null };
}

function alignPdfBank(lines: readonly PdfLine[]): SourceLine[] {
  const combined: PdfLine[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const next = lines[index + 1];
    if (
      next &&
      next.page === line.page &&
      Math.abs(next.y - line.y) <= 20 &&
      next.items.every(
        (item) =>
          !item.text.trim() || /^(?:date|amount|\(?dr\)?|\(?cr\)?)$/i.test(item.text.trim()),
      ) &&
      line.items.some((item) => /withdrawal|deposit|value/i.test(item.text))
    ) {
      const items = line.items.map((item) => {
        const tail = next.items.find((part) => Math.abs(part.x - item.x) <= 16 && part.text.trim());
        return tail ? { ...item, text: `${item.text} ${tail.text}` } : item;
      });
      if (isHeader(items.map((item) => item.text))) {
        combined.push({ ...line, items });
        index++;
        continue;
      }
    }
    combined.push(line);
  }
  lines = combined;
  // PDF text runs may split a single heading into "Withdrawal" and "(Dr)".
  lines = lines.map((line) => {
    const items: PdfLine["items"][number][] = [];
    for (const item of line.items) {
      if (!item.text.trim()) continue;
      const previous = items.at(-1);
      const gap = previous ? item.x - previous.x - (previous.width ?? 0) : Infinity;
      const role = columnRole(item.text);
      const priorRole = previous ? columnRole(previous.text) : "unknown";
      if (
        previous &&
        gap >= 0 &&
        gap <= 14 &&
        previous.width !== undefined &&
        ((role === priorRole && role !== "unknown" && role !== "note") ||
          (priorRole === "unknown" && role !== "unknown" && role !== "note") ||
          /^(?:date|\(?dr\)?|\(?cr\)?|out|in)$/i.test(item.text.trim())) &&
        !findMoneyTokens(previous.text).length &&
        !findMoneyTokens(item.text).length
      ) {
        items[items.length - 1] = {
          ...previous,
          text: `${previous.text} ${item.text}`,
          width: item.x + (item.width ?? 0) - previous.x,
        };
      } else items.push(item);
    }
    return { ...line, items };
  });
  const header = lines.find((line) =>
    isHeader(line.items.map((item) => item.text).filter((text) => text.trim().length > 0)),
  );
  if (!header) return lines.map((line, index) => sourceFromPdf(line, index + 1));
  const headerColumns = (line: PdfLine) =>
    line.items
      .filter((item) => item.text.trim().length > 0)
      .map((item) => ({ x: item.x, right: item.x + (item.width ?? 0), text: item.text.trim() }));
  let columns = headerColumns(header);
  return lines.map((line, index) => {
    if (isHeader(line.items.map((item) => item.text))) columns = headerColumns(line);
    const cells = columns.map(() => "");
    let unaligned = false;
    for (const item of line.items) {
      const text = item.text.trim();
      if (text.length === 0) continue;
      let best = -1;
      let distance = 48;
      columns.forEach((column, columnIndex) => {
        const gap = Math.min(
          Math.abs(column.x - item.x),
          Math.abs(column.right - item.x - (item.width ?? 0)),
        );
        if (gap < distance) {
          distance = gap;
          best = columnIndex;
        }
      });
      if (best >= 0) cells[best] = [cells[best], text].filter(Boolean).join(" ");
      else if (findMoneyTokens(text).length || /^\d{1,4}[/.-]\d{1,2}[/.-]/.test(text))
        unaligned = true;
    }
    return {
      page: line.page ?? null,
      row: index + 1,
      text: line.items
        .map((item) => item.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
      cells,
      bbox: amountBBox(line),
      unaligned,
    };
  });
}

function amountBBox(line: PdfLine): SourceLine["bbox"] {
  const amountItem = [...line.items]
    .reverse()
    .find((item) => findMoneyTokens(item.text).length > 0);
  const anchor = amountItem ?? line.items[0];
  if (!anchor || anchor.y === undefined) return null;
  return {
    x0: anchor.x,
    y0: anchor.y,
    x1: anchor.x + (anchor.width ?? 0),
    y1: anchor.y + (anchor.height ?? 0),
  };
}

function sourceFromPdf(line: PdfLine, row: number): SourceLine {
  const cells =
    line.items.length > 1 ? line.items.map((item) => item.text) : splitCsv(lineText(line));
  const amountItem = [...line.items]
    .reverse()
    .find((item) => findMoneyTokens(item.text).length > 0);
  const anchor = amountItem ?? line.items[0];
  const bbox =
    anchor && anchor.y !== undefined
      ? {
          x0: anchor.x,
          y0: anchor.y,
          x1: anchor.x + (anchor.width ?? 0),
          y1: anchor.y + (anchor.height ?? 0),
        }
      : null;
  return { page: line.page, row, text: lineText(line), cells, bbox };
}

function lineText(line: PdfLine): string {
  return line.items
    .map((item) => item.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMatrix(lines: readonly SourceLine[]): BankParse | null {
  const headerIndex = lines.findIndex((line) => isHeader(line.cells));
  if (headerIndex < 0) return null;
  const header = lines[headerIndex]!.cells;
  const issues: BankIssue[] = [];
  const issue = (code: BankIssue["code"], message: string, line?: SourceLine) => {
    issues.push({ code, message, raw: line?.text ?? header.join(" | "), page: line?.page ?? null });
  };
  const malformed = lines
    .slice(headerIndex + 1)
    .find(
      (line) =>
        (line.unaligned || line.cells.length !== header.length) &&
        !summaryKind(line) &&
        !isLegend(line.text),
    );
  if (malformed) {
    issue(
      "layout_unresolved",
      "Transaction width or PDF column alignment differs from the header",
      malformed,
    );
    return { bank: null, issues };
  }
  const metadata = lines
    .slice(0, headerIndex)
    .filter((l) => !summaryKind(l))
    .map((l) => l.text)
    .join("\n");
  const accountEvidence = currencyEvidence(
    metadata
      .split("\n")
      .filter((line) => !/^\s*(?:original|foreign)\s+currency\b/i.test(line))
      .join("\n"),
  );
  if (accountEvidence.conflict) {
    issue("layout_unresolved", "Account currency evidence conflicts");
    return { bank: null, issues };
  }
  let currency = accountEvidence.currency;
  const roles = header.map(columnRole);
  const blank = (s: string) => !s.trim() || /^[-\u2013\u2014]$/.test(s.trim());
  const sourceDateCol = ["posting_date", "value_date", "date"]
    .map((role) => roles.findIndex((r) => r === role))
    .find((index) => index >= 0)!;
  const hasDate = (line: SourceLine) =>
    /^(?:\d{1,4}[/.-]\d{1,2}[/.-]|\d{1,2}[-\s][a-z]{3,9}\b|[a-z]{3,9}\s+\d{1,2}\b)/i.test(
      bankDateToken(line.cells[sourceDateCol] ?? "", lines.map((l) => l.text).join("\n")),
    );
  const datedRows = lines.slice(headerIndex + 1).filter(hasDate);
  // Export headers such as Details and Type can both carry direction codes.
  // Resolve them from column evidence before choosing the description column.
  roles.forEach((role, i) => {
    if (!["narration", "unknown", "sign"].includes(role) || !datedRows.length) return;
    if (
      datedRows.filter((line) => applyDrCr("1", line.cells[i] ?? "") !== null).length >
      datedRows.length / 2
    )
      roles[i] = "sign";
  });
  const classify = (line: SourceLine) => {
    if (isLegend(line.text)) return "footer";
    // Some exports date their aggregate row. Two nonzero flow totals and no
    // running balance distinguish that row from a single transaction amount.
    if (
      summaryKind(line) === "total" &&
      ["debit", "credit"].every((role) => {
        const amount = parseMoneyToken(line.cells[roles.findIndex((r) => r === role)] ?? "");
        return amount !== null && !new AnalyticalDecimal(amount).isZero();
      }) &&
      !line.cells[roles.indexOf("balance")]?.trim()
    )
      return "total";
    // A dated flow is activity, even when a cell contains a summary-like word.
    const described = roles.some(
      (role, i) =>
        role === "narration" &&
        !!line.cells[i]?.trim() &&
        !SUMMARY_LABEL.test(bankLabel(line.cells[i]!).trim()),
    );
    if (
      (hasDate(line) || described) &&
      roles.some(
        (role, i) => ["amount", "debit", "credit"].includes(role) && !blank(line.cells[i] ?? ""),
      )
    )
      return null;
    return summaryKind(
      hasDate(line) ? { ...line, cells: line.cells.filter((_, i) => roles[i] !== "sign") } : line,
    );
  };
  const repeatedHeader = (line: SourceLine) =>
    isHeader(line.cells) &&
    !hasDate(line) &&
    !roles.some(
      (role, i) =>
        ["amount", "debit", "credit"].includes(role) &&
        parseMoneyToken(line.cells[i] ?? "") !== null,
    );
  const currencies = new Set<string>();
  if (currency) currencies.add(currency);
  const recordCurrency = (raw: string, line?: SourceLine) => {
    const evidence = currencyEvidence(raw);
    if (evidence.conflict) issue("layout_unresolved", "Conflicting currency evidence", line);
    if (evidence.currency) currencies.add(evidence.currency);
  };
  const currencyCol = roles.indexOf("currency");
  for (const line of lines.slice(headerIndex + 1)) {
    if (repeatedHeader(line)) {
      const normalize = (cells: readonly string[]) =>
        cells.map((c) => c.trim().toLowerCase().replace(/\s+/g, " ")).join("|");
      if (normalize(line.cells) !== normalize(header))
        issue("layout_unresolved", "Repeated bank header changes column meaning", line);
      continue;
    }
    const kind = classify(line);
    if (kind && kind !== "opening" && kind !== "closing") continue;
    const raw = line.cells[currencyCol]?.trim();
    if (raw) {
      if (!currencyEvidence(raw).currency)
        issue("layout_unresolved", "Unresolved row currency", line);
      recordCurrency(raw, line);
    }
  }
  // A denominated account balance or explicitly local amount is account evidence;
  // foreign/original amounts are not. Resolve this before pruning amount roles.
  header.forEach((h, i) => {
    if (
      !/\b(?:foreign|original)\b/i.test(h) &&
      (roles[i] === "balance" ||
        (roles[i] === "amount" && /\b(?:local|account|settlement|base)\b/i.test(h)))
    )
      recordCurrency(h);
  });
  if (!currencies.size) {
    header.forEach((h, i) => {
      if (["amount", "debit", "credit"].includes(roles[i]!) && !/\b(?:foreign|original)\b/i.test(h))
        recordCurrency(h);
    });
  }
  if (currencies.size > 1) issue("layout_unresolved", "Account and row currencies conflict");
  currency = [...currencies][0] ?? null;
  if (!currency && /\b(?:foreign|original)\b/i.test(metadata + header.join(" ")))
    issue("layout_unresolved", "Account currency is unresolved in a foreign-currency export");
  if (issues.length) return { bank: null, issues };
  // A labelled local/account amount outranks generic/original amounts. Explicit
  // foreign denominations are never added to account-currency flows.
  const localAmounts = header.flatMap((h, i) =>
    roles[i] === "amount" && /\b(?:local|account|settlement|base)\b/i.test(h) ? [i] : [],
  );
  const explicitAmounts = header.flatMap((h, i) =>
    roles[i] === "amount" && currency && currencyEvidence(h).currency === currency ? [i] : [],
  );
  const preferred = localAmounts.length ? localAmounts : explicitAmounts;
  header.forEach((h, i) => {
    if (!["amount", "debit", "credit", "balance", "currency"].includes(roles[i]!)) return;
    const denomination = currencyEvidence(h);
    if (denomination.conflict) issue("layout_unresolved", "Column denomination conflicts");
    if (
      /\b(?:foreign|original)\b/i.test(h) ||
      (currency && denomination.currency && denomination.currency !== currency) ||
      (roles[i] === "amount" && preferred.length && !preferred.includes(i))
    )
      roles[i] = "note";
  });
  if (!roles.some((r) => ["amount", "debit", "credit"].includes(r)))
    issue("layout_unresolved", "No account-currency transaction amount column");
  if (issues.length) return { bank: null, issues };
  if (
    [
      "amount",
      "debit",
      "credit",
      "balance",
      "fee",
      "currency",
      "posting_date",
      "value_date",
      "date",
    ].some((r) => roles.filter((role) => role === r).length > 1)
  ) {
    issue("layout_unresolved", "Bank column roles remain ambiguous");
    return { bank: null, issues };
  }
  const col = (role: ReturnType<typeof columnRole>) => roles.indexOf(role);
  const dateCol =
    col("posting_date") >= 0
      ? col("posting_date")
      : col("value_date") >= 0
        ? col("value_date")
        : col("date");
  const narrationCol = col("narration"),
    amountCol = col("amount"),
    balanceCol = col("balance");
  const debitCol = col("debit"),
    creditCol = col("credit"),
    feeCol = col("fee");
  const signCols = roles.flatMap((role, i) => (role === "sign" ? [i] : []));
  const summaries = lines.filter((l) => !repeatedHeader(l) && classify(l));
  const body = lines.slice(headerIndex + 1).filter((l) => !repeatedHeader(l) && !classify(l));
  const counterpartyCol = col("counterparty");
  const typeCol = header.findIndex((h) => h.trim().toLowerCase() === "type");
  const typeValues = body.map((l) => l.cells[typeCol]?.trim() ?? "").filter(Boolean);
  const prefixType =
    amountCol >= 0 &&
    typeValues.length > 0 &&
    typeValues.every((value) => /^[a-z/]{1,4}$/i.test(value));
  const moneyCols = roles.flatMap((r, i) =>
    ["amount", "debit", "credit", "balance", "fee"].includes(r) ? [i] : [],
  );
  const tokenAt = (l: SourceLine, i: number) => l.cells[i]?.trim() ?? "";
  const summaryTokens = (l: SourceLine) =>
    l.cells.flatMap((c) => {
      const tail = bankLabel(c)
        .replace(SUMMARY_LABEL, "")
        .replace(/^\s*[:=]\s*/, "")
        .trim();
      return tail && !blank(tail) && parseMoneyToken(tail) !== null ? [tail] : [];
    });
  const tokens = body.flatMap((l) => moneyCols.map((i) => tokenAt(l, i))).filter((t) => !blank(t));
  const convention = numberConvention([...tokens, ...summaries.flatMap(summaryTokens)], metadata);
  if (convention === "conflict" || tokens.some((t) => parseMoneyToken(t, convention) === null)) {
    issue("layout_unresolved", "Bank number convention or amount is unresolved");
    return { bank: null, issues };
  }
  const money = (raw: string) => parseMoneyToken(raw, convention);
  for (const line of [...body, ...summaries]) {
    const kind = classify(line);
    const balanceTokens =
      kind === "opening" || kind === "closing" ? summaryTokens(line) : [tokenAt(line, balanceCol)];
    if (
      balanceTokens.some(
        (raw) =>
          /CR\s*$/i.test(raw) &&
          money(raw) !== null &&
          new AnalyticalDecimal(money(raw)!).isNegative(),
      )
    )
      issue("dropped_amount", "Negative balance contradicts credit suffix", line);
  }
  for (const raw of [...tokens, ...summaries.flatMap(summaryTokens)]) recordCurrency(raw);
  if (currencies.size > 1) issue("layout_unresolved", "Account and row currencies conflict");
  currency = [...currencies][0] ?? null;
  if (issues.length) return { bank: null, issues };
  const dated = lines.filter((l) =>
    body.includes(l)
      ? !!tokenAt(l, dateCol)
      : summaries.includes(l) && ["opening", "closing"].includes(classify(l)!) && hasDate(l),
  );
  const context = `${metadata}\n${header.join(" ")}`;
  const dateResult = bankDates(
    dated.map((l) => tokenAt(l, dateCol)),
    context,
    currency,
    (raw, order) => {
      const date = resolveDate(bankDateToken(raw, context), order);
      return date === "ambiguous" ? null : date;
    },
  );
  if (!dateResult) {
    issue(
      "ambiguous_date",
      "Bank dates conflict, lack a year/period, or have more than one supported order",
    );
    if (!summaries.some((line) => classify(line) === "opening"))
      issue("balance_mismatch", "Bank requires an independently stated opening balance");
    return { bank: null, issues };
  }
  const resolvedDates = new Map(dated.map((l, i) => [l, dateResult.dates[i]!]));
  const transactions: TabularBankTransaction[] = [];
  const balances = new Map<TabularBankTransaction, { amount: string; line: SourceLine }>();
  let opening: string | null = null,
    closing: string | null = null;
  let openingLine: SourceLine | undefined, closingLine: SourceLine | undefined;
  const ambiguousBalances = new Set<"opening" | "closing">();
  const dates = [...dateResult.dates];
  for (const line of summaries) {
    const kind = classify(line);
    if (kind !== "opening" && kind !== "closing") continue;
    const amounts = summaryTokens(line)
      .map(money)
      .filter((a): a is string => a !== null);
    const distinct = new Set(amounts.map((a) => new AnalyticalDecimal(a).toFixed()));
    if (distinct.size !== 1) {
      ambiguousBalances.add(kind);
      issue("balance_mismatch", "Statement balance is unreadable or ambiguous", line);
      continue;
    }
    const amount = amounts[0]!;
    const prior: string | null = kind === "opening" ? opening : closing;
    if (prior !== null && !new AnalyticalDecimal(prior).eq(amount)) {
      ambiguousBalances.add(kind);
      issue("balance_mismatch", "Conflicting stated balances", line);
    }
    if (kind === "opening") {
      opening = amount;
      openingLine = line;
    } else {
      closing = amount;
      closingLine = line;
    }
  }
  if (ambiguousBalances.has("opening")) opening = null;
  if (ambiguousBalances.has("closing")) closing = null;
  let previousDate: string | undefined;
  let previousPage: number | null | undefined;
  // A blank date can group activity only in a resolved table with a running
  // balance. Date carry never crosses a page or an intervening header.
  const declaredGrouping =
    /(?:grouped by date|date (?:is )?(?:shown|printed) (?:only )?once)/i.test(metadata);
  const carryDate =
    narrationCol >= 0 && ((balanceCol >= 0 && signCols.length === 0) || declaredGrouping);
  for (const line of body) {
    let date = resolvedDates.get(line);
    const narration = [
      prefixType ? tokenAt(line, typeCol) : "",
      tokenAt(line, counterpartyCol).replace(/^'/, ""),
      tokenAt(line, narrationCol).replace(/^'/, ""),
    ]
      .filter(Boolean)
      .join(" ");
    if (line.cells.length !== header.length) {
      issue("layout_unresolved", "Transaction field count differs from the header", line);
      if (!date) issue("ambiguous_date", "A transaction has no printed date", line);
      continue;
    }
    let debit = money(tokenAt(line, debitCol));
    const credit = money(tokenAt(line, creditCol));
    if (/CR\s*$/i.test(tokenAt(line, debitCol)) || /DR\s*$/i.test(tokenAt(line, creditCol))) {
      issue("dropped_amount", "Amount suffix contradicts debit/credit column", line);
      continue;
    }
    if (debit !== null && /DR\s*$/i.test(tokenAt(line, debitCol)))
      debit = new AnalyticalDecimal(debit).abs().toFixed();
    const rawAmount = tokenAt(line, amountCol);
    let amount = money(rawAmount);
    if (
      amount !== null &&
      /CR\s*$/i.test(rawAmount) &&
      new AnalyticalDecimal(amount).isNegative()
    ) {
      issue("dropped_amount", "Negative amount contradicts credit suffix", line);
      continue;
    }
    const balance = money(tokenAt(line, balanceCol));
    const pair = signedFlow(debit, credit);
    if (
      (debit && new AnalyticalDecimal(debit).isNegative()) ||
      (credit && new AnalyticalDecimal(credit).isNegative()) ||
      (debit &&
        credit &&
        !new AnalyticalDecimal(debit).isZero() &&
        !new AnalyticalDecimal(credit).isZero())
    ) {
      issue("dropped_amount", "Debit/credit columns have conflicting directions", line);
      continue;
    }
    let directionConflict = false;
    for (const signCol of signCols) {
      if (amount === null) break;
      const directed = applyDrCr(amount, tokenAt(line, signCol));
      const suffix = /(CR|DR)\s*$/i.exec(rawAmount)?.[1];
      if (
        !directed ||
        signCols.some(
          (i) => applyDrCr("1", tokenAt(line, i)) !== applyDrCr("1", tokenAt(line, signCol)),
        ) ||
        (new AnalyticalDecimal(amount).isNegative() &&
          !new AnalyticalDecimal(directed).isNegative()) ||
        (suffix && applyDrCr("1", suffix) !== applyDrCr("1", tokenAt(line, signCol)))
      ) {
        issue("dropped_amount", "Unknown or contradictory transaction direction", line);
        directionConflict = true;
        break;
      }
      amount = directed;
    }
    if (directionConflict) continue;
    if (amount !== null && pair !== null && !new AnalyticalDecimal(amount).eq(pair)) {
      issue(
        "dropped_amount",
        "Redundant account-currency amount disagrees with debit/credit",
        line,
      );
      continue;
    }
    amount ??= pair;
    const fee = money(tokenAt(line, feeCol));
    if (amount !== null && fee !== null) {
      if (new AnalyticalDecimal(fee).isNegative() || /\bnet\b/i.test(header[amountCol] ?? "")) {
        issue("dropped_amount", "Fee sign or net inclusion needs confirmation", line);
        continue;
      }
      amount = new AnalyticalDecimal(amount).sub(fee).toFixed();
    }
    if (
      !date &&
      !tokenAt(line, dateCol) &&
      amount !== null &&
      (balance !== null || declaredGrouping) &&
      carryDate &&
      previousPage === line.page
    ) {
      const prior = lines.indexOf(line);
      const lastTxn = transactions.at(-1);
      const lastIndex = lastTxn
        ? lines.findIndex((l) => l.row === lastTxn.row && l.page === lastTxn.page)
        : -1;
      if (!lines.slice(lastIndex + 1, prior).some(repeatedHeader)) date = previousDate;
    }
    if (!date) {
      if (amount !== null || balance !== null)
        issue("ambiguous_date", "A flow or balance has no valid posting date", line);
      else if (
        narration &&
        line.page !== null &&
        transactions.length &&
        line.cells.every((c, i) => i === narrationCol || blank(c))
      ) {
        const previous = transactions.at(-1)!;
        const updated = {
          ...previous,
          description: `${previous.description} ${narration}`,
          raw: `${previous.raw}\n${line.text}`,
        };
        transactions[transactions.length - 1] = updated;
        const previousBalance = balances.get(previous);
        if (previousBalance) {
          balances.delete(previous);
          balances.set(updated, previousBalance);
        }
      }
      continue;
    }
    if (amount === null) {
      issue("dropped_amount", "Dated transaction has no readable amount", line);
      continue;
    }
    const transaction = {
      date,
      description: narration || "Transaction",
      amount,
      raw: line.text,
      page: line.page,
      row: line.row,
      bbox: line.bbox,
    };
    transactions.push(transaction);
    previousDate = date;
    previousPage = line.page;
    if (balance !== null) balances.set(transaction, { amount: balance, line });
  }
  // Reconcile in chronological order. Preserve source order and provenance in output.
  // Sorting equal-day rows cannot invent an intra-day order.
  const ascending = transactions.every((t, i) => i === 0 || t.date >= transactions[i - 1]!.date);
  const descending = transactions.every((t, i) => i === 0 || t.date <= transactions[i - 1]!.date);
  const ordered = !ascending && descending ? [...transactions].reverse() : [...transactions];
  if (!ascending && !descending)
    issue("balance_mismatch", "Transaction ordering needs confirmation");
  if (ascending && descending && transactions.length > 1 && opening === null)
    issue("balance_mismatch", "Same-day transaction order needs confirmation");
  let running = opening === null ? null : new AnalyticalDecimal(opening);
  let runningMismatch = false;
  for (const txn of ordered) {
    const stated = balances.get(txn);
    if (running) running = running.add(txn.amount);
    if (stated && running && !running.eq(stated.amount)) {
      runningMismatch = true;
      issue(
        "balance_mismatch",
        "Running balance does not roll forward from the prior row",
        stated.line,
      );
    }
    if (!running && stated) running = new AnalyticalDecimal(stated.amount);
  }
  const last = ordered.at(-1);
  const finalBalance = last ? balances.get(last) : undefined;
  const debitTotal = transactions.reduce(
    (sum, t) => (new AnalyticalDecimal(t.amount).isNegative() ? sum.sub(t.amount) : sum),
    new AnalyticalDecimal(0),
  );
  const creditTotal = transactions.reduce(
    (sum, t) => (new AnalyticalDecimal(t.amount).isPositive() ? sum.add(t.amount) : sum),
    new AnalyticalDecimal(0),
  );
  for (const line of summaries) {
    const kind = classify(line);
    if (kind === "opening" || kind === "closing" || kind === "footer") continue;
    const amounts = summaryTokens(line)
      .map(money)
      .filter((a): a is string => a !== null);
    const check = (raw: string | null, expected: InstanceType<typeof AnalyticalDecimal>) => {
      if (raw === null || !expected.eq(raw))
        issue(
          "balance_mismatch",
          "Statement summary total/count disagrees with transactions",
          line,
        );
    };
    if (kind === "count") {
      const label = line.text.toLowerCase();
      const count = /debits?|withdrawals?/.test(label)
        ? transactions.filter((t) => new AnalyticalDecimal(t.amount).isNegative()).length
        : /credits?|deposits?/.test(label)
          ? transactions.filter((t) => new AnalyticalDecimal(t.amount).isPositive()).length
          : transactions.length;
      check(amounts.length === 1 ? amounts[0]! : null, new AnalyticalDecimal(count));
    } else if (kind === "debit" || kind === "credit") {
      check(amounts.length === 1 ? amounts[0]! : null, kind === "debit" ? debitTotal : creditTotal);
    } else if (kind === "total") {
      let checked = false;
      for (const [i, expected] of [
        [debitCol, debitTotal],
        [creditCol, creditTotal],
        [amountCol, creditTotal.sub(debitTotal)],
      ] as const) {
        const raw = tokenAt(line, i);
        if (!blank(raw) && !SUMMARY_LABEL.test(raw)) {
          check(money(raw), expected);
          checked = true;
        }
      }
      if (!checked && amounts.length)
        issue("balance_mismatch", "Unclassified statement total requires review", line);
    }
  }
  // Running balances can reconcile transactions, but only labelled summaries
  // supply a closing value for persistence.
  if (balanceCol >= 0 && closing !== null) {
    const closingReconciles =
      opening !== null && new AnalyticalDecimal(opening).add(sumAmounts(transactions)).eq(closing);
    const lastPrintedBalance = body
      .map((line) => money(tokenAt(line, balanceCol)))
      .filter((amount): amount is string => amount !== null)
      .at(-1);
    if (
      !closingReconciles &&
      !runningMismatch &&
      lastPrintedBalance !== undefined &&
      !new AnalyticalDecimal(lastPrintedBalance).eq(closing)
    ) {
      issue(
        "balance_mismatch",
        "Labelled closing balance disagrees with transactions or last running balance",
        closingLine,
      );
      closing = null;
    }
  }
  const checkClosing = closing ?? (issues.length === 0 ? (finalBalance?.amount ?? null) : null);
  if (
    opening === null ||
    checkClosing === null ||
    !new AnalyticalDecimal(opening).add(sumAmounts(transactions)).eq(checkClosing)
  )
    issue(
      "balance_mismatch",
      "Bank requires independently stated opening and closing balances that reconcile with transactions",
      closingLine,
    );
  const periodStart = dateResult.period?.start ?? dates.slice().sort()[0];
  const periodEnd = dateResult.period?.end ?? dates.slice().sort().at(-1);
  if (!periodStart || !periodEnd) return { bank: null, issues };
  // Never retain a possibly shifted, incomplete, or unreconciled grouped table.
  // Ordinary legacy layouts still expose independently printed safe facts.
  if (
    carryDate &&
    body.some(
      (l) => !tokenAt(l, dateCol) && moneyCols.some((i) => money(tokenAt(l, i)) !== null),
    ) &&
    issues.length
  )
    return { bank: null, issues };
  return {
    bank: {
      periodStart,
      periodEnd,
      currency,
      opening,
      closing,
      openingRaw: openingLine?.text ?? "",
      closingRaw: closingLine?.text ?? "",
      openingPage: openingLine?.page ?? null,
      closingPage: closingLine?.page ?? null,
      openingBBox: openingLine?.bbox ?? null,
      closingBBox: closingLine?.bbox ?? null,
      transactions,
      issues,
    },
    issues,
  };
}

const SUMMARY_LABEL =
  /^(?:(?:opening|beginning|closing|ending)(?:\s+bal(?:ance)?)?|(?:balance\s+)?(?:brought|carried)\s+forward|(?:balance\s+)?b\/?f|(?:number\s+of\s+|total\s+)?(?:transactions?|debits?|credits?|withdrawals?|deposits?)\s+count|number\s+of\s+(?:transactions?|debits?|credits?)|(?:total\s+)?(?:debits?|credits?|withdrawals?|deposits?)|(?:grand\s+)?totals?)(?=\s|:|=|$)/i;
function summaryKind(
  line: SourceLine,
): "opening" | "closing" | "debit" | "credit" | "count" | "total" | "footer" | null {
  const label = line.cells
    .map((c) => bankLabel(c).trim())
    .find((c) => {
      const match = SUMMARY_LABEL.exec(c);
      if (!match) return false;
      const tail = c
        .slice(match[0].length)
        .replace(/^\s*[:=]\s*/, "")
        .trim();
      return !tail || parseMoneyToken(tail) !== null;
    });
  if (!label)
    return /^(?:page\s+\d+(?:\s+of\s+\d+)?|end of statement)$/i.test(line.text.trim())
      ? "footer"
      : null;
  if (/opening|beginning|brought|b\/?f/i.test(label)) return "opening";
  if (/closing|ending|carried/i.test(label)) return "closing";
  if (/count|number of/i.test(label)) return "count";
  if (/debit|withdrawal/i.test(label)) return "debit";
  if (/credit|deposit/i.test(label)) return "credit";
  return "total";
}

function parseNarrative(lines: readonly SourceLine[], text: string): BankParse {
  if (!/opening balance/i.test(text) || !/closing balance/i.test(text)) {
    return { bank: null, issues: [] };
  }
  const period = /period\s+(\d{4}-\d{2}-\d{2})\s+(?:to|through)\s+(\d{4}-\d{2}-\d{2})/i.exec(text);
  const locale = inferDateLocale(
    lines
      .map(
        (line) => /^(\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{4}-\d{2}-\d{2})/.exec(line.text)?.[1] ?? "",
      )
      .filter((token) => token.length > 0),
  );
  const issues: BankIssue[] = [];
  let opening: string | null = null;
  let closing: string | null = null;
  let openingRaw = "";
  let closingRaw = "";
  let openingPage: number | null = null;
  let closingPage: number | null = null;
  let openingBBox: TabularBankTransaction["bbox"] = null;
  let closingBBox: TabularBankTransaction["bbox"] = null;
  const transactions: TabularBankTransaction[] = [];
  for (const line of lines) {
    const openingMatch = /opening balance\s+(.+)$/i.exec(line.text);
    if (openingMatch?.[1]) {
      const amount = parseMoneyToken(openingMatch[1]);
      if (amount !== null) {
        opening = amount;
        openingRaw = line.text;
        openingPage = line.page;
        openingBBox = line.bbox;
        continue;
      }
    }
    const closingMatch = /closing balance\s+(.+)$/i.exec(line.text);
    if (closingMatch?.[1]) {
      const amount = parseMoneyToken(closingMatch[1]);
      if (amount !== null) {
        closing = amount;
        closingRaw = line.text;
        closingPage = line.page;
        closingBBox = line.bbox;
        continue;
      }
    }
    const txn = /^(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})\s+(.+)$/.exec(line.text.trim());
    if (!txn) continue;
    const resolved = resolveDate(txn[1] ?? "", locale);
    if (resolved === "ambiguous") {
      issues.push({
        code: "ambiguous_date",
        message: `Date ${txn[1] ?? ""} is ambiguous without a locale`,
        raw: line.text,
        page: line.page,
      });
      continue;
    }
    const tokens = findMoneyTokens(txn[2] ?? "");
    if (!resolved) continue;
    if (tokens.length !== 1) {
      issues.push({
        code: "dropped_amount",
        message: "Narrative transaction amount is ambiguous",
        raw: line.text,
        page: line.page,
      });
      continue;
    }
    const amount = tokens[0];
    if (!amount) continue;
    transactions.push({
      date: resolved,
      description: (txn[2] ?? "").replace(amount.raw, "").trim() || "Transaction",
      amount: amount.amount,
      raw: line.text.trim(),
      page: line.page,
      row: line.row,
      bbox: line.bbox,
    });
  }
  if (!opening || !closing || !period?.[1] || !period[2]) return { bank: null, issues };
  if (!new AnalyticalDecimal(opening).add(sumAmounts(transactions)).eq(closing)) {
    issues.push({
      code: "balance_mismatch",
      message: "Narrative bank balances do not reconcile",
      raw: closingRaw,
      page: closingPage,
    });
  }
  return {
    bank: {
      periodStart: period[1],
      periodEnd: period[2],
      currency: currencyOf(text),
      opening,
      closing,
      openingRaw,
      closingRaw,
      openingPage,
      closingPage,
      openingBBox,
      closingBBox,
      transactions,
      issues,
    },
    issues,
  };
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export function resolveDate(
  value: string,
  locale: "DMY" | "MDY" | "unknown",
): string | "ambiguous" | null {
  const trimmed = value.trim();
  const isoPrefix = /^(\d{4}[-/]\d{1,2}[-/]\d{1,2})(?:[T\s].*)?$/.exec(trimmed);
  if (isoPrefix?.[1]) {
    const [year, month, day] = isoPrefix[1].split(/[-/]/);
    return iso(year!, Number(month), Number(day));
  }
  const named = namedDate(trimmed);
  if (named) return named;
  const parts = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(trimmed);
  if (!parts?.[1] || !parts[2] || !parts[3]) return null;
  const year = expandYear(parts[3]);
  const first = Number(parts[1]);
  const second = Number(parts[2]);
  if (first > 12 && second <= 12) return locale === "MDY" ? null : iso(year, second, first);
  if (second > 12 && first <= 12) return locale === "DMY" ? null : iso(year, first, second);
  if (first > 12 || second > 12) return null;
  if (locale === "DMY") return iso(year, second, first);
  if (locale === "MDY") return iso(year, first, second);
  return first === second ? iso(year, first, second) : "ambiguous";
}

function expandYear(year: string): string {
  if (year.length === 4) return year;
  const value = Number(year);
  return String(value <= 69 ? 2000 + value : 1900 + value);
}

function namedDate(value: string): string | null {
  const dayFirst = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s,]?(\d{2,4})$/.exec(value);
  if (dayFirst?.[1] && dayFirst[2] && dayFirst[3]) {
    const month = MONTHS[dayFirst[2].toLowerCase()];
    if (month) return iso(expandYear(dayFirst[3]), month, Number(dayFirst[1]));
  }
  const monthFirst = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/.exec(value);
  if (monthFirst?.[1] && monthFirst[2] && monthFirst[3]) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    if (month) return iso(expandYear(monthFirst[3]), month, Number(monthFirst[2]));
  }
  return null;
}

export function inferDateLocale(values: readonly string[]): "DMY" | "MDY" | "unknown" {
  let dayFirst = false;
  let monthFirst = false;
  for (const value of values) {
    const parts = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(value.trim());
    if (!parts?.[1] || !parts[2]) continue;
    const first = Number(parts[1]);
    const second = Number(parts[2]);
    if (first > 12 && second <= 12) dayFirst = true;
    if (second > 12 && first <= 12) monthFirst = true;
  }
  if (dayFirst && !monthFirst) return "DMY";
  if (monthFirst && !dayFirst) return "MDY";
  return "unknown";
}

function columnRole(
  cell: string,
):
  | "date"
  | "value_date"
  | "posting_date"
  | "narration"
  | "counterparty"
  | "debit"
  | "credit"
  | "amount"
  | "balance"
  | "sign"
  | "fee"
  | "currency"
  | "note"
  | "unknown" {
  const text = bankLabel(cell)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (text.length === 0) return "note";
  if (/^(?:counterparty|counter party|naam tegenpartij)$/.test(text)) return "counterparty";
  if (/^(?:note|account name|account number)$/.test(text)) return "note";
  if (/^(?:currency|ccy|curr|account currency)$/.test(text)) return "currency";
  if (/^(dr cr|cr dr|direction|credit debit indicator|transaction type)$/.test(text)) return "sign";
  if (/\b(?:completed|completion|booked|booking|posting|posted)\b/.test(text))
    return "posting_date";
  if (/\bvalue date\b/.test(text)) return "value_date";
  if (/\b(?:started|created|initiated|authori[sz]ed)\b/.test(text)) return "note";
  if (/\bdate\b/.test(text)) return "date";
  if (/\b(?:fee|fees|charges?|commission)\b/.test(text)) return "fee";
  if (
    /\b(narration|narrative|description|memo|particulars|particular|details|payee|beneficiary|remarks)\b/.test(
      text,
    )
  ) {
    return "narration";
  }
  if (/\b(balance|bal)\b/.test(text)) return "balance";
  if (/\bamount\b/.test(text) && /\bdr\b.*\bcr\b|\bcr\b.*\bdr\b/.test(text)) return "amount";
  if (/\b(withdrawal|withdrawals|debit|money out|paid out|dr)\b/.test(text)) {
    return "debit";
  }
  if (/\b(deposit|deposits|credit|money in|paid in|cr)\b/.test(text) && !/\blimit\b/.test(text)) {
    return "credit";
  }
  if (/\bamount\b/.test(text)) return "amount";
  if (/\b(balance|running bal|running balance)\b/.test(text)) return "balance";
  if (/\b(cheque|chq|note|notes|ref|reference|utr|branch)\b/.test(text)) return "note";
  return "unknown";
}

function applyDrCr(amount: string, sign: string): string | null {
  const token = sign.trim().toLowerCase();
  if (/^(dr|debit|withdrawal|check|check_paid|ach_debit)$/.test(token)) {
    return amount.startsWith("-") ? amount : `-${amount}`;
  }
  if (/^(cr|credit|deposit|dslip|ach_credit)$/.test(token)) return amount.replace(/^-/, "");
  return null;
}

function iso(year: string, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (new Date(Date.UTC(Number(year), month - 1, day)).getUTCMonth() !== month - 1) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isHeader(cells: readonly string[]): boolean {
  const roles = cells.map(columnRole);
  const hasDate = roles.some((r) => r === "date" || r === "value_date" || r === "posting_date");
  const hasFlow = roles.includes("debit") || roles.includes("credit") || roles.includes("amount");
  return hasDate && hasFlow;
}

function signedFlow(withdrawal: string | null, deposit: string | null): string | null {
  if (deposit && withdrawal) return subtract(deposit, withdrawal);
  if (deposit) return deposit;
  if (withdrawal) return withdrawal.startsWith("-") ? withdrawal : `-${withdrawal}`;
  return null;
}

function subtract(left: string, right: string): string {
  return new AnalyticalDecimal(left).sub(right).toFixed();
}

function sumAmounts(transactions: readonly TabularBankTransaction[]): string {
  return transactions.reduce((sum, txn) => sum.add(txn.amount), new AnalyticalDecimal(0)).toFixed();
}

function currencyOf(text: string): string | null {
  return currencyEvidence(text).currency;
}

function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}
