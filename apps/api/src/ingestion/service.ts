import { createHash } from "node:crypto";

import {
  isUniqueViolation,
  type IngestionPostCommit,
  type LedgerPostSnapshot,
  type LedgerStore,
} from "@nexora/db";
import {
  AnalyticalDecimal,
  ENGINE_VERSION,
  INGESTION_FORMULA_VERSION,
  KernelError,
  MAPPING_AUTO_ACCEPT_CONFIDENCE,
  assertSameRegion,
  assertTenantActive,
  authorize,
  buildLinkedModel,
  canonicalAccount,
  suggestedReviewCashFlow,
  cumulativeLedgerBalances,
  currencyScale,
  formatMinor,
  mapLineLabel,
  mappingIsAutoAcceptable,
  moneyFromDecimal,
  runIngestionChecks,
  validateJournal,
  type AmountScale,
  type IngestionAmount,
  type IngestionCheckInput,
  type IngestionSeverity,
} from "@nexora/kernel";

import { createLedgerService } from "../service.js";
import {
  openingSourceRef,
  isOpeningPeriod,
  openingPlacementAllowed,
  OPENING_PLACEMENT_MESSAGE,
} from "../classify-activity.js";
import {
  ParserError,
  normalizePeriod,
  selectDocumentParser,
  type ParsedCell,
  type ParsedDocument,
} from "../imports/document-parser.js";
import type { ActorContext } from "../http.js";
import type { MappingProposer } from "./proposer.js";

const SCALE_FACTOR: Record<AmountScale, string> = {
  units: "1",
  thousands: "1000",
  millions: "1000000",
  lakhs: "100000",
  crores: "10000000",
};

