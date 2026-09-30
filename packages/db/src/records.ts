import type { CashFlowClass, ReportClass, Role } from "@nexora/kernel";

export interface TenantRecord {
  readonly tenantId: string;
  readonly name: string;
  readonly homeRegion: string;
  readonly status: "active" | "suspended";
  readonly createdAt: string;
}

export interface EntityRecord {
  readonly entityId: string;
  readonly tenantId: string;
  readonly legalName: string;
  readonly functionalCurrency: string;
  readonly retainedEarningsAccountId: string | null;
}

export interface AccountRecord {
  readonly accountId: string;
  readonly tenantId: string;
  readonly entityId: string;
  readonly code: string;
  readonly name: string;
  readonly report: ReportClass;
  readonly cashFlow: CashFlowClass;
  readonly currency: string;
  readonly active: boolean;
}

export interface PeriodRecord {
  readonly periodId: string;
  readonly tenantId: string;
  readonly entityId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: "open" | "closed";
}

export interface StoredJournalLine {
  readonly accountId: string;
  readonly lineNo: number;
  readonly debitMinor: string;
  readonly creditMinor: string;
}

export interface JournalRecord {
  readonly journalId: string;
  readonly tenantId: string;
  readonly entityId: string;
  readonly periodId: string;
  readonly currency: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly reversesJournalId: string | null;
  readonly sourceRef: string | null;
  readonly actorId: string;
  readonly correlationId: string;
  readonly version: number;
  readonly postedAt: string;
  readonly lines: readonly StoredJournalLine[];
}

export interface AuditRecord {
  readonly eventId: string;
  readonly eventType: string;
  readonly tenantId: string;
  readonly occurredAt: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: unknown;
}

export interface CalculationRunRecord {
  readonly calculationRunId: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly status: "succeeded" | "failed";
  readonly engineVersion: string;
  readonly inputHash: string;
  readonly inputs: unknown;
  readonly outputs: unknown;
  readonly actorId: string;
  readonly correlationId: string;
  readonly createdAt: string;
}

export interface PostedActivityLine {
  readonly accountId: string;
  readonly report: ReportClass;
  readonly cashFlow: CashFlowClass;
  readonly currency: string;
  readonly debitMinor: string;
  readonly creditMinor: string;
  readonly periodId: string;
  readonly periodEnd: string;
}

export interface AuditWrite {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
}

export interface AuthUserRecord {
  readonly actorId: string;
  readonly passwordHash: string;
  readonly disabled: boolean;
  readonly email: string | null;
}

export interface AuthSessionRecord {
  readonly sessionId: string;
  readonly actorId: string;
  readonly tenantId: string | null;
  readonly region: string;
  /** ISO-8601 UTC. */
  readonly expiresAt: string;
}

export type AuthAuditEventType =
  | "login_success"
  | "login_failure"
  | "magic_link_sent"
  | "magic_link_used"
  | "totp_enroll"
  | "totp_verify"
  | "session_revoke"
  | "role_change";

export interface AuthAuditRecord {
  readonly eventId: string;
  readonly eventType: AuthAuditEventType;
  readonly occurredAt: string;
  readonly actorId: string | null;
  readonly tenantId: string | null;
  readonly requestId: string;
  readonly outcome: "success" | "failure";
  readonly payload: unknown;
}

export interface LockoutRecord {
  readonly subjectHash: string;
  readonly failures: number;
  readonly windowStartedAt: string;
  readonly lockedUntil: string | null;
}

export type SessionState = "active" | "revoked" | "expired" | "missing";

