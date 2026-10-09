import { KernelError } from "@nexora/kernel";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { AppDatabase } from "./client.js";
import {
  approval,
  capTableVersion,
  consolidationGroup,
  deal,
  debtTerms,
  eliminationEntry,
  financialState,
  fxRate,
  fxRateSet,
  holding,
  importBatch,
  instrument,
  lineageEdge,
  model,
  modelNode,
  modelVersion,
  ownershipEdge,
  proposal,
  reportPack,
  reportingBasis,
  scenario,
  sourceRow,
  valuation,
} from "./program-schema.js";
import type {
  ApprovalWrite,
  BasisWrite,
  CapTableWrite,
  DealWrite,
  EliminationWrite,
  FxRateSetWrite,
  ImportBatchWrite,
  LineageRow,
  LineageWrite,
  ModelVersionWrite,
  NamedWrite,
  OwnershipRow,
  OwnershipWrite,
  PayloadWrite,
  ProposalWrite,
  ReportPackWrite,
  ScenarioWrite,
  PublishableVersionRow,
  VersionRow,
  VersionWrite,
  AuditWrite,
  LedgerStore,
} from "./records.js";
import { auditEvent } from "./schema.js";

export function createProgramStore(db: AppDatabase) {
  return {
    insertFinancialState(input: VersionWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        if (input.supersedesId !== null) {
          throw new KernelError(
            "FIN_VERSION_CONFLICT",
            "Successors require an atomic financial-state transition",
          );
        }
        await tx.insert(financialState).values(stateValues(input));
        await writeAudit(tx, input.tenantId, input.audit);
        return { id: input.id };
      });
    },
    transitionFinancialStateAtomic(
      input: Parameters<LedgerStore["transitionFinancialStateAtomic"]>[0],
    ) {
      const { successor, approval: decision, lineage } = input;
      return tenantTx(db, successor.tenantId, async (tx) => {
        // financial_state is append-only: nexora_app has SELECT/INSERT, not the UPDATE
        // privilege required by FOR UPDATE. Serialize the immutable version's chain
        // with a transaction lock without changing grants or bypassing tenant RLS.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`financial_state:${successor.tenantId.toLowerCase()}:${successor.supersedesId?.toLowerCase()}`}, 0))`,
        );
        const [current] = await tx
          .select()
          .from(financialState)
          .where(
            and(
              eq(financialState.tenantId, successor.tenantId),
              eq(
                financialState.financialStateId,
                successor.supersedesId ?? "00000000-0000-0000-0000-000000000000",
              ),
            ),
          );
        if (!current) throw new KernelError("FIN_NOT_FOUND", "Financial state not found");
        const [existing] = await tx
          .select({ id: financialState.financialStateId })
          .from(financialState)
          .where(
            and(
              eq(financialState.tenantId, successor.tenantId),
              eq(financialState.supersedesId, current.financialStateId),
            ),
          )
          .limit(1);
        if (existing)
          throw new KernelError("FIN_VERSION_CONFLICT", "Financial state already has a successor");
        if (
          decision.tenantId !== successor.tenantId ||
          lineage.tenantId !== successor.tenantId ||
          decision.objectId !== successor.id ||
          lineage.fromId !== current.financialStateId ||
          lineage.toId !== successor.id
        ) {
          throw new KernelError(
            "TENANT_ISOLATION",
            "Transition records must share tenant and version scope",
          );
        }
        await tx.insert(financialState).values(stateValues(successor));
        await writeAudit(tx, successor.tenantId, successor.audit);
        await tx.insert(approval).values({
          approvalId: decision.approvalId,
          tenantId: decision.tenantId,
          objectType: decision.objectType,
          objectId: decision.objectId,
          actorId: decision.actorId,
          decision: decision.decision,
          policyVersion: decision.policyVersion,
          createdAt: decision.createdAt,
        });
        await writeAudit(tx, successor.tenantId, decision.audit);
        await tx.insert(lineageEdge).values({
          lineageEdgeId: lineage.lineageEdgeId,
          tenantId: lineage.tenantId,
          fromType: lineage.fromType,
          fromId: lineage.fromId,
          toType: lineage.toType,
          toId: lineage.toId,
          relation: lineage.relation,
          createdAt: lineage.createdAt,
        });
        await writeAudit(tx, successor.tenantId, lineage.audit);
        return { id: successor.id };
      });
    },
    getFinancialState(tenantId: string, financialStateId: string) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(financialState)
          .where(
            and(
              eq(financialState.tenantId, tenantId),
              eq(financialState.financialStateId, financialStateId),
            ),
          )
          .limit(1);
        const row = rows[0];
        return row
          ? {
              id: row.financialStateId,
              status: row.status,
              stateHash: row.stateHash,
              payload: row.payload,
              engineVersion: row.engineVersion,
              makerActorId: row.makerActorId,
              supersedesId: row.supersedesId,
              calculationStatus:
                row.calculationStatus === "succeeded"
                  ? ("succeeded" as const)
                  : ("failed" as const),
              calculationRunId: row.calculationRunId,
            }
          : null;
      });
    },
    insertApproval(input: ApprovalWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(approval).values({
          approvalId: input.approvalId,
          tenantId: input.tenantId,
          objectType: input.objectType,
          objectId: input.objectId,
          actorId: input.actorId,
          decision: input.decision,
          policyVersion: input.policyVersion,
          createdAt: input.createdAt,
        });
        await writeAudit(tx, input.tenantId, input.audit);
      });
    },
    insertLineage(input: LineageWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(lineageEdge).values({
          lineageEdgeId: input.lineageEdgeId,
          tenantId: input.tenantId,
          fromType: input.fromType,
          fromId: input.fromId,
          toType: input.toType,
          toId: input.toId,
          relation: input.relation,
          createdAt: input.createdAt,
        });
      });
    },
    listLineage(
      tenantId: string,
      fromType: string,
      fromId: string,
    ): Promise<readonly LineageRow[]> {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(lineageEdge)
          .where(
            and(
              eq(lineageEdge.tenantId, tenantId),
              eq(lineageEdge.fromType, fromType),
              eq(lineageEdge.fromId, fromId),
            ),
          );
        return rows.map((row) => ({
          fromType: row.fromType,
          fromId: row.fromId,
          toType: row.toType,
          toId: row.toId,
          relation: row.relation,
        }));
      });
    },
    insertFxRateSet(input: FxRateSetWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(fxRateSet).values({
          fxRateSetId: input.fxRateSetId,
          tenantId: input.tenantId,
          label: input.label,
          payload: { rates: input.rates },
          createdAt: input.createdAt,
        });
        for (const rate of input.rates) {
          await tx.insert(fxRate).values({
            fxRateId: rate.id,
            tenantId: input.tenantId,
            fxRateSetId: input.fxRateSetId,
            baseCurrency: rate.base,
            quoteCurrency: rate.quote,
            rateType: rate.rateType,
            rate: rate.rate,
            createdAt: input.createdAt,
          });
        }
        await writeAudit(tx, input.tenantId, input.audit);
        return { id: input.fxRateSetId };
      });
    },
    insertOwnershipEdge(input: OwnershipWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(ownershipEdge).values({
          ownershipEdgeId: input.ownershipEdgeId,
          tenantId: input.tenantId,
          parentEntityId: input.parentEntityId,
          childEntityId: input.childEntityId,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          percent: input.percent,
          createdAt: input.createdAt,
        });
      });
    },
    listOwnershipEdges(tenantId: string): Promise<readonly OwnershipRow[]> {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(ownershipEdge)
          .where(eq(ownershipEdge.tenantId, tenantId));
        return rows.map((row) => ({
          parentEntityId: row.parentEntityId,
          childEntityId: row.childEntityId,
          effectiveFrom: row.effectiveFrom,
          effectiveTo: row.effectiveTo,
          percent: row.percent,
        }));
      });
    },
    insertConsolidationGroup(input: NamedWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(consolidationGroup).values({
          consolidationGroupId: input.id,
          tenantId: input.tenantId,
          name: input.name,
          reportingCurrency: input.reportingCurrency,
          payload: input.payload,
          createdAt: input.createdAt,
        });
        await writeAudit(tx, input.tenantId, input.audit);
        return { id: input.id };
      });
    },
    getConsolidationGroup(tenantId: string, id: string) {
      return tenantTx(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({
            id: consolidationGroup.consolidationGroupId,
            reportingCurrency: consolidationGroup.reportingCurrency,
          })
          .from(consolidationGroup)
          .where(
            and(
              eq(consolidationGroup.tenantId, tenantId),
              eq(consolidationGroup.consolidationGroupId, id),
            ),
          )
          .limit(1);
        return row ? { id: row.id, reportingCurrency: row.reportingCurrency.trim() } : null;
      });
    },
    insertElimination(input: EliminationWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(eliminationEntry).values({
          eliminationEntryId: input.id,
          tenantId: input.tenantId,
          consolidationGroupId: input.consolidationGroupId,
          evidenceId: input.evidenceId,
          inputHash: input.inputHash,
          payload: input.payload,
          createdAt: input.createdAt,
        });
        await writeAudit(tx, input.tenantId, input.audit);
      });
    },
    insertModel(input: { tenantId: string; modelId: string; name: string; createdAt: string }) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(model).values({
          modelId: input.modelId,
          tenantId: input.tenantId,
          name: input.name,
          createdAt: input.createdAt,
        });
      });
    },
    getModel(tenantId: string, modelId: string) {
      return tenantTx(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ id: model.modelId })
          .from(model)
          .where(and(eq(model.tenantId, tenantId), eq(model.modelId, modelId)))
          .limit(1);
        return row ?? null;
      });
    },
    insertModelVersion(input: ModelVersionWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(modelVersion).values({
          modelVersionId: input.modelVersionId,
          tenantId: input.tenantId,
          modelId: input.modelId,
          status: input.status,
          inputHash: input.inputHash,
          engineVersion: input.engineVersion,
          payload: input.payload,
          createdAt: input.createdAt,
        });
        for (const node of input.nodes) {
          await tx.insert(modelNode).values({
            modelNodeId: node.id,
            tenantId: input.tenantId,
            modelVersionId: input.modelVersionId,
            nodeKey: node.nodeKey,
            payload: node.payload,
          });
        }
        await writeAudit(tx, input.tenantId, input.audit);
      });
    },
    getModelVersion(tenantId: string, modelVersionId: string): Promise<VersionRow | null> {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(modelVersion)
          .where(
            and(
              eq(modelVersion.tenantId, tenantId),
              eq(modelVersion.modelVersionId, modelVersionId),
            ),
          )
          .limit(1);
        const row = rows[0];
        return row
          ? {
              id: row.modelVersionId,
              status: row.status,
              stateHash: row.inputHash,
              payload: row.payload,
            }
          : null;
      });
    },
    insertScenario(input: ScenarioWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(scenario).values({
          scenarioId: input.scenarioId,
          tenantId: input.tenantId,
          baseVersionId: input.baseVersionId,
          name: input.name,
          outputHash: input.outputHash,
          payload: input.payload,
          createdAt: input.createdAt,
        });
        await writeAudit(tx, input.tenantId, input.audit);
        return { id: input.scenarioId };
      });
    },
    insertValuation(input: VersionWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(valuation).values({
          valuationId: input.id,
          tenantId: input.tenantId,
          status: input.status,
          calculationStatus: input.calculationStatus,
          calculationRunId: input.calculationRunId,
          stateHash: input.stateHash,
          engineVersion: input.engineVersion,
          makerActorId: input.makerActorId,
          payload: input.payload,
          createdAt: input.createdAt,
        });
        await writeAudit(tx, input.tenantId, input.audit);
        return { id: input.id };
      });
    },
    getValuation(tenantId: string, valuationId: string): Promise<PublishableVersionRow | null> {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(valuation)
          .where(and(eq(valuation.tenantId, tenantId), eq(valuation.valuationId, valuationId)))
          .limit(1);
        const row = rows[0];
        return row
          ? {
              id: row.valuationId,
              status: row.status,
              stateHash: row.stateHash,
              payload: row.payload,
              engineVersion: row.engineVersion,
              makerActorId: row.makerActorId,
              supersedesId: null,
            }
          : null;
      });
    },
    insertReportPack(input: ReportPackWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(reportPack).values({
          reportPackId: input.id,
          tenantId: input.tenantId,
          status: input.status,
          cutoffAt: input.cutoffAt,
          stateHash: input.stateHash,
          payload: input.payload,
          createdAt: input.createdAt,
        });
        await writeAudit(tx, input.tenantId, input.audit);
        return { id: input.id };
      });
    },
    getReportPack(tenantId: string, reportPackId: string): Promise<VersionRow | null> {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(reportPack)
          .where(and(eq(reportPack.tenantId, tenantId), eq(reportPack.reportPackId, reportPackId)))
          .limit(1);
        const row = rows[0];
        return row
          ? {
              id: row.reportPackId,
              status: row.status,
              stateHash: row.stateHash,
              payload: row.payload,
            }
          : null;
      });
    },
    insertInstrument(input: {
      tenantId: string;
      instrumentId: string;
      entityId: string;
      name: string;
      kind: "debt" | "equity";
      createdAt: string;
    }) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(instrument).values(input);
      });
    },
    insertDebtTerms(input: PayloadWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(debtTerms).values({
          debtTermsId: input.id,
          tenantId: input.tenantId,
          instrumentId: input.parentId,
          inputHash: input.inputHash,
          payload: input.payload,
          createdAt: input.createdAt,
        });
        await writeAudit(tx, input.tenantId, input.audit);
      });
    },
    insertCapTable(input: CapTableWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(capTableVersion).values({
          capTableVersionId: input.id,
          tenantId: input.tenantId,
          entityId: input.entityId,
          inputHash: input.inputHash,
          payload: input.payload,
          createdAt: input.createdAt,
        });
        for (const row of input.holdings) {
          await tx.insert(holding).values({
            holdingId: row.id,
            tenantId: input.tenantId,
            capTableVersionId: input.id,
            holderId: row.holderId,
            commonShares: row.commonShares,
            options: row.options,
            convertibles: row.convertibles,
          });
        }
        await writeAudit(tx, input.tenantId, input.audit);
        return { id: input.id };
      });
    },
    findImportBatch(tenantId: string, idempotencyKey: string): Promise<VersionRow | null> {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(importBatch)
          .where(
            and(eq(importBatch.tenantId, tenantId), eq(importBatch.idempotencyKey, idempotencyKey)),
          )
          .limit(1);
        const row = rows[0];
        return row
          ? {
              id: row.importBatchId,
              status: "imported",
              stateHash: row.fileHash,
              payload: row.payload,
            }
          : null;
      });
    },
    insertImportBatch(input: ImportBatchWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(importBatch).values({
          importBatchId: input.id,
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
          fileHash: input.fileHash,
          payload: input.payload,
          createdAt: input.createdAt,
        });
        for (const row of input.rows) {
          await tx.insert(sourceRow).values({
            sourceRowId: row.id,
            tenantId: input.tenantId,
            importBatchId: input.id,
            rowNo: row.rowNo,
            payload: row.payload,
          });
        }
        await writeAudit(tx, input.tenantId, input.audit);
        return { id: input.id };
      });
    },
    insertProposal(input: ProposalWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(proposal).values({
          proposalId: input.id,
          tenantId: input.tenantId,
          kind: input.kind,
          status: input.status,
          citationId: input.citationId,
          payload: input.payload,
          createdAt: input.createdAt,
        });
        await writeAudit(tx, input.tenantId, input.audit);
        return { id: input.id };
      });
    },
    insertDeal(input: DealWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(deal).values({
          dealId: input.id,
          tenantId: input.tenantId,
          publishedStateHash: input.publishedStateHash,
          outputHash: input.outputHash,
          payload: input.payload,
          createdAt: input.createdAt,
        });
        await writeAudit(tx, input.tenantId, input.audit);
        return { id: input.id };
      });
    },
    insertReportingBasis(input: BasisWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(reportingBasis).values({
          reportingBasisId: input.id,
          tenantId: input.tenantId,
          basisVersion: input.basisVersion,
          localHash: input.localHash,
          groupHash: input.groupHash,
          payload: input.payload,
          createdAt: input.createdAt,
        });
        await writeAudit(tx, input.tenantId, input.audit);
        return { id: input.id };
      });
    },
  };
}