export interface UploadFile {
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

interface StoredValue {
  valueId: string;
  documentId: string;
  statementType: string;
  role: string;
  label: string;
  periodKey: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  spanMonths: number;
  currency: string | null;
  scale: string;
  amountMinor: string | null;
  rawText: string;
  page: number | null;
  sheet: string | null;
  rowNo: number | null;
  colNo: number | null;
  bbox: Record<string, unknown> | null;
  accountCode: string | null;
  mappingConfidence: string | null;
  mappingMethod: string | null;
  mappingAccepted: boolean;
  contra: boolean;
  balanceKind: string;
  sortOrder: number;
  fileName?: string;
}

export function createIngestionService(
  store: LedgerStore,
  platformAdminActorIds: readonly string[],
  proposer: MappingProposer,
) {
  const ledger = createLedgerService(store, platformAdminActorIds);
  return {
    upload: (actor: ActorContext, input: { entityId: string; files: readonly UploadFile[] }) =>
      upload(store, ledger, proposer, actor, input),
    getJob: (actor: ActorContext, jobId: string) => presentJob(store, actor, jobId),
    getValues: (actor: ActorContext, jobId: string) => presentValues(store, actor, jobId),
    getExceptions: (
      actor: ActorContext,
      jobId: string,
      filter: { severity?: string; type?: string; documentId?: string },
    ) => presentExceptions(store, actor, jobId, filter),
    resolve: (
      actor: ActorContext,
      exceptionId: string,
      input: { action: string; note: string; amount?: string; accountCode?: string },
    ) => resolveException(store, ledger, proposer, actor, exceptionId, input),
    bulkAccept: (actor: ActorContext, input: { jobId: string; minConfidence: string }) =>
      bulkAccept(store, ledger, proposer, actor, input),
  };
}

async function upload(
  store: LedgerStore,
  ledger: ReturnType<typeof createLedgerService>,
  proposer: MappingProposer,
  actor: ActorContext,
  input: { entityId: string; files: readonly UploadFile[] },
) {
  const tenant = await scope(store, actor, "import.write");
  if (input.files.length === 0) {
    throw new KernelError("FIN_INVALID_JOURNAL_LINE", "Upload at least one file");
  }
  const entity = await store.getEntity(tenant.tenantId, input.entityId);
  if (!entity) throw new KernelError("FIN_NOT_FOUND", "Entity not found");
  const hashes = input.files.map((file) => sha256(file.bytes)).join(",");
  const digest = contentDigest(input.files);
  const sameContent = await store.findIngestionJobByContent(
    tenant.tenantId,
    entity.entityId,
    digest,
  );
  if (sameContent?.status === "posted") return presentJob(store, actor, sameContent.jobId);
  if (sameContent) {
    await revalidate(
      store,
      ledger,
      proposer,
      actor,
      sameContent.jobId,
      entity.entityId,
      entity.functionalCurrency,
    );
    return presentJob(store, actor, sameContent.jobId);
  }
  if (actor.idempotencyKey) {
    const existing = await store.findIngestionJobByKey(tenant.tenantId, actor.idempotencyKey);
    if (existing) {
      const documents = await store.listSourceDocuments(tenant.tenantId, existing.jobId);
      const prior = documents.map((document) => document.sha256).join(",");
      if (prior !== hashes) {
        throw new KernelError(
          "FIN_IDEMPOTENCY_MISMATCH",
          "Idempotency key was reused with different files",
        );
      }
      return presentJob(store, actor, existing.jobId);
    }
  }

  const now = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const yearEnd = yearEndOf(entity);
  try {
    await store.insertIngestionJob({
      tenantId: tenant.tenantId,
      jobId,
      entityId: entity.entityId,
      status: "extracting",
      currency: entity.functionalCurrency,
      idempotencyKey: actor.idempotencyKey,
      contentHash: digest,
      actorId: actor.actorId,
      createdAt: now,
      audit: audit(actor, "IngestionJobCreated", jobId, now, {
        fileCount: String(input.files.length),
        entityId: entity.entityId,
      }),
    });
  } catch (error) {
    const conflict = ingestionUploadConflict(error);
    if (conflict) throw conflict;
    throw error;
  }

  for (const file of input.files) {
    const documentId = crypto.randomUUID();
    if (file.bytes.length === 0) {
      await store.insertSourceDocument({
        tenantId: tenant.tenantId,
        documentId,
        jobId,
        fileName: file.fileName,
        mediaType: file.mediaType,
        byteLength: 0,
        sha256: sha256(file.bytes),
        parserId: null,
        status: "failed",
        error: "File is empty",
        parseIssues: [],
        statementKinds: "",
        createdAt: now,
      });
      continue;
    }
    try {
      const parser = selectDocumentParser(file.fileName, file.bytes);
      const parsed = await resolveLayout(
        proposer,
        file.fileName,
        file.bytes,
        await parser.parse({
          fileName: file.fileName,
          bytes: file.bytes,
          yearEnd,
          functionalCurrency: entity.functionalCurrency,
        }),
      );
      const values = parsed.cells.map((cell, index) =>
        toStoredValue(cell, crypto.randomUUID(), documentId, entity.functionalCurrency, index),
      );
      await store.insertSourceDocument({
        tenantId: tenant.tenantId,
        documentId,
        jobId,
        fileName: file.fileName,
        mediaType: file.mediaType,
        byteLength: file.bytes.length,
        sha256: sha256(file.bytes),
        parserId: parser.id,
        status: "parsed",
        error: null,
        parseIssues: parsed.issues.map((issue) => ({
          code: issue.code,
          message: issue.message,
          raw: issue.raw,
          page: issue.page,
        })),
        statementKinds: [...new Set(values.map((value) => value.statementType))].join(","),
        createdAt: now,
      });
      await store.insertExtractedValues(tenant.tenantId, jobId, values);
    } catch (error) {
      const message = error instanceof ParserError ? error.message : "The file could not be read";
      await store.insertSourceDocument({
        tenantId: tenant.tenantId,
        documentId,
        jobId,
        fileName: file.fileName,
        mediaType: file.mediaType,
        byteLength: file.bytes.length,
        sha256: sha256(file.bytes),
        parserId: null,
        status: "failed",
        error: message,
        parseIssues: [],
        statementKinds: "",
        createdAt: now,
      });
    }
  }

  await revalidate(
    store,
    ledger,
    proposer,
    actor,
    jobId,
    entity.entityId,
    entity.functionalCurrency,
  );
  return presentJob(store, actor, jobId);
}

async function revalidate(
  store: LedgerStore,
  _ledger: ReturnType<typeof createLedgerService>,
  proposer: MappingProposer,
  actor: ActorContext,
  jobId: string,
  entityId: string,
  currency: string,
) {
  const tenantId = actor.tenantId;
  if (!tenantId) throw new KernelError("AUTH_SCOPE_DENIED", "Tenant scope is required");
  await store.updateIngestionJob({
    tenantId,
    jobId,
    status: "mapping",
    currency,
    formulaVersion: INGESTION_FORMULA_VERSION,
    inputHash: null,
    outputHash: null,
    modelPayload: (await store.getIngestionJob(tenantId, jobId))?.modelPayload ?? null,
    updatedAt: new Date().toISOString(),
  });
  const documents = await store.listSourceDocuments(tenantId, jobId);
  const names = new Map(documents.map((document) => [document.documentId, document.fileName]));
  let values = await store.listExtractedValues(tenantId, jobId);
  const mappings: {
    mappingId: string;
    valueId: string;
    accountCode: string;
    confidence: string;
    method: string;
    accepted: boolean;
    createdAt: string;
  }[] = [];
  const mappingExceptions: {
    exceptionId: string;
    documentId: string | null;
    type: string;
    severity: IngestionSeverity;
    message: string;
    expected: string | null;
    actual: string | null;
    diff: string | null;
    provenance: Record<string, unknown>;
    status: string;
    createdAt: string;
  }[] = [];
  const now = new Date().toISOString();
  for (const value of values) {
    if (value.statementType === "bank" || value.role === "heading" || value.mappingMethod) continue;
    const deterministic = mapLineLabel(value.label);
    const proposal =
      deterministic ??
      (await proposer.propose({
        label: value.label,
        statementType: value.statementType,
        rawText: value.rawText,
      }));
    if (!proposal) {
      mappingExceptions.push({
        exceptionId: crypto.randomUUID(),
        documentId: value.documentId,
        type: "mapping_low_confidence",
        severity: "error",
        message: `${value.label} has no accepted map. Document-embedded confidence is ignored.`,
        expected: MAPPING_AUTO_ACCEPT_CONFIDENCE,
        actual: null,
        diff: null,
        provenance: provenanceFor([value], names),
        status: "open",
        createdAt: now,
      });
      continue;
    }
    const confidence = "confidence" in proposal ? proposal.confidence : deterministic?.confidence;
    const accountCode = proposal.accountCode;
    const method = deterministic ? deterministic.method : "ai";
    const accepted = deterministic !== null && mappingIsAutoAcceptable(confidence ?? "0");
    const contra = deterministic?.contra === true || canonicalAccount(accountCode)?.contra === true;
    await store.updateExtractedValue({
      tenantId,
      valueId: value.valueId,
      accountCode,
      mappingConfidence: confidence ?? "0",
      mappingMethod: method,
      mappingAccepted: accepted,
      contra,
    });
    mappings.push({
      mappingId: crypto.randomUUID(),
      valueId: value.valueId,
      accountCode,
      confidence: confidence ?? "0",
      method,
      accepted,
      createdAt: now,
    });
  }
  if (mappings.length > 0) await store.insertAccountMappings(tenantId, jobId, mappings);
  values = await store.listExtractedValues(tenantId, jobId);

  const existing = await store.listIngestionExceptions(tenantId, jobId);
  const suppressed = new Set(
    existing
      .filter(
        (exception) => exception.status === "accepted" || exception.status === "not_applicable",
      )
      .map((exception) => exceptionKey(exception.type, valueIdsOf(exception.provenance))),
  );
  const skipped = new Set(
    existing
      .filter((exception) => exception.status === "not_applicable")
      .flatMap((exception) => valueIdsOf(exception.provenance)),
  );
  const checkInput = toCheckInput(values, documents, currency, skipped);
  const report = runIngestionChecks(checkInput);
  const checkExceptions = report.checks.flatMap((check) =>
    check.failures
      .filter((failure) => !suppressed.has(exceptionKey(failure.checkId, [...failure.valueIds])))
      .map((failure) => ({
        exceptionId: crypto.randomUUID(),
        documentId:
          values.find((value) => value.valueId === failure.valueIds[0])?.documentId ?? null,
        type: failure.checkId,
        severity: failure.severity,
        message: failure.message,
        expected: failure.expected,
        actual: failure.actual,
        diff: failure.diff,
        provenance: provenanceFor(
          values.filter((value) => failure.valueIds.includes(value.valueId)),
          names,
        ),
        status: "open",
        createdAt: now,
      })),
  );
  for (const value of values) {
    if (value.statementType === "bank" || value.role !== "line" || value.mappingAccepted) continue;
    if (!value.mappingMethod || !value.accountCode) continue;
    if (suppressed.has(exceptionKey("mapping_low_confidence", [value.valueId]))) continue;
    const suggestion = suggestedReviewCashFlow(value.accountCode, value.label);
    const suggestionText =
      suggestion === "cfi"
        ? " Map it to a deposit or a loan given."
        : suggestion === "cff"
          ? " Map it to a borrowing."
          : suggestion === "cfo"
            ? " Map it to a long-term provision."
            : "";
    mappingExceptions.push({
      exceptionId: crypto.randomUUID(),
      documentId: value.documentId,
      type: "mapping_low_confidence",
      severity: "error",
      message: `${value.label} mapped to ${value.accountCode} at confidence ${value.mappingConfidence ?? "0"}, below ${MAPPING_AUTO_ACCEPT_CONFIDENCE}.${suggestionText}`,
      expected: MAPPING_AUTO_ACCEPT_CONFIDENCE,
      actual: value.mappingConfidence,
      diff: null,
      provenance: provenanceFor([value], names),
      status: "open",
      createdAt: now,
    });
  }
  const parseExceptions = documents.flatMap((document) =>
    document.parseIssues.map((issue) => ({
      exceptionId: crypto.randomUUID(),
      documentId: document.documentId,
      type: issue.code,
      severity: "error" as const,
      message: issue.message,
      expected: null,
      actual: issue.raw,
      diff: null,
      provenance: {
        valueIds: [],
        documentId: document.documentId,
        page: issue.page,
        raw: issue.raw,
      },
      status: "open",
      createdAt: now,
    })),
  );
  const openExceptions = [...checkExceptions, ...mappingExceptions, ...parseExceptions];
  await store.replaceOpenCheckExceptions(tenantId, jobId, openExceptions);
  const blocking = openExceptions.some((exception) => exception.severity === "error");
  const failedParse = documents.some((document) => document.status === "failed");
  if (blocking || failedParse || !report.passed) {
    await store.updateIngestionJob({
      tenantId,
      jobId,
      status: "needs_review",
      currency,
      formulaVersion: INGESTION_FORMULA_VERSION,
      inputHash: null,
      outputHash: null,
      modelPayload: (await store.getIngestionJob(tenantId, jobId))?.modelPayload ?? null,
      updatedAt: now,
    });
    return;
  }
  await postLinkedModel(store, actor, jobId, entityId, currency, checkInput);
}

export function ingestionUploadConflict(error: unknown): KernelError | null {
  if (!isUniqueViolation(error)) return null;
  return new KernelError(
    "FIN_IDEMPOTENCY_MISMATCH",
    "Another upload already claimed this idempotency key",
  );
}

function yearEndOf(entity: {
  readonly fiscalYearEndMonth: number | null;
  readonly fiscalYearEndDay: number | null;
}): { month: number; day: number } | null {
  if (entity.fiscalYearEndMonth === null || entity.fiscalYearEndDay === null) return null;
  return { month: entity.fiscalYearEndMonth, day: entity.fiscalYearEndDay };
}

function fiscalYearConflict(
  snapshot: LedgerPostSnapshot,
  amounts: readonly IngestionAmount[],
): string | null {
  const annual = amounts.filter(
    (amount) => amount.spanMonths >= 12 && amount.periodEnd.length >= 10,
  );
  if (annual.length === 0) return null;
  const org =
    snapshot.fiscalYearEndMonth !== null && snapshot.fiscalYearEndDay !== null
      ? `${String(snapshot.fiscalYearEndMonth).padStart(2, "0")}-${String(snapshot.fiscalYearEndDay).padStart(2, "0")}`
      : null;
  const existing = new Set(
    snapshot.periods
      .filter((period) => !isOpeningPeriod(period, snapshot.journals))
      .map((period) => period.endDate.slice(0, 10).slice(5)),
  );
  for (const amount of annual) {
    const monthDay = amount.periodEnd.slice(5, 10);
    if (org && monthDay !== org) {
      return `Period end ${amount.periodEnd} does not match the organisation fiscal year end`;
    }
    if (existing.size > 0 && !existing.has(monthDay)) {
      return `Period end ${amount.periodEnd} does not match the ledger's existing period ends`;
    }
  }
  return null;
}

async function postLinkedModel(
  store: LedgerStore,
  actor: ActorContext,
  jobId: string,
  entityId: string,
  currency: string,
  checkInput: IngestionCheckInput,
) {
  const tenantId = actor.tenantId;
  if (!tenantId) throw new KernelError("AUTH_SCOPE_DENIED", "Tenant scope is required");
  const canonicalHash = canonicalDigest(entityId, checkInput.amounts);
  const already = await store.findPostedIngestionByCanonical(tenantId, entityId, canonicalHash);
  await scope(store, actor, "journal.post");
  const now = new Date().toISOString();
  try {
    const outcome = await store.runLockedIngestionPost(tenantId, entityId, async (snapshot) => {
      const openingDate = checkInput.amounts
        .filter(
          (amount) =>
            amount.statement === "balance_sheet" &&
            amount.balanceKind === "closing" &&
            amount.role === "line",
        )
        .map((amount) => amount.periodEnd)
        .sort()[0];
      const overlappingIncome = openingDate
        ? checkInput.amounts.find(
            (amount) =>
              amount.statement === "income_statement" &&
              amount.periodEnd > openingDate &&
              amount.periodStart &&
              amount.periodStart <= openingDate,
          )
        : undefined;
      if (openingDate && overlappingIncome?.periodStart) {
        const nextDay = new Date(`${openingDate}T00:00:00Z`);
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        const displayDate = (date: string) =>
          new Intl.DateTimeFormat("en-GB", {
            day: "numeric",
            month: "short",
            timeZone: "UTC",
          }).format(new Date(`${date}T00:00:00Z`));
        return {
          action: "block" as const,
          message: `This income statement starts on ${displayDate(overlappingIncome.periodStart)}, before your opening balances on ${displayDate(openingDate)}. Upload figures from ${displayDate(nextDay.toISOString().slice(0, 10))} onwards, or replace your opening balances.`,
        };
      }
      const conflict = fiscalYearConflict(snapshot, checkInput.amounts);
      if (conflict) return { action: "block" as const, message: conflict };
      const postedBalances = cumulativeLedgerBalances({
        periods: snapshot.periods.map((period) => ({
          periodId: period.periodId,
          endDate: period.endDate,
        })),
        accounts: snapshot.accounts.map((account) => ({
          accountId: account.accountId,
          code: account.code,
          report: account.report,
          retainedEarnings: account.accountId === snapshot.retainedEarningsAccountId,
        })),
        journals: snapshot.journals.map((journal) => ({
          periodId: journal.periodId,
          lines: journal.lines.map((line) => ({
            accountId: line.accountId,
            debitMinor: line.debitMinor,
            creditMinor: line.creditMinor,
          })),
        })),
      });
      const built = buildLinkedModel({
        ...checkInput,
        postedBalances,
        fiscalYearEnd: yearEndOf(snapshot),
      });
      if (!built.ok) return { action: "block" as const, message: built.message };
      if (already && already.jobId !== jobId) {
        return {
          action: "replay" as const,
          formulaVersion: built.model.formulaVersion,
          inputHash: built.model.inputHash,
          outputHash: built.model.outputHash,
          modelPayload: already.modelPayload ?? { canonicalHash, linkedJobId: already.jobId },
        };
      }
      if (built.model.journals.length === 0) {
        return {
          action: "empty" as const,
          formulaVersion: built.model.formulaVersion,
          inputHash: built.model.inputHash,
          outputHash: built.model.outputHash,
        };
      }
      const byCode = new Map(snapshot.accounts.map((account) => [account.code, account.accountId]));
      const retained = snapshot.accounts.find(
        (account) => account.accountId === snapshot.retainedEarningsAccountId,
      );
      if (retained) byCode.set("retained_earnings", retained.accountId);
      const newAccounts: IngestionPostCommit["accounts"][number][] = [];
      for (const code of new Set(
        built.model.journals.flatMap((journal) => journal.lines.map((line) => line.accountCode)),
      )) {
        if (byCode.has(code)) continue;
        const account = canonicalAccount(code);
        if (!account) throw new KernelError("FIN_NOT_FOUND", `No canonical account for ${code}`);
        const accountId = crypto.randomUUID();
        byCode.set(code, accountId);
        newAccounts.push({
          accountId,
          code,
          name: account.name,
          report: account.report,
          cashFlow: account.cashFlow,
          retainedEarnings: code === "retained_earnings" && !retained,
        });
      }
      const periodIdFor = new Map(
        snapshot.periods.map((period) => [
          `${period.startDate.slice(0, 10)}|${period.endDate.slice(0, 10)}`,
          period.periodId,
        ]),
      );
      const newPeriods: IngestionPostCommit["periods"][number][] = [];
      const scale = currencyScale(currency);
      const commitJournals: IngestionPostCommit["journals"][number][] = [];
      for (const journal of built.model.journals) {
        const key = `${journal.periodStart}|${journal.periodEnd}`;
        let periodId = periodIdFor.get(key);
        if (!periodId) {
          periodId = crypto.randomUUID();
          periodIdFor.set(key, periodId);
          newPeriods.push({ periodId, startDate: journal.periodStart, endDate: journal.periodEnd });
        }
        const journalKind = journal.kind === "opening" ? "opening" : "standard";
        if (
          journalKind === "opening" &&
          !openingPlacementAllowed(
            [...snapshot.periods, ...newPeriods],
            snapshot.journals,
            periodId,
          )
        ) {
          return { action: "block" as const, message: OPENING_PLACEMENT_MESSAGE };
        }
        const drafted = journal.lines.map((line) => {
          const accountId = byCode.get(line.accountCode);
          if (!accountId) {
            throw new KernelError("FIN_NOT_FOUND", `Account ${line.accountCode} was not created`);
          }
          return {
            accountId,
            debit: formatMinor(line.debitMinor, scale),
            credit: formatMinor(line.creditMinor, scale),
          };
        });
        const balanced = validateJournal({
          currency,
          entityId,
          periodId,
          lines: drafted.map((line) => ({
            accountId: line.accountId,
            debit: moneyFromDecimal(currency, line.debit),
            credit: moneyFromDecimal(currency, line.credit),
          })),
        });
        commitJournals.push({
          journalId: crypto.randomUUID(),
          periodId,
          journalKind,
          idempotencyKey: `ingestion:${entityId}:${canonicalHash}:${journal.kind}:${journal.periodEnd}`,
          payloadHash: balanced.payloadHash,
          sourceRef:
            journalKind === "opening"
              ? openingSourceRef(`ingestion:${jobId}`)
              : `ingestion:${jobId}`,
          domainEventId: crypto.randomUUID(),
          lines: balanced.lines.map((line, index) => ({
            lineId: crypto.randomUUID(),
            accountId: line.accountId,
            lineNo: index + 1,
            debitMinor: line.debitMinor,
            creditMinor: line.creditMinor,
          })),
        });
      }
      return {
        action: "write" as const,
        commit: {
          tenantId,
          entityId,
          jobId,
          currency,
          actorId: actor.actorId,
          correlationId: actor.correlationId,
          occurredAt: now,
          canonicalHash,
          formulaVersion: built.model.formulaVersion,
          inputHash: built.model.inputHash,
          outputHash: built.model.outputHash,
          netIncomeMinor: built.model.statements.incomeStatement.netIncomeMinor,
          modelPayload: { inputHash: built.model.inputHash, canonicalHash },
          engineVersion: ENGINE_VERSION,
          calculationRunId: crypto.randomUUID(),
          lineageEdgeId: crypto.randomUUID(),
          auditEventId: crypto.randomUUID(),
          accounts: newAccounts,
          periods: newPeriods,
          journals: commitJournals,
        },
      };
    });
    if (outcome.action === "block") {
      await failIngestionPost(store, tenantId, jobId, currency, outcome.message, now);
      return;
    }
    if (outcome.action === "replay" || outcome.action === "empty") {
      await store.updateIngestionJob({
        tenantId,
        jobId,
        status: "posted",
        currency,
        formulaVersion: outcome.formulaVersion,
        inputHash: outcome.inputHash,
        outputHash: outcome.outputHash,
        canonicalHash,
        modelPayload:
          outcome.action === "replay"
            ? outcome.modelPayload
            : { inputHash: outcome.inputHash, journals: [], canonicalHash },
        updatedAt: now,
      });
    }
  } catch (error) {
    await failIngestionPost(
      store,
      tenantId,
      jobId,
      currency,
      error instanceof Error ? error.message : "Ingestion post failed",
      new Date().toISOString(),
    );
  }
}

async function failIngestionPost(
  store: LedgerStore,
  tenantId: string,
  jobId: string,
  currency: string,
  message: string,
  now: string,
) {
  const values = await store.listExtractedValues(tenantId, jobId);
  const documents = await store.listSourceDocuments(tenantId, jobId);
  const names = new Map(documents.map((document) => [document.documentId, document.fileName]));
  const open = (await store.listIngestionExceptions(tenantId, jobId)).filter(
    (exception) => exception.status === "open",
  );
  await store.replaceOpenCheckExceptions(tenantId, jobId, [
    ...open.map((exception) => ({
      exceptionId: exception.exceptionId,
      documentId: exception.documentId,
      type: exception.type,
      severity: exception.severity as IngestionSeverity,
      message: exception.message,
      expected: exception.expected,
      actual: exception.actual,
      diff: exception.diff,
      provenance: exception.provenance,
      status: "open",
      createdAt: now,
    })),
    {
      exceptionId: crypto.randomUUID(),
      documentId: null,
      type: "model_incomplete",
      severity: "error" as const,
      message,
      expected: null,
      actual: null,
      diff: null,
      provenance: provenanceFor(values.slice(0, 1), names),
      status: "open",
      createdAt: now,
    },
  ]);
  await store.updateIngestionJob({
    tenantId,
    jobId,
    status: "needs_review",
    currency,
    formulaVersion: INGESTION_FORMULA_VERSION,
    inputHash: null,
    outputHash: null,
    modelPayload: (await store.getIngestionJob(tenantId, jobId))?.modelPayload ?? null,
    updatedAt: now,
  });
}

async function resolveLayout(
  proposer: MappingProposer,
  fileName: string,
  bytes: Uint8Array,
  parsed: ParsedDocument,
): Promise<ParsedDocument> {
  if (!parsed.issues.some((issue) => issue.code === "layout_unresolved")) return parsed;
  const proposal = await proposer.proposeExtraction({
    fileName,
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
  });
  if (!proposal || proposal.rows.length === 0) return parsed;
  const cells: ParsedCell[] = [];
  for (const row of proposal.rows) {
    const period = normalizePeriod(row.periodLabel, true, /march/i.test(row.periodLabel));
    if (!period) continue;
    cells.push({
      statementType: row.statementType,
      role: "line",
      label: row.label,
      sectionId: "proposed",
      periodKey: period.periodKey,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      spanMonths: period.spanMonths,
      amount: row.amount,
      rawText: row.amount,
      page: null,
      sheet: null,
      row: null,
      col: null,
      bbox: null,
      balanceKind: row.statementType === "balance_sheet" ? "closing" : "movement",
      currency: null,
      scale: "units",
      txnDate: null,
    });
  }
  if (cells.length === 0) return parsed;
  return {
    ...parsed,
    cells,
    // A proposal has not established provenance, scale or header semantics.
    // Preserve the deterministic blocker; kernel arithmetic cannot validate
    // whether an AI-proposed source value was actually printed in the file.
    issues: parsed.issues,
  };
}

function signedMinor(minor: string, contra: boolean): string {
  if (!contra) return minor;
  const decimal = new AnalyticalDecimal(minor);
  return decimal.gt(0) ? decimal.neg().toFixed(0) : minor;
}

function canonicalDigest(entityId: string, amounts: readonly IngestionAmount[]): string {
  const lines = amounts
    .filter((amount) => amount.accountCode && amount.role === "line")
    .map((amount) =>
      [
        entityId,
        amount.statement,
        amount.periodEnd,
        amount.accountCode,
        amount.balanceKind,
        amount.minor,
      ].join("|"),
    )
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function exceptionKey(type: string, valueIds: readonly string[]): string {
  return `${type}|${[...valueIds].sort().join(",")}`;
}

function valueIdsOf(provenance: Record<string, unknown>): string[] {
  const ids = provenance["valueIds"];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

function toStoredValue(
  cell: ParsedCell,
  valueId: string,
  documentId: string,
  fallbackCurrency: string,
  order: number,
) {
  const currency = cell.currency ?? fallbackCurrency;
  const scale = isScale(cell.scale) ? cell.scale : "units";
  const contra = /accumulated depreciation|provision for depreciation/i.test(cell.label);
  let amountMinor: string | null;
  try {
    amountMinor = decimalToMinor(cell.amount, currency, scale, contra);
  } catch {
    amountMinor = null;
  }
  return {
    valueId,
    documentId,
    statementType: cell.statementType,
    role: cell.role,
    label: cell.label,
    periodKey: cell.txnDate ?? cell.periodKey,
    periodStart: cell.periodStart,
    periodEnd: cell.periodEnd,
    spanMonths: cell.spanMonths,
    currency,
    scale,
    amountMinor,
    rawText: cell.rawText,
    page: cell.page,
    sheet: cell.sheet,
    rowNo: cell.row,
    colNo: cell.col,
    bbox: cell.bbox
      ? { x0: cell.bbox.x0, y0: cell.bbox.y0, x1: cell.bbox.x1, y1: cell.bbox.y1 }
      : null,
    accountCode: null,
    mappingConfidence: null,
    mappingMethod: null,
    mappingAccepted: false,
    contra,
    balanceKind: cell.balanceKind,
    sortOrder: order,
    sectionId: cell.sectionId,
  };
}

export function decimalToMinor(
  amount: string,
  currency: string,
  scale: AmountScale,
  contra: boolean,
): string {
  let decimal = new AnalyticalDecimal(amount).mul(SCALE_FACTOR[scale]);
  if (contra && decimal.gt(0)) decimal = decimal.neg();
  if (decimal.decimalPlaces() > currencyScale(currency))
    throw new Error("Source amount has sub-minor precision; confirm before posting");
  return moneyFromDecimal(currency, decimal.toFixed(currencyScale(currency))).minor;
}

function isScale(value: string): value is AmountScale {
  return (
    value === "units" ||
    value === "thousands" ||
    value === "millions" ||
    value === "lakhs" ||
    value === "crores"
  );
}

function toCheckInput(
  values: readonly StoredValue[],
  documents: readonly { documentId: string; sha256: string; fileName: string }[],
  currency: string,
  skipped: ReadonlySet<string>,
): IngestionCheckInput {
  const statementValues = values.filter(
    (value) => value.statementType !== "bank" && !skipped.has(value.valueId) && value.amountMinor,
  );
  const monthly =
    statementValues.length > 0 && statementValues.every((value) => value.spanMonths === 1);
  const periodEnds = statementValues
    .map((value) => value.periodEnd)
    .filter((period): period is string => Boolean(period))
    .sort();
  const periodStarts = statementValues
    .map((value) => value.periodStart)
    .filter((period): period is string => Boolean(period))
    .sort();
  const amounts: IngestionAmount[] = [];
  for (const value of statementValues) {
    if (!value.periodEnd || !value.periodStart || !value.amountMinor || !value.currency) continue;
    if (value.role !== "line" && value.role !== "subtotal" && value.role !== "total") continue;
    if (
      value.balanceKind !== "closing" &&
      value.balanceKind !== "opening" &&
      value.balanceKind !== "movement"
    ) {
      continue;
    }
    amounts.push({
      valueId: value.valueId,
      documentId: value.documentId,
      statement: value.statementType === "income_statement" ? "income_statement" : "balance_sheet",
      role: value.role,
      accountCode: value.mappingAccepted ? value.accountCode : null,
      label: value.label,
      periodEnd: value.periodEnd,
      periodStart: value.periodStart,
      spanMonths: value.spanMonths,
      currency: value.currency,
      scale: isScale(value.scale) ? value.scale : "units",
      minor: signedMinor(value.amountMinor, value.contra),
      contra: value.contra,
      balanceKind: value.balanceKind,
      order: value.sortOrder,
    });
  }
  const banks = documents
    .map((document) => {
      const rows = values.filter(
        (value) => value.documentId === document.documentId && value.statementType === "bank",
      );
      const opening = rows.find((row) => row.balanceKind === "opening");
      const closing = rows.find((row) => row.balanceKind === "closing");
      const periodStart = opening?.periodStart ?? null;
      const periodEnd = closing?.periodEnd ?? null;
      if (!opening?.amountMinor || !closing?.amountMinor || !periodStart || !periodEnd) {
        return null;
      }
      return {
        documentId: document.documentId,
        currency: opening.currency ?? currency,
        periodStart,
        periodEnd,
        openingMinor: opening.amountMinor,
        closingMinor: closing.amountMinor,
        openingValueId: opening.valueId,
        closingValueId: closing.valueId,
        transactions: rows
          .filter((row) => row.balanceKind === "movement" && row.amountMinor && row.periodKey)
          .map((row) => ({
            valueId: row.valueId,
            date: row.periodKey ?? periodEnd,
            description: row.label,
            minor: row.amountMinor ?? "0",
            fingerprint: `${row.periodKey}|${row.label}|${row.amountMinor}`,
          })),
      };
    })
    .filter((bank): bank is NonNullable<typeof bank> => bank !== null);
  const hasIncome = amounts.some((amount) => amount.statement === "income_statement");
  const hasBalance = amounts.some((amount) => amount.statement === "balance_sheet");
  const mandatory = [
    ...(hasIncome ? ["revenue"] : []),
    ...(hasBalance ? ["cash", "retained_earnings"] : []),
  ];
  return {
    currency,
    toleranceMinor: "0",
    amounts,
    banks,
    documents: documents.map((document) => ({
      documentId: document.documentId,
      fingerprint: document.sha256,
      fileName: document.fileName,
    })),
    coverage:
      monthly && periodStarts[0] && periodEnds[periodEnds.length - 1]
        ? {
            start: periodStarts[0],
            end: periodEnds[periodEnds.length - 1] ?? periodStarts[0],
            cadence: "monthly",
          }
        : null,
    mandatoryCodes: mandatory,
  };
}

function provenanceFor(
  values: readonly StoredValue[],
  names: ReadonlyMap<string, string>,
): Record<string, unknown> {
  return {
    valueIds: values.map((value) => value.valueId),
    locations: values.map((value) => ({
      fileName: names.get(value.documentId) ?? "",
      page: value.page,
      sheet: value.sheet,
      row: value.rowNo,
      col: value.colNo,
      bbox: value.bbox,
      rawText: value.rawText,
    })),
  };
}

async function presentJob(store: LedgerStore, actor: ActorContext, jobId: string) {
  await scope(store, actor, "statement.read");
  const tenantId = actor.tenantId;
  if (!tenantId) throw new KernelError("AUTH_SCOPE_DENIED", "Tenant scope is required");
  const job = await store.getIngestionJob(tenantId, jobId);
  if (!job) throw new KernelError("FIN_NOT_FOUND", "Ingestion job not found");
  const documents = await store.listSourceDocuments(tenantId, jobId);
  const values = await store.listExtractedValues(tenantId, jobId);
  const exceptions = await store.listIngestionExceptions(tenantId, jobId);
  const open = exceptions.filter((exception) => exception.status === "open");
  return {
    jobId: job.jobId,
    entityId: job.entityId,
    status: job.status,
    currency: job.currency,
    formulaVersion: job.formulaVersion,
    inputHash: job.inputHash,
    outputHash: job.outputHash,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    documents: documents.map((document) => ({
      documentId: document.documentId,
      fileName: document.fileName,
      status: document.status,
      statementKinds: document.statementKinds.split(",").filter((kind) => kind.length > 0),
      error: document.error,
    })),
    counts: {
      documents: documents.length,
      values: values.length,
      exceptionsOpen: open.length,
      exceptionsError: open.filter((exception) => exception.severity === "error").length,
      exceptionsWarn: open.filter((exception) => exception.severity === "warn").length,
      exceptionsInfo: open.filter((exception) => exception.severity === "info").length,
    },
  };
}

async function presentValues(store: LedgerStore, actor: ActorContext, jobId: string) {
  const job = await presentJob(store, actor, jobId);
  const tenantId = actor.tenantId;
  if (!tenantId) throw new KernelError("AUTH_SCOPE_DENIED", "Tenant scope is required");
  const documents = await store.listSourceDocuments(tenantId, jobId);
  const names = new Map(documents.map((document) => [document.documentId, document.fileName]));
  const values = await store.listExtractedValues(tenantId, jobId);
  return {
    jobId: job.jobId,
    values: values.map((value) => ({
      valueId: value.valueId,
      documentId: value.documentId,
      statementType: value.statementType,
      role: value.role,
      label: value.label,
      periodKey: value.periodKey,
      periodEnd: value.periodEnd,
      currency: value.currency,
      scale: value.scale,
      minor: value.amountMinor,
      accountCode: value.accountCode,
      mappingConfidence: value.mappingConfidence,
      mappingMethod: value.mappingMethod,
      mappingAccepted: value.mappingAccepted,
      provenance: {
        fileName: names.get(value.documentId) ?? "",
        page: value.page,
        sheet: value.sheet,
        row: value.rowNo,
        col: value.colNo,
        bbox: bboxOrNull(value.bbox),
        rawText: value.rawText,
      },
    })),
  };
}

function bboxOrNull(value: Record<string, unknown> | null) {
  if (!value) return null;
  const x0 = value["x0"];
  const y0 = value["y0"];
  const x1 = value["x1"];
  const y1 = value["y1"];
  if (
    typeof x0 !== "number" ||
    typeof y0 !== "number" ||
    typeof x1 !== "number" ||
    typeof y1 !== "number"
  ) {
    return null;
  }
  return { x0, y0, x1, y1 };
}

async function presentExceptions(
  store: LedgerStore,
  actor: ActorContext,
  jobId: string,
  filter: { severity?: string; type?: string; documentId?: string },
) {
  await presentJob(store, actor, jobId);
  const tenantId = actor.tenantId;
  if (!tenantId) throw new KernelError("AUTH_SCOPE_DENIED", "Tenant scope is required");
  const documents = await store.listSourceDocuments(tenantId, jobId);
  const names = new Map(documents.map((document) => [document.documentId, document.fileName]));
  const values = await store.listExtractedValues(tenantId, jobId);
  const exceptions = (await store.listIngestionExceptions(tenantId, jobId)).filter((exception) => {
    if (filter.severity && exception.severity !== filter.severity) return false;
    if (filter.type && exception.type !== filter.type) return false;
    if (filter.documentId && exception.documentId !== filter.documentId) return false;
    return true;
  });
  return {
    jobId,
    exceptions: exceptions.map((exception) => {
      const ids = valueIdsOf(exception.provenance);
      const linked = values.filter((value) => ids.includes(value.valueId));
      const resolution = exception.resolution;
      return {
        id: exception.exceptionId,
        jobId,
        documentId: exception.documentId,
        type: exception.type,
        severity: exception.severity,
        message: exception.message,
        values: {
          expected: exception.expected,
          actual: exception.actual,
          diff: exception.diff,
        },
        provenance: provenanceFor(linked, names),
        status: exception.status,
        resolution:
          resolution && typeof resolution["by"] === "string"
            ? {
                by: String(resolution["by"]),
                at: String(resolution["at"] ?? ""),
                note: String(resolution["note"] ?? ""),
                before: resolution["before"] === null ? null : String(resolution["before"] ?? ""),
                after: resolution["after"] === null ? null : String(resolution["after"] ?? ""),
              }
            : null,
      };
    }),
  };
}

async function resolveException(
  store: LedgerStore,
  ledger: ReturnType<typeof createLedgerService>,
  proposer: MappingProposer,
  actor: ActorContext,
  exceptionId: string,
  input: { action: string; note: string; amount?: string; accountCode?: string },
) {
  const tenant = await scope(store, actor, "import.write");
  const exception = await store.getIngestionException(tenant.tenantId, exceptionId);
  if (!exception) throw new KernelError("FIN_NOT_FOUND", "Exception not found");
  const valueId = valueIdsOf(exception.provenance)[0];
  const values = await store.listExtractedValues(tenant.tenantId, exception.jobId);
  const value = values.find((candidate) => candidate.valueId === valueId);
  const before = value?.amountMinor ?? value?.accountCode ?? null;
  let after: string | null = null;
  if (input.action === "correct") {
    if (!value?.currency || !input.amount) {
      throw new KernelError("FIN_AMOUNT_SCALE", "Corrected amount is required");
    }
    after = decimalToMinor(
      input.amount,
      value.currency,
      isScale(value.scale) ? value.scale : "units",
      value.contra,
    );
    await store.updateExtractedValue({
      tenantId: tenant.tenantId,
      valueId: value.valueId,
      amountMinor: after,
    });
  } else if (input.action === "remap") {
    if (!value || !input.accountCode) {
      throw new KernelError("FIN_INVALID_JOURNAL_LINE", "Account code is required");
    }
    const account = canonicalAccount(input.accountCode);
    after = input.accountCode;
    await store.updateExtractedValue({
      tenantId: tenant.tenantId,
      valueId: value.valueId,
      accountCode: input.accountCode,
      mappingConfidence: "1",
      mappingMethod: "manual",
      mappingAccepted: true,
      ...(account ? { contra: account.contra } : {}),
    });
  } else if (input.action === "accept" && exception.type === "mapping_low_confidence" && value) {
    after = value.accountCode;
    await store.updateExtractedValue({
      tenantId: tenant.tenantId,
      valueId: value.valueId,
      mappingAccepted: true,
      mappingConfidence: value.mappingConfidence ?? "1",
    });
  }
  const status =
    input.action === "correct"
      ? "corrected"
      : input.action === "remap"
        ? "remapped"
        : input.action === "not_applicable"
          ? "not_applicable"
          : "accepted";
  const now = new Date().toISOString();
  await store.resolveIngestionException({
    tenantId: tenant.tenantId,
    exceptionId,
    status,
    resolution: { by: actor.actorId, at: now, note: input.note, before, after },
    updatedAt: now,
    audit: audit(actor, "IngestionExceptionResolved", exceptionId, now, {
      action: input.action,
      jobId: exception.jobId,
    }),
  });
  const job = await store.getIngestionJob(tenant.tenantId, exception.jobId);
  if (!job) throw new KernelError("FIN_NOT_FOUND", "Ingestion job not found");
  await revalidate(store, ledger, proposer, actor, job.jobId, job.entityId, job.currency ?? "USD");
  return {
    exceptionId,
    status,
    job: await presentJob(store, actor, job.jobId),
  };
}

async function bulkAccept(
  store: LedgerStore,
  ledger: ReturnType<typeof createLedgerService>,
  proposer: MappingProposer,
  actor: ActorContext,
  input: { jobId: string; minConfidence: string },
) {
  const tenant = await scope(store, actor, "import.write");
  const job = await store.getIngestionJob(tenant.tenantId, input.jobId);
  if (!job) throw new KernelError("FIN_NOT_FOUND", "Ingestion job not found");
  const values = await store.listExtractedValues(tenant.tenantId, job.jobId);
  const exceptions = await store.listIngestionExceptions(tenant.tenantId, job.jobId);
  const now = new Date().toISOString();
  let accepted = 0;
  for (const exception of exceptions) {
    if (exception.type !== "mapping_low_confidence" || exception.status !== "open") continue;
    const valueId = valueIdsOf(exception.provenance)[0];
    const value = values.find((candidate) => candidate.valueId === valueId);
    if (!value?.mappingConfidence) continue;
    if (new AnalyticalDecimal(value.mappingConfidence).lt(input.minConfidence)) continue;
    await store.updateExtractedValue({
      tenantId: tenant.tenantId,
      valueId: value.valueId,
      mappingAccepted: true,
    });
    await store.resolveIngestionException({
      tenantId: tenant.tenantId,
      exceptionId: exception.exceptionId,
      status: "accepted",
      resolution: {
        by: actor.actorId,
        at: now,
        note: `Bulk accept at ${input.minConfidence}`,
        before: value.mappingConfidence,
        after: value.accountCode,
      },
      updatedAt: now,
      audit: audit(actor, "IngestionExceptionResolved", exception.exceptionId, now, {
        action: "bulk_accept",
        jobId: job.jobId,
      }),
    });
    accepted += 1;
  }
  await revalidate(store, ledger, proposer, actor, job.jobId, job.entityId, job.currency ?? "USD");
  return { jobId: job.jobId, accepted };
}

async function scope(
  store: LedgerStore,
  actor: ActorContext,
  action: "import.write" | "statement.read" | "journal.post",
) {
  if (!actor.tenantId) throw new KernelError("AUTH_SCOPE_DENIED", "Tenant scope is required");
  const tenant = await store.getTenant(actor.tenantId);
  if (!tenant) throw new KernelError("FIN_NOT_FOUND", "Tenant not found");
  assertSameRegion(tenant.homeRegion, actor.region);
  assertTenantActive(tenant.status);
  const roles = await store.listRoles(tenant.tenantId, actor.actorId);
  authorize(roles, action);
  return tenant;
}

function audit(
  actor: ActorContext,
  eventType: string,
  aggregateId: string,
  occurredAt: string,
  payload: Record<string, unknown>,
) {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    aggregateType: "ingestion_job",
    aggregateId,
    actorId: actor.actorId,
    correlationId: actor.correlationId,
    occurredAt,
    payload,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function contentDigest(files: readonly UploadFile[]): string {
  const parts = files
    .map((file) => sha256(file.bytes))
    .sort()
    .join("\n");
  return createHash("sha256").update(parts).digest("hex");
}
