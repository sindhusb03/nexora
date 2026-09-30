import { createHash } from "node:crypto";

import type { LedgerStore } from "@nexora/db";
import {
  assertSameRegion,
  assertTenantActive,
  authorize,
  hashMaterial,
  KernelError,
} from "@nexora/kernel";
import type { Hono } from "hono";
import { z } from "zod";

import { ApiError, readActor, type ActorContext, type AppEnv } from "../http.js";
import {
  extractPdfText,
  parseBankStatement,
  PdfReadError,
  type BankStatement,
} from "./bank-pdf.js";
import { parseStatementCsv } from "./statement-csv.js";
import { parseStatementPdf } from "./statement-pdf.js";
import { parseStatementWorkbook, type StatementWorkbook } from "./statement-xlsx.js";
import { readWorkbook, WorkbookError } from "./xlsx.js";

export const FILE_PARSER_VERSION = "file-import-0.2.0";

export const fileImportSchema = z.object({
  kind: z.enum(["bank", "financial_statements"]),
  cadence: z.enum(["monthly", "quarterly", "yearly"]).optional(),
  fileName: z.string().trim().min(1).max(255),
  contentBase64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, "contentBase64 must be base64"),
});

type FileImportInput = z.infer<typeof fileImportSchema>;
type Format = "pdf" | "xlsx" | "csv";

export function registerFileImportRoutes(app: Hono<AppEnv>, store: LedgerStore): void {
  app.post("/v1/imports/file", async (c) => {
    const body = fileImportSchema.parse(await c.req.json());
    const result = await importFile(store, readActor(c), body);
    return c.json(result, result.stored && !result.replayed ? 201 : 200);
  });
}

/**
 * Reads a bank PDF or a financial-statement workbook on the server and, when the caller has a company selected, stores
 * it once as an import batch keyed by the file's SHA-256. Nothing here posts journals.
 */
export async function importFile(store: LedgerStore, actor: ActorContext, input: FileImportInput) {
  const bytes = new Uint8Array(Buffer.from(input.contentBase64, "base64"));
  if (bytes.length === 0) {
    throw new ApiError(
      400,
      "IMPORT_EMPTY_FILE",
      `${input.fileName} is empty (0 bytes). Nothing was read or stored.`,
    );
  }
  if (input.kind === "financial_statements" && !input.cadence) {
    throw new ApiError(
      400,
      "VALIDATION_FAILED",
      "Choose a statement cadence before uploading statements",
    );
  }
  const format = sniffFormat(bytes, input.fileName);
  const fileHash = createHash("sha256").update(bytes).digest("hex");

  const parsed =
    input.kind === "bank"
      ? await readBank(bytes, format, input.fileName)
      : await readStatements(bytes, format, input.fileName);
  const summary = {
    kind: input.kind,
    format,
    fileName: input.fileName,
    fileBytes: bytes.length,
    fileHash,
    cadence: input.kind === "financial_statements" ? (input.cadence ?? null) : null,
    parserVersion: FILE_PARSER_VERSION,
    rowsHash: parsed.rowsHash,
    ...parsed.view,
  };

  if (!actor.tenantId) {
    return {
      stored: false as const,
      replayed: false,
      importBatchId: null,
      reason: "No company is selected, so the kernel did not store this file.",
      ...summary,
    };
  }
  const tenant = await scope(store, actor);
  const key = `file:${input.kind}:${summary.cadence ?? "-"}:${fileHash}`;
  const existing = await store.findImportBatch(tenant.tenantId, key);
  if (existing) {
    if (existing.stateHash !== fileHash) {
      throw new KernelError(
        "FIN_IDEMPOTENCY_MISMATCH",
        "This file key was already used for different content",
      );
    }
    return {
      stored: true as const,
      replayed: true,
      importBatchId: existing.id,
      reason: null,
      ...summary,
    };
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await store.insertImportBatch({
    tenantId: tenant.tenantId,
    id,
    idempotencyKey: key,
    fileHash,
    payload: { source: "file", ...summary },
    rows: parsed.sourceRows.map((row) => ({
      id: crypto.randomUUID(),
      rowNo: row.rowNo,
      payload: row.payload,
    })),
    createdAt: now,
    audit: {
      eventId: crypto.randomUUID(),
      eventType: "ImportBatchCreated",
      aggregateType: "import_batch",
      aggregateId: id,
      actorId: actor.actorId,
      correlationId: actor.correlationId,
      occurredAt: now,
      payload: {
        fileHash,
        rowsHash: parsed.rowsHash,
        kind: input.kind,
        format,
        cadence: summary.cadence,
        rowCount: parsed.sourceRows.length,
        parserVersion: FILE_PARSER_VERSION,
      },
    },
  });
  return { stored: true as const, replayed: false, importBatchId: id, reason: null, ...summary };
}

function sniffFormat(bytes: Uint8Array, fileName: string): Format {
  const head = Buffer.from(bytes.subarray(0, 8));
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return "xlsx";
  if (head.toString("hex") === "d0cf11e0a1b11ae1") {
    throw new ApiError(
      400,
      "IMPORT_FORMAT_UNSUPPORTED",
      `${fileName} is a legacy .xls workbook. Save it as .xlsx and upload again.`,
    );
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!text.includes("\u0000") && looksLikeDelimitedText(text)) return "csv";
  throw new ApiError(
    400,
    "IMPORT_FORMAT_UNSUPPORTED",
    `${fileName} is not a PDF, an .xlsx workbook, or a CSV statement.`,
  );
}

function looksLikeDelimitedText(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, 8);
  return lines.length >= 2 && lines.some((line) => /[,;\t]/.test(line));
}