/** Users and sessions. Runs as nexora_app with no tenant set; tenant data is never read here. */
export interface IdentityStore {
  createUser(input: {
    actorId: string;
    passwordHash: string;
    createdAt: string;
    email?: string;
  }): Promise<"created" | "exists" | "email_taken">;
  findUser(actorId: string): Promise<AuthUserRecord | null>;
  findUserByEmail(email: string): Promise<AuthUserRecord | null>;
  createSession(input: {
    sessionId: string;
    actorId: string;
    region: string;
    createdAt: string;
    expiresAt: string;
    familyId?: string;
    rotatedFrom?: string;
    tenantId?: string | null;
  }): Promise<void>;
  /** Returns the session only while it is unexpired and unrevoked. */
  getActiveSession(sessionId: string): Promise<AuthSessionRecord | null>;
  /** Distinguishes a revoked session (reuse must kill the family) from expiry. */
  sessionState(sessionId: string): Promise<SessionState>;
  selectSessionTenant(sessionId: string, tenantId: string | null): Promise<boolean>;
  revokeSession(sessionId: string, revokedAt: string): Promise<void>;
  /** Revokes every live session in the family of the given session. */
  revokeSessionFamily(sessionId: string, revokedAt: string): Promise<void>;
  rotateSession(input: {
    sessionId: string;
    nextSessionId: string;
    now: string;
    expiresAt: string;
  }): Promise<boolean>;
  createMagicLink(input: {
    tokenHash: string;
    actorId: string;
    createdAt: string;
    expiresAt: string;
  }): Promise<void>;
  /**
   * Inserts a magic link only when the email belongs to a live user.
   * Unknown and disabled addresses insert nothing. The statement shape is the same either way.
   */
  createMagicLinkForEmail(input: {
    email: string;
    tokenHash: string;
    createdAt: string;
    expiresAt: string;
  }): Promise<string | null>;
  consumeMagicLink(tokenHash: string, usedAt: string): Promise<string | null>;
  saveTotp(input: {
    actorId: string;
    secretCipher: string;
    createdAt: string;
  }): Promise<"saved" | "locked">;
  confirmTotp(actorId: string, enabledAt: string): Promise<boolean>;
  /** Records a TOTP step once. Returns false when that step was already accepted. */
  acceptTotpStep(actorId: string, step: number): Promise<boolean>;
  disableTotp(actorId: string, retiredAt: string): Promise<boolean>;
  getTotp(actorId: string): Promise<{ secretCipher: string; enabled: boolean } | null>;
  saveRecoveryCodes(actorId: string, codeHashes: readonly string[]): Promise<void>;
  consumeRecoveryCode(actorId: string, codeHash: string, usedAt: string): Promise<boolean>;
  readLockout(subjectHash: string): Promise<LockoutRecord | null>;
  writeLockout(record: LockoutRecord): Promise<void>;
  clearLockout(subjectHash: string): Promise<void>;
  createMfaChallenge(input: {
    challengeId: string;
    actorId: string;
    region: string;
    createdAt: string;
    expiresAt: string;
  }): Promise<void>;
  readMfaChallenge(challengeId: string): Promise<{ actorId: string; region: string } | null>;
  consumeMfaChallenge(
    challengeId: string,
    usedAt: string,
  ): Promise<{ actorId: string; region: string } | null>;
  insertAuthAudit(input: {
    eventId: string;
    eventType: AuthAuditEventType;
    occurredAt: string;
    actorId: string | null;
    tenantId: string | null;
    requestId: string;
    outcome: "success" | "failure";
    payload: Record<string, unknown>;
  }): Promise<void>;
  listAuthAudit(input: {
    actorId: string;
    tenantId: string | null;
    includeTenant: boolean;
  }): Promise<readonly AuthAuditRecord[]>;
  linkOidcAccount(input: {
    linkId: string;
    actorId: string;
    issuer: string;
    subject: string;
    createdAt: string;
  }): Promise<"linked" | "conflict" | "missing_actor">;
  findOidcLink(issuer: string, subject: string): Promise<{ actorId: string } | null>;
  saveOidcState(input: {
    stateHash: string;
    providerId: string;
    nonceHash: string;
    createdAt: string;
    expiresAt: string;
  }): Promise<void>;
  consumeOidcState(
    stateHash: string,
    usedAt: string,
  ): Promise<{ providerId: string; nonceHash: string } | null>;
  /** Names recorded in schema_migrations. Used by readiness. */
  appliedMigrations(): Promise<readonly string[]>;
  /** A trivial round trip used by readiness checks. */
  ping(): Promise<void>;
}

