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
} from "./records.js";
import { auditEvent } from "./schema.js";

export function createProgramStore(db: AppDatabase) {
  return {
    insertFinancialState(input: VersionWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(financialState).values(stateValues(input));
        await writeAudit(tx, input.tenantId, input.audit);
        return { id: input.id };
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