async function readBank(bytes: Uint8Array, format: Format, fileName: string) {
  if (format !== "pdf") {
    throw new ApiError(
      400,
      "IMPORT_FORMAT_UNSUPPORTED",
      `Bank uploads read PDF statements here. Save ${fileName} as CSV to use the CSV path.`,
    );
  }
  const text = await readPdf(bytes, fileName);
  const statement = parseBankStatement(text);
  if (statement.rows.length === 0 && statement.periodStart === null) {
    throw new ApiError(
      400,
      "IMPORT_LAYOUT_UNKNOWN",
      `${fileName} has readable text, but not in the Banco Popular statement layout this parser reads. No rows were stored.`,
    );
  }
  const hashable = statement.rows.map((row) => ({
    rowNo: String(row.rowNo),
    date: row.date,
    description: row.description,
    reference: row.reference,
    amount: row.amount,
    section: row.section,
  }));
  return {
    rowsHash: hashMaterial(hashable),
    sourceRows: statement.rows.map((row) => ({ rowNo: row.rowNo, payload: { ...row } })),
    view: { pages: text.pages, bank: bankView(statement) },
  };
}

function bankView(statement: BankStatement) {
  return {
    layout: statement.layout,
    periodStart: statement.periodStart,
    periodEnd: statement.periodEnd,
    accountNumber: statement.accountNumber,
    rows: statement.rows,
    skippedCount: statement.skipped.length,
    skipped: statement.skipped.slice(0, 25),
    totalChecks: statement.totalChecks,
  };
}

async function readStatements(bytes: Uint8Array, format: Format, fileName: string) {
  let book: StatementWorkbook;
  try {
    if (format === "pdf") book = parseStatementPdf(await readPdf(bytes, fileName), fileName);
    else if (format === "csv")
      book = parseStatementCsv(new TextDecoder("utf-8", { fatal: false }).decode(bytes), fileName);
    else book = parseStatementWorkbook(readWorkbook(bytes), fileName);
  } catch (error) {
    if (error instanceof WorkbookError)
      throw new ApiError(400, "IMPORT_UNREADABLE", `${fileName}: ${error.message}`);
    throw error;
  }
  if (book.sheets.length === 0) {
    const reasons = book.skippedSheets
      .map((sheet) => `${sheet.sheetName}: ${sheet.reason}`)
      .join("; ");
    throw new ApiError(
      400,
      "IMPORT_NO_STATEMENT",
      `${fileName} has no income statement or balance sheet this parser can read${reasons ? ` (${reasons})` : ""}. Nothing was stored.`,
    );
  }
  const sourceRows: { rowNo: number; payload: Record<string, unknown> }[] = [];
  for (const sheet of book.sheets) {
    for (const line of sheet.lines) {
      sourceRows.push({
        rowNo: sourceRows.length + 1,
        payload: { sheetName: sheet.sheetName, statementType: sheet.statementType, ...line },
      });
    }
  }
  const hashable = sourceRows.map((row) => ({
    rowNo: String(row.rowNo),
    sheetName: String(row.payload.sheetName),
    label: String(row.payload.label),
    values: (row.payload.values as readonly { period: string; amount: string }[]).map((value) => ({
      period: value.period,
      amount: value.amount,
    })),
  }));
  return {
    rowsHash: hashMaterial(hashable),
    sourceRows,
    view: {
      statements: {
        sheets: book.sheets.map((sheet) => {
          const valued = sheet.lines.filter((line) => line.values.length > 0);
          return {
            sheetName: sheet.sheetName,
            statementType: sheet.statementType,
            periodCount: sheet.periods.length,
            firstPeriod: sheet.periods[0]?.label ?? null,
            lastPeriod: sheet.periods[sheet.periods.length - 1]?.label ?? null,
            derivedPeriods: sheet.periods
              .filter((period) => period.derived)
              .map((period) => period.label),
            lineCount: sheet.lines.length,
            valuedLineCount: valued.length,
            valueCount: valued.reduce((sum, line) => sum + line.values.length, 0),
            skippedRows: sheet.skippedRows,
            skippedCells: sheet.skippedCells,
          };
        }),
        skippedSheets: book.skippedSheets,
      },
    },
  };
}

async function readPdf(bytes: Uint8Array, fileName: string) {
  try {
    const text = await extractPdfText(bytes);
    if (text.textItems === 0) {
      throw new ApiError(
        400,
        "IMPORT_NO_TEXT",
        `${fileName} has no text layer (it looks like a scanned image). This kernel does not run OCR, so nothing was read or stored.`,
      );
    }
    return text;
  } catch (error) {
    if (error instanceof PdfReadError)
      throw new ApiError(400, "IMPORT_UNREADABLE", `${fileName}: ${error.message}`);
    throw error;
  }
}

async function scope(store: LedgerStore, actor: ActorContext) {
  if (actor.actorId.length === 0 || actor.region.length === 0 || !actor.tenantId) {
    throw new KernelError("AUTH_SCOPE_DENIED", "Actor, region, and tenant are required");
  }
  const tenant = await store.getTenant(actor.tenantId);
  if (!tenant) {
    throw new KernelError("FIN_NOT_FOUND", "Tenant not found");
  }
  assertSameRegion(tenant.homeRegion, actor.region);
  assertTenantActive(tenant.status);
  authorize(await store.listRoles(tenant.tenantId, actor.actorId), "import.write");
  return tenant;
}
