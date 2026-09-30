import { hashPassword } from "../auth/crypto.js";
import type { ActorContext } from "../http.js";
import { createLedgerService } from "../service.js";
import type { LedgerStore } from "@nexora/db";

import { centsToMajor, DEMO_ACCOUNTS, demoJournals, PLANNING_DRIVERS } from "./books.js";
import { SOURCE_DOCUMENTS } from "./catalog.js";
import { embedText } from "../copilot/retrieval.js";
import { type CompanyDirectory } from "../workspace/directory.js";

export const DEMO_PASSWORD = process.env.NEXORA_DEMO_PASSWORD?.trim() || "nexora-demo-2026";
export const DEMO_REGION = "us-east-1";
const DEMO_NAME = "Nazareno Services";

export async function seedDemo(
  store: LedgerStore,
  directory: CompanyDirectory,
  platformAdminActorIds: readonly string[],
  passwordCost = 32_768,
  password = DEMO_PASSWORD,
): Promise<void> {
  if (directory.list().some((card) => card.name === DEMO_NAME)) return;
  const ledger = createLedgerService(store, platformAdminActorIds);
  const now = new Date().toISOString();
  const actors = ["platform-admin", "sindhu", "controller", "viewer"] as const;
  for (const actorId of actors) {
    await store.createUser({
      actorId,
      passwordHash: await hashPassword(password, passwordCost),
      createdAt: now,
    });
  }

  const admin = actor("platform-admin", null);
  const tenant = await ledger.provisionTenant(admin, {
    name: DEMO_NAME,
    homeRegion: DEMO_REGION,
    ownerActorId: "sindhu",
  });
  const owner = actor("sindhu", tenant.tenantId);
  await ledger.grantMembership(owner, { actorId: "controller", role: "controller" });
  await ledger.grantMembership(owner, { actorId: "viewer", role: "viewer" });

  const entity = await ledger.createEntity(owner, { legalName: "Nazareno Services LLC", functionalCurrency: "USD" });
  const accounts = new Map<string, string>();
  for (const account of DEMO_ACCOUNTS) {
    const created = await ledger.createAccount(owner, { entityId: entity.entityId, ...account });
    accounts.set(account.code, created.accountId);
  }

  const journals = demoJournals();
  let latestPeriodId = "";
  for (const [index, journal] of journals.entries()) {
    const period = await ledger.createPeriod(owner, {
      entityId: entity.entityId,
      startDate: journal.startDate,
      endDate: journal.endDate,
    });
    latestPeriodId = period.periodId;
    await ledger.postJournal(actor("sindhu", tenant.tenantId, `demo-journal-${index}`), {
      entityId: entity.entityId,
      periodId: period.periodId,
      currency: "USD",
      sourceRef: journal.label,
      lines: journal.lines.map((line) => ({
        accountId: requiredAccount(accounts, line.code),
        debit: centsToMajor(line.debitCents),
        credit: centsToMajor(line.creditCents),
      })),
    });
    if (index < journals.length - 1) {
      await ledger.closePeriod(owner, period.periodId);
    }
  }

  const supportMembershipId = crypto.randomUUID();
  const supportExpiry = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
  await store.grantMembership({
    tenantId: tenant.tenantId,
    membershipId: supportMembershipId,
    actorId: "platform-admin",
    role: "auditor",
    audit: audit(admin, tenant.tenantId, "MembershipGranted", supportMembershipId, { role: "auditor", reason: "support-access" }),
  });

  await insertRecord(store, owner, "drivers", "active", { ...PLANNING_DRIVERS });
  await insertRecord(store, owner, "policy", "active", {
    name: "Publication maker-checker",
    body: "The actor who moves a statement or board pack to review cannot approve it. Posted journals stay immutable.",
  });
  await insertRecord(store, owner, "policy", "active", {
    name: "AI policy",
    body: "Agents may propose mappings, variance notes, normalization adjustments, and board drafts. They cannot post journals or publish numbers. Supervised autonomy.",
  });
  await insertRecord(store, owner, "flag", "active", { key: "copilot", enabled: true, label: "Copilot drawer" });
  await insertRecord(store, owner, "flag", "active", { key: "board_export", enabled: true, label: "Board pack export" });
  await insertRecord(store, owner, "flag", "off", { key: "excel_addin", enabled: false, label: "Excel add-in" });
  await insertRecord(store, owner, "connector", "healthy", { key: "statements_xlsx", label: "Monthly statement workbooks", detail: "Nazareno income and balance sheet files staged" });
  await insertRecord(store, owner, "connector", "healthy", { key: "bank_pdf", label: "Bank statement PDFs", detail: "Twelve operating-account PDFs staged" });
  await insertRecord(store, owner, "connector", "unavailable", { key: "tally", label: "Tally", detail: "India connector is not connected in this build" });
  await insertRecord(store, owner, "support", "active", {
    actorId: "platform-admin",
    membershipId: supportMembershipId,
    expiresAt: supportExpiry,
    reason: "Demo support window for the platform console",
  });

  for (const document of SOURCE_DOCUMENTS) {
    await insertRecord(store, owner, "document", "active", {
      slug: document.slug,
      title: document.title,
      fileName: document.fileName,
      body: document.body,
      embedding: embedText(`${document.title} ${document.body}`),
    });
  }

  await insertRecord(store, owner, "proposal", "suggested", {
    agent: "mapping",
    title: "Map Piezas to patient services",
    summary: "4001.1 Piezas from the Nazareno income workbook maps to account 4000. Suggested, not posted.",
    citationId: "nazareno-income",
  });
  await insertRecord(store, owner, "proposal", "suggested", {
    agent: "variance",
    title: "September revenue variance",
    summary: "Revenue is ahead of the 15000000 minor-unit plan. Commentary is suggested until you accept it.",
    citationId: "variance",
  });
  await insertRecord(store, owner, "proposal", "suggested", {
    agent: "board",
    title: "Board commentary draft",
    summary: "Draft the September pack around kernel revenue, cash, and the QoE bridge. Suggested.",
    citationId: "board",
  });
  await insertRecord(store, owner, "proposal", "accepted", {
    agent: "normalization",
    title: "Owner travel add-back",
    summary: "450000 minor units of owner personal travel. Accepted as a bridge line. Posted actuals are unchanged.",
    citationId: "adj-owner-travel",
    amount: "450000",
    sourceRowId: "src-owner-travel",
  });
  await insertRecord(store, owner, "proposal", "accepted", {
    agent: "normalization",
    title: "One-time litigation",
    summary: "1200000 minor units. Accepted as a bridge line. Posted actuals are unchanged.",
    citationId: "adj-litigation",
    amount: "1200000",
    sourceRowId: "src-litigation",
  });

  directory.upsert({
    tenantId: tenant.tenantId,
    name: DEMO_NAME,
    region: DEMO_REGION,
    status: "active",
    entityId: entity.entityId,
    periodId: latestPeriodId,
    members: [
      { actorId: "sindhu", role: "owner" },
      { actorId: "controller", role: "controller" },
      { actorId: "viewer", role: "viewer" },
      { actorId: "platform-admin", role: "auditor" },
    ],
  });
}

function requiredAccount(accounts: ReadonlyMap<string, string>, code: string): string {
  const accountId = accounts.get(code);
  if (!accountId) throw new Error(`Missing demo account ${code}`);
  return accountId;
}

async function insertRecord(store: LedgerStore, actor: ActorContext, kind: string, status: string, payload: Record<string, unknown>) {
  const id = crypto.randomUUID();
  await store.insertWorkspaceRecord({
    tenantId: actor.tenantId ?? "",
    id,
    kind,
    status,
    payload,
    createdAt: new Date().toISOString(),
    audit: audit(actor, actor.tenantId ?? "", "WorkspaceRecorded", id, { kind, status }),
  });
}

function actor(actorId: string, tenantId: string | null, idempotencyKey: string | null = null): ActorContext {
  return {
    actorId,
    tenantId,
    region: DEMO_REGION,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    expectedVersion: null,
    verified: true,
  };
}

function audit(actor: ActorContext, tenantId: string, eventType: string, aggregateId: string, payload: Record<string, unknown>) {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    aggregateType: "workspace_record",
    aggregateId,
    actorId: actor.actorId,
    correlationId: actor.correlationId,
    occurredAt: new Date().toISOString(),
    payload: { ...payload, tenantId },
  };
}
