"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { useState } from "react";

import { amountDecimal, parseAmount } from "./csv";
import type { Session } from "./books/api";
import { useAction } from "./books/hooks";
import { ErrorNotice } from "./books/ui";
import {
  applyStatementUpload,
  isCurrentDataSource,
  parseSourceTable,
  smartLedgerApplies,
  statementPairNote,
  suggestCategory,
  writeDataSource,
  type AccountingSystem,
  type DataSourceKind,
  type DataSourceState,
  type StatementCadence,
  type StatementSlot,
} from "./data-source";
import { kernelCall } from "./program/api";

const SYSTEMS: readonly { readonly id: AccountingSystem; readonly label: string }[] = [
  { id: "quickbooks", label: "QuickBooks" },
  { id: "xero", label: "Xero" },
  { id: "netsuite", label: "NetSuite" },
  { id: "sage", label: "Sage" },
];

const CADENCE: readonly { readonly id: StatementCadence; readonly label: string }[] = [
  { id: "monthly", label: "Monthly" },
  { id: "quarterly", label: "Quarterly" },
  { id: "yearly", label: "Yearly" },
];

export function UploadMap({
  session,
  source,
  onChange,
}: {
  session: Session;
  source: DataSourceState;
  onChange: (next: DataSourceState) => void;
}) {
  const action = useAction();
  const [fileNote, setFileNote] = useState<string | null>(null);
  const ledgerOn = smartLedgerApplies(source.kind);

  function selectKind(kind: DataSourceKind) {
    const next: DataSourceState = {
      ...source,
      kind,
      system: kind === "financial_statements" ? source.system : null,
      fileName: kind === source.kind ? source.fileName : null,
      rows: kind === "financial_statements" ? [] : source.rows,
    };
    writeDataSource(next, session);
    onChange(next);
    setFileNote(null);
  }

  async function onFile(file: File) {
    if (!isCurrentDataSource(source, session)) return;
    const spreadsheet = /\.xlsx?$/i.test(file.name);
    const pdf = /\.pdf$/i.test(file.name);
    if (file.size === 0) {
      setFileNote(`${file.name} is empty (0 bytes). Nothing was read or stored.`);
      return;
    }
    if (source.kind === "financial_statements" || (source.kind === "bank" && pdf)) {
      await readOnServer(file);
      return;
    }
    if (spreadsheet || pdf) {
      setFileNote(
        "Save the sheet as CSV. The kernel import reads an account column and an amount column from text.",
      );
      return;
    }
    const text = await file.text();
    if (!isCurrentDataSource(source, session)) return;
    let parsed: ReturnType<typeof parseSourceTable>;
    try {
      parsed = parseSourceTable(text);
    } catch (error) {
      setFileNote(error instanceof Error ? error.message : "CSV needs review.");
      return;
    }
    const checked = parsed.map((row) => ({
      row,
      amount: parseAmount(row.amount, { decimal: "auto" }),
    }));
    const issues = checked.filter((item) => !item.amount.ok || !item.row.account);
    const canonical = checked.map(({ row, amount }) => ({
      ...row,
      amount: amount.ok ? amountDecimal(amount) : row.amount,
    }));
    if (parsed.length === 0) {
      setFileNote("The file has no account and amount columns the kernel can import.");
      return;
    }
    const rows = canonical.map((row, index) => {
      const suggested = suggestCategory(row.account);
      const checkedAmount = checked[index]?.amount;
      const reviewReason = !row.account
        ? "Missing account"
        : checkedAmount && !checkedAmount.ok
          ? checkedAmount.reason
          : null;
      return {
        ...row,
        category: suggested ?? "",
        suggestedCategory: suggested,
        ...(reviewReason ? { reviewReason } : {}),
      };
    });
    const next = { ...source, fileName: file.name, rows };
    writeDataSource(next, session);
    onChange(next);
    if (issues.length > 0) {
      setFileNote(
        `Needs review. Nothing imported. ${issues.map(({ row, amount }) => `Row ${row.rowNo}: ${amount.ok ? "Missing account" : amount.reason} (${row.amount})`).join("; ")}`,
      );
      return;
    }
    if (session.tenantId.length === 0) {
      setFileNote(
        "Rows are ready to map. Provision a company before the kernel stores the import.",
      );
      return;
    }
    const stored = await action.run(() =>
      kernelCall(
        session,
        "POST",
        "/v1/imports",
        {
          rows: canonical.map((row) => ({
            rowNo: row.rowNo,
            account: row.account,
            amount: row.amount,
          })),
        },
        { idempotencyKey: `${file.name}:${file.size}:${parsed.length}` },
      ),
    );
    if (!isCurrentDataSource(source, session)) return;
    setFileNote(
      stored && typeof stored.fileHash === "string"
        ? `Kernel stored one batch. File hash ${stored.fileHash}.`
        : "Rows are on this screen. The kernel did not store a batch.",
    );
  }

  /** The kernel reads bank PDFs and statement workbooks; this screen only shows what it returns. */
  async function readOnServer(file: File) {
    const kind = source.kind === "bank" ? "bank" : "financial_statements";
    if (session.actorId.length === 0) {
      setFileNote(`Sign in so the kernel can read ${file.name}. Nothing was uploaded.`);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setFileNote(
        `${file.name} is ${file.size} bytes. The kernel accepts files up to ${MAX_UPLOAD_BYTES} bytes here. Nothing was uploaded.`,
      );
      return;
    }
    setFileNote(`Sending ${file.name} to the kernel…`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isCurrentDataSource(source, session)) return;
    const data = await action.run(() =>
      kernelCall(session, "POST", "/v1/imports/file", {
        kind,
        ...(kind === "financial_statements" ? { cadence: source.cadence } : {}),
        fileName: file.name,
        contentBase64: toBase64(bytes),
      }),
    );
    if (!isCurrentDataSource(source, session)) return;
    if (!data) {
      setFileNote(`The kernel did not accept ${file.name}. Nothing was stored.`);
      return;
    }
    const result = decodeFileImport(data);
    if (!result) {
      setFileNote(
        "The kernel returned a response this screen does not recognise. Nothing is shown.",
      );
      return;
    }
    const storedNote = result.stored
      ? `Kernel ${result.replayed ? "already had" : "stored"} import batch ${result.importBatchId} (file SHA-256 ${result.fileHash}).`
      : `${result.reason ?? "The kernel did not store this file."} File SHA-256 ${result.fileHash}.`;

    if (kind === "bank") {
      const rows = result.bankRows.map((row) => {
        const suggested = suggestCategory(row.description);
        return {
          rowNo: row.rowNo,
          account: row.description,
          amount: row.amount,
          date: row.date,
          category: suggested ?? "",
          suggestedCategory: suggested,
        };
      });
      const next = { ...source, fileName: file.name, rows };
      writeDataSource(next, session);
      onChange(next);
      const checks = result.totalChecks.map(
        (check) =>
          `${check.label}: printed ${check.printedCount} for ${check.printedAmount}, read ${check.parsedCount} for ${check.parsedAmount}${check.matches ? "." : " (does not match)."}`,
      );
      setFileNote(
        [
          `Read ${rows.length} dated line${rows.length === 1 ? "" : "s"} from ${file.name}; ${result.skippedCount} line${result.skippedCount === 1 ? "" : "s"} skipped as unreadable.`,
          ...checks,
          storedNote,
          "No journal was posted.",
        ].join(" "),
      );
      return;
    }

    const applied = applyStatementUpload(source.statementPair, {
      fileName: file.name,
      fileHash: result.fileHash,
      cadence: source.cadence,
      sheets: result.sheets,
    });
    const next = { ...source, fileName: file.name, rows: [], statementPair: applied.pair };
    writeDataSource(next, session);
    onChange(next);
    const sheets = result.sheets.map(
      (sheet) =>
        `${statementLabel(sheet.statementType)} "${sheet.sheetName}": ${sheet.valuedLineCount} lines with values across ${sheet.periodCount} periods (${sheet.firstPeriod} to ${sheet.lastPeriod})${sheet.derivedPeriods.length > 0 ? `; column ${sheet.derivedPeriods.join(", ")} holds only formulas and is kept as reported, not as a month` : ""}; ${sheet.skippedCells} cells skipped.`,
    );
    setFileNote(
      [
        ...sheets,
        statementPairNote(applied.pair, applied.cashFlowInFile),
        storedNote,
        "Smart Ledger stays hidden.",
      ].join(" "),
    );
  }

  return (
    <section className="panel">
      <header className="page-head">
        <div>
          <h1>Upload and map</h1>
          <p>
            Choose one source. Bank or trial balance opens Smart Ledger. Financial statements need
            an income statement and a balance sheet. Cash flow is calculated from that pair.
          </p>
        </div>
      </header>

      <div className="source-grid">
        <SourceCard
          title="Bank"
          body="Connect a bank, or upload PDF and CSV transactions."
          active={source.kind === "bank"}
          onSelect={() => selectKind("bank")}
        />
        <SourceCard
          title="Trial balance"
          body="Upload an Excel or CSV trial balance."
          active={source.kind === "trial_balance"}
          onSelect={() => selectKind("trial_balance")}
        />
        <SourceCard
          title="Financial statements"
          body="Connect an accounting system, or upload the income statement and the balance sheet. Cash flow is calculated."
          active={source.kind === "financial_statements"}
          onSelect={() => selectKind("financial_statements")}
        />
      </div>

      {source.kind === null ? <p className="muted">Select a source to continue.</p> : null}

      {ledgerOn ? (
        <div className="notice notice-info" role="status">
          <strong>Smart Ledger enabled.</strong>
          <p>You can re-map any category. Suggestions stay labeled until you change them.</p>
        </div>
      ) : null}

      {source.kind === "financial_statements" ? (
        <div className="notice notice-locked" role="status">
          <strong>Smart Ledger not applicable.</strong>
          <p>
            Statements arrive structured. Upload the income statement and the balance sheet. Cash
            flow is calculated from that pair, so it is not an upload.
          </p>
        </div>
      ) : null}

      {source.kind === "bank" ? (
        <div className="form-card">
          <h2>Bank transactions</h2>
          <p className="muted">
            PDF and CSV files land as source rows. A live bank connection is not linked on this
            kernel yet.
          </p>
          <div className="row-actions">
            <Button type="button" variant="outline" disabled>
              Connect your bank
            </Button>
          </div>
          <FileDrop
            accept=".csv,.txt,.pdf"
            label="Drop a PDF or CSV"
            onFile={(file) => void onFile(file)}
          />
        </div>
      ) : null}

      {source.kind === "trial_balance" ? (
        <div className="form-card">
          <h2>Trial balance</h2>
          <p className="muted">
            Use two columns: account, then amount. The kernel stores the file once.
          </p>
          <FileDrop
            accept=".csv,.txt,.xlsx"
            label="Drop an Excel or CSV trial balance"
            onFile={(file) => void onFile(file)}
          />
        </div>
      ) : null}

      {source.kind === "financial_statements" ? (
        <div className="form-card">
          <h2>Accounting system or statement file</h2>
          <div className="row-actions">
            {SYSTEMS.map((system) => (
              <Button
                key={system.id}
                type="button"
                variant={source.system === system.id ? "outline" : "ghost"}
                onClick={() => {
                  const next = { ...source, system: system.id };
                  writeDataSource(next, session);
                  onChange(next);
                }}
              >
                {system.label}
              </Button>
            ))}
          </div>
          <p className="muted small">
            {source.system
              ? `${labelFor(source.system)} is selected. The kernel has not received a live connection.`
              : "Upload the income statement and the balance sheet. One file can hold both, or you can upload them separately."}
          </p>
          <fieldset className="cadence">
            <legend>Statement cadence</legend>
            {CADENCE.map((item) => (
              <label key={item.id} className="check">
                <Input
                  type="radio"
                  name="cadence"
                  checked={source.cadence === item.id}
                  onChange={() => {
                    const next = { ...source, cadence: item.id };
                    writeDataSource(next, session);
                    onChange(next);
                  }}
                />
                {item.label}
              </label>
            ))}
          </fieldset>
          <StatementChecklist pair={source.statementPair} />
          <p className="muted small">
            Excel (.xlsx), CSV, or PDF. A scanned PDF with no text is refused. A cash flow page in a
            file is not the calculated cash flow.
          </p>
          <FileDrop
            accept=".xlsx,.xls,.csv,.pdf"
            label="Drop an Excel, CSV, or PDF statement"
            onFile={(file) => void onFile(file)}
          />
        </div>
      ) : null}

      {source.rows.some((row) => row.reviewReason) ? (
        <div role="alert">
          <strong>Needs review ? these rows have not been imported.</strong>
          <ul>
            {source.rows
              .filter((row) => row.reviewReason)
              .map((row) => (
                <li key={row.rowNo}>
                  Row {row.rowNo}: {row.account} ? {row.amount}: {row.reviewReason}
                </li>
              ))}
          </ul>
        </div>
      ) : null}
      {fileNote ? (
        <p className="muted" role="status">
          {fileNote}
        </p>
      ) : null}
      {action.state.error ? (
        <ErrorNotice error={action.state.error} httpStatus={action.state.httpStatus} />
      ) : null}
      {source.fileName ? <p className="muted small">Last file: {source.fileName}</p> : null}
    </section>
  );
}