export interface LedgerStore extends IdentityStore {
  createTenant(input: {
    tenant: TenantRecord;
    ownerActorId: string;
    membershipId: string;
    audit: AuditWrite;
  }): Promise<TenantRecord>;
  grantMembership(input: {
    tenantId: string;
    membershipId: string;
    actorId: string;
    role: Exclude<Role, "platform_admin">;
    audit: AuditWrite;
  }): Promise<void>;
  getTenant(tenantId: string): Promise<TenantRecord | null>;
  listRoles(tenantId: string, actorId: string): Promise<readonly Role[]>;
  createEntity(input: { entity: EntityRecord; audit: AuditWrite }): Promise<EntityRecord>;
  getEntity(tenantId: string, entityId: string): Promise<EntityRecord | null>;
  listEntities(tenantId: string): Promise<readonly EntityRecord[]>;
  createAccount(input: {
    account: AccountRecord;
    retainedEarnings: boolean;
    audit: AuditWrite;
  }): Promise<AccountRecord>;
  listAccounts(tenantId: string, entityId: string): Promise<readonly AccountRecord[]>;
  createPeriod(input: { period: PeriodRecord; audit: AuditWrite }): Promise<PeriodRecord>;
  getPeriod(tenantId: string, periodId: string): Promise<PeriodRecord | null>;
  listPeriods(tenantId: string, entityId: string): Promise<readonly PeriodRecord[]>;
  closePeriod(input: {
    tenantId: string;
    periodId: string;
    audit: AuditWrite;
  }): Promise<PeriodRecord>;
  findJournalByIdempotency(tenantId: string, idempotencyKey: string): Promise<JournalRecord | null>;
  findReversal(tenantId: string, journalId: string): Promise<JournalRecord | null>;
  getJournal(tenantId: string, journalId: string): Promise<JournalRecord | null>;
  listJournals(
    tenantId: string,
    entityId: string,
    periodId: string | null,
  ): Promise<readonly JournalRecord[]>;
  insertPostedJournal(input: {
    journal: Omit<JournalRecord, "lines" | "postedAt"> & { postedAt: string };
    lines: readonly (StoredJournalLine & { lineId: string })[];
    audit: AuditWrite;
    domainEventId: string;
  }): Promise<JournalRecord>;
  listPostedActivity(tenantId: string, entityId: string): Promise<readonly PostedActivityLine[]>;
  listAudit(tenantId: string): Promise<readonly AuditRecord[]>;
  insertCalculationRun(input: {
    run: CalculationRunRecord;
    audit: AuditWrite;
  }): Promise<CalculationRunRecord>;
  getCalculationRun(
    tenantId: string,
    calculationRunId: string,
  ): Promise<CalculationRunRecord | null>;
  insertFinancialState(input: VersionWrite): Promise<{ readonly id: string }>;
  getFinancialState(
    tenantId: string,
    financialStateId: string,
  ): Promise<PublishableVersionRow | null>;
  insertApproval(input: ApprovalWrite): Promise<void>;
  insertLineage(input: LineageWrite): Promise<void>;
  listLineage(tenantId: string, fromType: string, fromId: string): Promise<readonly LineageRow[]>;
  insertFxRateSet(input: FxRateSetWrite): Promise<{ readonly id: string }>;
  insertOwnershipEdge(input: OwnershipWrite): Promise<void>;
  listOwnershipEdges(tenantId: string): Promise<readonly OwnershipRow[]>;
  insertConsolidationGroup(input: NamedWrite): Promise<{ readonly id: string }>;
  insertElimination(input: EliminationWrite): Promise<void>;
  insertModel(input: {
    tenantId: string;
    modelId: string;
    name: string;
    createdAt: string;
  }): Promise<void>;
  insertModelVersion(input: ModelVersionWrite): Promise<void>;
  getModelVersion(tenantId: string, modelVersionId: string): Promise<VersionRow | null>;
  insertScenario(input: ScenarioWrite): Promise<{ readonly id: string }>;
  insertValuation(input: VersionWrite): Promise<{ readonly id: string }>;
  getValuation(tenantId: string, valuationId: string): Promise<PublishableVersionRow | null>;
  insertReportPack(input: ReportPackWrite): Promise<{ readonly id: string }>;
  getReportPack(tenantId: string, reportPackId: string): Promise<VersionRow | null>;
  insertInstrument(input: InstrumentWrite): Promise<void>;
  insertDebtTerms(input: PayloadWrite): Promise<void>;
  insertCapTable(input: CapTableWrite): Promise<{ readonly id: string }>;
  findImportBatch(tenantId: string, idempotencyKey: string): Promise<VersionRow | null>;
  insertImportBatch(input: ImportBatchWrite): Promise<{ readonly id: string }>;
  insertProposal(input: ProposalWrite): Promise<{ readonly id: string }>;
  insertDeal(input: DealWrite): Promise<{ readonly id: string }>;
  insertReportingBasis(input: BasisWrite): Promise<{ readonly id: string }>;
  insertWorkspaceRecord(input: WorkspaceWrite): Promise<{ readonly id: string }>;
  listWorkspaceRecords(tenantId: string, kind: string): Promise<readonly WorkspaceRow[]>;
  updateWorkspaceRecord(input: WorkspaceUpdate): Promise<void>;
  setTenantStatus(input: {
    tenantId: string;
    status: "active" | "suspended";
    audit: AuditWrite;
  }): Promise<void>;
  deleteMembership(input: {
    tenantId: string;
    membershipId: string;
    audit: AuditWrite;
  }): Promise<void>;
}

export interface VersionWrite {
  readonly tenantId: string;
  readonly id: string;
  readonly entityId: string;
  readonly periodId: string;
  readonly basis: string;
  readonly currency: string;
  readonly stateHash: string;
  readonly status: string;
  readonly engineVersion: string;
  readonly calculationStatus: "succeeded" | "failed";
  readonly calculationRunId: string | null;
  readonly supersedesId: string | null;
  readonly makerActorId: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly audit: AuditWrite;
}

export interface VersionRow {
  readonly id: string;
  readonly status: string;
  readonly stateHash: string;
  readonly payload: unknown;
}

