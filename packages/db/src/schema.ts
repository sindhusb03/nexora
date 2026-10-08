import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  smallint,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const tenant = pgTable("tenant", {
  tenantId: uuid("tenant_id").primaryKey(),
  name: text("name").notNull(),
  homeRegion: text("home_region").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
});

export const membership = pgTable(
  "membership",
  {
    membershipId: uuid("membership_id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.tenantId),
    actorId: text("actor_id").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    uniqueIndex("membership_actor_role").on(table.tenantId, table.actorId, table.role),
    index("membership_actor_active")
      .on(table.actorId)
      .where(sql`${table.status} = 'active'`),
    check("membership_status_check", sql`${table.status} IN ('active', 'suspended', 'left')`),
  ],
);

export const legalEntity = pgTable("legal_entity", {
  legalEntityId: uuid("legal_entity_id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenant.tenantId),
  legalName: text("legal_name").notNull(),
  functionalCurrency: char("functional_currency", { length: 3 }).notNull(),
  fiscalYearEndMonth: smallint("fiscal_year_end_month"),
  fiscalYearEndDay: smallint("fiscal_year_end_day"),
  retainedEarningsAccountId: uuid("retained_earnings_account_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
});

export const account = pgTable(
  "account",
  {
    accountId: uuid("account_id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.tenantId),
    legalEntityId: uuid("legal_entity_id")
      .notNull()
      .references(() => legalEntity.legalEntityId),
    code: text("code").notNull(),
    name: text("name").notNull(),
    report: text("report").notNull(),
    cashFlow: text("cash_flow").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    active: boolean("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    uniqueIndex("account_entity_code").on(table.tenantId, table.legalEntityId, table.code),
  ],
);

export const accountingPeriod = pgTable(
  "accounting_period",
  {
    periodId: uuid("period_id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.tenantId),
    legalEntityId: uuid("legal_entity_id")
      .notNull()
      .references(() => legalEntity.legalEntityId),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    uniqueIndex("period_entity_range").on(
      table.tenantId,
      table.legalEntityId,
      table.startDate,
      table.endDate,
    ),
    index("ix_period_tenant_entity_status").on(table.tenantId, table.legalEntityId, table.status),
    check("period_range", sql`${table.endDate} >= ${table.startDate}`),
  ],
);

export const journalEntry = pgTable(
  "journal_entry",
  {
    journalId: uuid("journal_id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.tenantId),
    legalEntityId: uuid("legal_entity_id")
      .notNull()
      .references(() => legalEntity.legalEntityId),
    periodId: uuid("period_id")
      .notNull()
      .references(() => accountingPeriod.periodId),
    status: text("status").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    reversesJournalId: uuid("reverses_journal_id"),
    sourceRef: text("source_ref"),
    actorId: text("actor_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    version: integer("version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("journal_idempotency").on(table.tenantId, table.idempotencyKey),
    index("ix_journal_tenant_period").on(table.tenantId, table.periodId),
    index("ix_journal_tenant_entity").on(table.tenantId, table.legalEntityId),
  ],
);

export const journalLine = pgTable(
  "journal_line",
  {
    journalLineId: uuid("journal_line_id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.tenantId),
    journalId: uuid("journal_id")
      .notNull()
      .references(() => journalEntry.journalId),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.accountId),
    lineNo: integer("line_no").notNull(),
    debitMinor: numeric("debit_minor", { precision: 38, scale: 0, mode: "string" }).notNull(),
    creditMinor: numeric("credit_minor", { precision: 38, scale: 0, mode: "string" }).notNull(),
  },
  (table) => [uniqueIndex("journal_line_no").on(table.journalId, table.lineNo)],
);

export const auditEvent = pgTable("audit_event", {
  eventId: uuid("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  eventVersion: integer("event_version").notNull(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenant.tenantId),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
  actorId: text("actor_id").notNull(),
  correlationId: text("correlation_id").notNull(),
  causationId: text("causation_id"),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  payload: jsonb("payload").notNull(),
});

export const calculationRun = pgTable("calculation_run", {
  calculationRunId: uuid("calculation_run_id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenant.tenantId),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  engineVersion: text("engine_version").notNull(),
  inputHash: text("input_hash").notNull(),
  inputs: jsonb("inputs").notNull(),
  outputs: jsonb("outputs"),
  actorId: text("actor_id").notNull(),
  correlationId: text("correlation_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
});

export const domainEvent = pgTable("domain_event", {
  eventId: uuid("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  eventVersion: integer("event_version").notNull(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenant.tenantId),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
  actorId: text("actor_id").notNull(),
  correlationId: text("correlation_id").notNull(),
  causationId: text("causation_id"),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  payload: jsonb("payload").notNull(),
});

import { identitySchema } from "./identity-schema.js";
import { ingestionSchema } from "./ingestion-schema.js";
import { programSchema } from "./program-schema.js";
import { workspaceRecord } from "./workspace-schema.js";

export const schema = {
  tenant,
  membership,
  legalEntity,
  account,
  accountingPeriod,
  journalEntry,
  journalLine,
  auditEvent,
  calculationRun,
  domainEvent,
  ...programSchema,
  ...identitySchema,
  workspaceRecord,
  ...ingestionSchema,
};