function SourceCard({
  title,
  body,
  active,
  onSelect,
}: {
  title: string;
  body: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "source-card source-card-active" : "source-card"}
      aria-pressed={active}
      onClick={onSelect}
    >
      <strong>{title}</strong>
      <span>{body}</span>
    </button>
  );
}

function FileDrop({
  accept,
  label,
  onFile,
}: {
  accept: string;
  label: string;
  onFile: (file: File) => void;
}) {
  return (
    <label className="file-drop">
      <span>{label}</span>
      <input
        type="file"
        accept={accept}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
        }}
      />
    </label>
  );
}

/** Base64 adds a third, and the API refuses JSON bodies over 1 MiB. */
const MAX_UPLOAD_BYTES = 4_000_000;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

interface FileImportView {
  readonly stored: boolean;
  readonly replayed: boolean;
  readonly importBatchId: string | null;
  readonly reason: string | null;
  readonly fileHash: string;
  readonly bankRows: readonly {
    rowNo: number;
    date: string;
    description: string;
    amount: string;
  }[];
  readonly skippedCount: number;
  readonly totalChecks: readonly {
    label: string;
    printedCount: number;
    printedAmount: string;
    parsedCount: number;
    parsedAmount: string;
    matches: boolean;
  }[];
  readonly sheets: readonly {
    sheetName: string;
    statementType: string;
    periodCount: number;
    firstPeriod: string | null;
    lastPeriod: string | null;
    derivedPeriods: readonly string[];
    valuedLineCount: number;
    skippedCells: number;
  }[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function count(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
    : [];
}

function decodeFileImport(data: Record<string, unknown>): FileImportView | null {
  const fileHash = text(data, "fileHash");
  if (fileHash === null || typeof data.stored !== "boolean") return null;
  const bank = asRecord(data.bank);
  const statements = asRecord(data.statements);
  const bankRows: { rowNo: number; date: string; description: string; amount: string }[] = [];
  for (const row of list(bank?.rows)) {
    const date = text(row, "date");
    const description = text(row, "description");
    const amount = text(row, "amount");
    const rowNo = count(row, "rowNo");
    if (date === null || description === null || amount === null || rowNo === 0) return null;
    bankRows.push({ rowNo, date, description, amount });
  }
  return {
    stored: data.stored,
    replayed: data.replayed === true,
    importBatchId: text(data, "importBatchId"),
    reason: text(data, "reason"),
    fileHash,
    bankRows,
    skippedCount: bank ? count(bank, "skippedCount") : 0,
    totalChecks: list(bank?.totalChecks).map((check) => ({
      label: text(check, "label") ?? "",
      printedCount: count(check, "printedCount"),
      printedAmount: text(check, "printedAmount") ?? "",
      parsedCount: count(check, "parsedCount"),
      parsedAmount: text(check, "parsedAmount") ?? "",
      matches: check.matches === true,
    })),
    sheets: list(statements?.sheets).map((sheet) => ({
      sheetName: text(sheet, "sheetName") ?? "",
      statementType: text(sheet, "statementType") ?? "",
      periodCount: count(sheet, "periodCount"),
      firstPeriod: text(sheet, "firstPeriod"),
      lastPeriod: text(sheet, "lastPeriod"),
      derivedPeriods: Array.isArray(sheet.derivedPeriods)
        ? sheet.derivedPeriods.filter((value): value is string => typeof value === "string")
        : [],
      valuedLineCount: count(sheet, "valuedLineCount"),
      skippedCells: count(sheet, "skippedCells"),
    })),
  };
}

function StatementChecklist({ pair }: { pair: DataSourceState["statementPair"] }) {
  return (
    <ul className="statement-set">
      <StatementSlotRow
        label="Income statement"
        slot={pair.incomeStatement}
        missing="Required. Not uploaded yet."
      />
      <StatementSlotRow
        label="Balance sheet"
        slot={pair.balanceSheet}
        missing="Required. Not uploaded yet."
      />
      <li>
        <strong>Cash flow</strong>
        <span>
          Not an upload. The kernel calculates it after the income statement and the balance sheet
          are stored for the same cadence.
        </span>
      </li>
    </ul>
  );
}

function StatementSlotRow({
  label,
  slot,
  missing,
}: {
  label: string;
  slot: StatementSlot | null;
  missing: string;
}) {
  const detail = slot
    ? `${slot.fileName} · ${slot.cadence} · ${slot.firstPeriod ?? "period"} to ${slot.lastPeriod ?? "period"}`
    : missing;
  return (
    <li>
      <strong>{label}</strong>
      <span>{detail}</span>
    </li>
  );
}

function statementLabel(type: string): string {
  if (type === "income_statement") return "Income statement";
  if (type === "balance_sheet") return "Balance sheet";
  if (type === "cash_flow") return "Cash flow";
  if (type === "equity") return "Equity";
  return "Statement";
}

function labelFor(id: AccountingSystem): string {
  return SYSTEMS.find((system) => system.id === id)?.label ?? id;
}