/** A financial state or valuation version with the columns a checker needs to review it. */
export interface PublishableVersionRow extends VersionRow {
  readonly engineVersion: string;
  readonly makerActorId: string;
  readonly supersedesId: string | null;
}

export interface ApprovalWrite {
  readonly tenantId: string;
  readonly approvalId: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly actorId: string;
  readonly decision: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly audit: AuditWrite;
}

export interface LineageWrite {
  readonly tenantId: string;
  readonly lineageEdgeId: string;
  readonly fromType: string;
  readonly fromId: string;
  readonly toType: string;
  readonly toId: string;
  readonly relation: string;
  readonly createdAt: string;
}

export interface LineageRow {
  readonly fromType: string;
  readonly fromId: string;
  readonly toType: string;
  readonly toId: string;
  readonly relation: string;
}

export interface FxRateSetWrite {
  readonly tenantId: string;
  readonly fxRateSetId: string;
  readonly label: string;
  readonly rates: readonly {
    readonly id: string;
    readonly base: string;
    readonly quote: string;
    readonly rateType: string;
    readonly rate: string;
  }[];
  readonly createdAt: string;
  readonly audit: AuditWrite;
}

export interface OwnershipWrite {
  readonly tenantId: string;
  readonly ownershipEdgeId: string;
  readonly parentEntityId: string;
  readonly childEntityId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly percent: string;
  readonly createdAt: string;
}

export interface OwnershipRow {
  readonly parentEntityId: string;
  readonly childEntityId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly percent: string;
}

export interface NamedWrite {
  readonly tenantId: string;
  readonly id: string;
  readonly name: string;
  readonly reportingCurrency: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly audit: AuditWrite;
}

export interface EliminationWrite {
  readonly tenantId: string;
  readonly id: string;
  readonly consolidationGroupId: string;
  readonly evidenceId: string;
  readonly inputHash: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly audit: AuditWrite;
}

export interface ModelVersionWrite {
  readonly tenantId: string;
  readonly modelVersionId: string;
  readonly modelId: string;
  readonly status: string;
  readonly inputHash: string;
  readonly engineVersion: string;
  readonly nodes: readonly {
    readonly id: string;
    readonly nodeKey: string;
    readonly payload: Record<string, unknown>;
  }[];
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly audit: AuditWrite;
}

export interface ScenarioWrite {
  readonly tenantId: string;
  readonly scenarioId: string;
  readonly baseVersionId: string;
  readonly name: string;
  readonly outputHash: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly audit: AuditWrite;
}

export interface ReportPackWrite {
  readonly tenantId: string;
  readonly id: string;
  readonly status: string;
  readonly cutoffAt: string;
  readonly stateHash: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly audit: AuditWrite;
}

export interface InstrumentWrite {
  readonly tenantId: string;
  readonly instrumentId: string;
  readonly entityId: string;
  readonly name: string;
  readonly kind: "debt" | "equity";
  readonly createdAt: string;
}

export interface PayloadWrite {
  readonly tenantId: string;
  readonly id: string;
  readonly parentId: string;
  readonly inputHash: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly audit: AuditWrite;
}

export interface CapTableWrite {
  readonly tenantId: string;
  readonly id: string;
  readonly entityId: string;
  readonly inputHash: string;
  readonly payload: Record<string, unknown>;
  readonly holdings: readonly {
    readonly id: string;
    readonly holderId: string;
    readonly commonShares: string;
    readonly options: string;
    readonly convertibles: string;
  }[];
  readonly createdAt: string;
  readonly audit: AuditWrite;
}

export interface ImportBatchWrite {
  readonly tenantId: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly fileHash: string;
  readonly payload: Record<string, unknown>;
  readonly rows: readonly {
    readonly id: string;
    readonly rowNo: number;
    readonly payload: Record<string, unknown>;
  }[];
  readonly createdAt: string;
  readonly audit: AuditWrite;
}

export interface ProposalWrite {
  readonly tenantId: string;
  readonly id: string;
  readonly kind: "journal" | "assumption";
  readonly status: "suggested" | "accepted" | "rejected";
  readonly citationId: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly audit: AuditWrite;
}

export interface DealWrite {
  readonly tenantId: string;
  readonly id: string;
  readonly publishedStateHash: string;
  readonly outputHash: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly audit: AuditWrite;
}

export interface WorkspaceWrite {
  readonly tenantId: string;
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly audit: AuditWrite;
}

export interface WorkspaceUpdate {
  readonly tenantId: string;
  readonly id: string;
  readonly status: string;
  readonly payload: Record<string, unknown>;
  readonly updatedAt: string;
  readonly audit: AuditWrite;
}

export interface WorkspaceRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BasisWrite {
  readonly tenantId: string;
  readonly id: string;
  readonly basisVersion: string;
  readonly localHash: string;
  readonly groupHash: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly audit: AuditWrite;
}