function stateValues(input: VersionWrite) {
  return {
    financialStateId: input.id,
    tenantId: input.tenantId,
    entityId: input.entityId,
    periodId: input.periodId,
    basis: input.basis,
    currency: input.currency,
    stateHash: input.stateHash,
    status: input.status,
    engineVersion: input.engineVersion,
    calculationStatus: input.calculationStatus,
    calculationRunId: input.calculationRunId,
    supersedesId: input.supersedesId,
    makerActorId: input.makerActorId,
    payload: input.payload,
    createdAt: input.createdAt,
  };
}

async function writeAudit(tx: AppDatabase, tenantId: string, audit: AuditWrite): Promise<void> {
  await tx.insert(auditEvent).values({
    eventId: audit.eventId,
    eventType: audit.eventType,
    eventVersion: 1,
    tenantId,
    occurredAt: audit.occurredAt,
    actorId: audit.actorId,
    correlationId: audit.correlationId,
    causationId: null,
    aggregateType: audit.aggregateType,
    aggregateId: audit.aggregateId,
    payload: audit.payload,
  });
}

async function tenantTx<T>(
  db: AppDatabase,
  tenantId: string,
  fn: (tx: AppDatabase) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE nexora_app"));
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx as unknown as AppDatabase);
    });
  } catch (error) {
    if (error instanceof KernelError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("FIN_IMMUTABLE_RECORD")) {
      throw new KernelError("FIN_IMMUTABLE_RECORD", "Posted financial records are immutable");
    }
    throw error instanceof Error ? error : new Error(message);
  }
}
