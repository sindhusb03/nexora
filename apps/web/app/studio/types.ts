export interface MoneyCell {
  readonly minor: string;
  readonly display: string;
}

export interface Lineage {
  readonly inputHash: string;
  readonly engineVersion: string;
  readonly source: string;
}

export interface Kpi {
  readonly id: string;
  readonly label: string;
  readonly minor: string;
  readonly display: string;
  readonly currency: string;
  readonly lineage: Lineage;
}

export interface StatementPeriod {
  readonly periodId: string;
  readonly label: string;
  readonly inputHash: string;
  readonly engineVersion: string;
}

export interface StatementRow {
  readonly key: string;
  readonly label: string;
  readonly section: string;
  readonly values: readonly {
    readonly periodId: string;
    readonly minor: string;
    readonly display: string;
  }[];
}

export interface JournalLine {
  readonly account: string;
  readonly debit: MoneyCell;
  readonly credit: MoneyCell;
}

export interface JournalView {
  readonly journalId: string;
  readonly periodId: string;
  readonly sourceRef: string;
  readonly payloadHash: string;
  readonly lines: readonly JournalLine[];
}

export interface ForecastMonth {
  readonly period: string;
  readonly revenueMinor: string;
  readonly cogsMinor: string;
  readonly grossProfitMinor: string;
  readonly opexMinor: string;
  readonly ebitdaMinor: string;
}

export interface ForecastResult {
  readonly engineVersion: string;
  readonly inputHash: string;
  readonly months: readonly ForecastMonth[];
}

export interface CashWeek {
  readonly weekIndex: string;
  readonly label: string;
  readonly beginningMinor: string;
  readonly inflowMinor: string;
  readonly outflowMinor: string;
  readonly endingMinor: string;
  readonly headroomMinor: string;
  readonly belowMinimum: boolean;
}

export interface CashCase {
  readonly engineVersion: string;
  readonly inputHash: string;
  readonly currency: string;
  readonly openingCashMinor: string;
  readonly minimumCashMinor: string;
  readonly weeks: readonly CashWeek[];
  readonly alerts: readonly {
    readonly weekIndex: string;
    readonly endingMinor: string;
    readonly shortfallMinor: string;
  }[];
}

export interface VarianceLine {
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly actualMinor: string;
  readonly planMinor: string;
  readonly varianceMinor: string;
  readonly varianceRatio: string | null;
  readonly favorable: boolean;
}

export interface Workspace {
  readonly engineVersion: string;
  readonly permissions: {
    readonly roles: readonly string[];
    readonly canWrite: boolean;
    readonly auditLocked: boolean;
  };
  readonly context: {
    readonly tenantId: string;
    readonly tenantName: string;
    readonly region: string;
    readonly entityId: string;
    readonly entityName: string;
    readonly currency: string;
    readonly periodId: string;
    readonly periodLabel: string;
    readonly scenario: string;
  };
  readonly latest: {
    readonly inputHash: string;
    readonly revenueMinor: string;
    readonly expensesMinor: string;
    readonly netIncomeMinor: string;
    readonly endingCashMinor: string;
    readonly assetsMinor: string;
    readonly liabilitiesMinor: string;
    readonly equityMinor: string;
  };
  readonly kpis: readonly Kpi[];
  readonly statements: {
    readonly periods: readonly StatementPeriod[];
    readonly rows: readonly StatementRow[];
  };
  readonly journals: readonly JournalView[];
  readonly forecast: {
    readonly drivers: {
      readonly revenueMinor: string;
      readonly growthRate: string;
      readonly grossMargin: string;
      readonly opexMinor: string;
    };
    readonly scenarioGrowthRate: string;
    readonly base: ForecastResult;
    readonly scenario: ForecastResult;
  };
  readonly cash: {
    readonly minimumCashMinor: string;
    readonly base: CashCase;
    readonly downside: CashCase;
  };
  readonly variance: {
    readonly engineVersion: string;
    readonly inputHash: string;
    readonly lines: readonly VarianceLine[];
  };
  readonly qoe: {
    readonly engineVersion: string;
    readonly inputHash: string;
    readonly reported: string;
    readonly adjustmentsTotal: string;
    readonly normalized: string;
    readonly steps: readonly {
      readonly adjustmentId: string;
      readonly amount: string;
      readonly stepHash: string;
      readonly label: string;
    }[];
  };
  readonly board: {
    readonly title: string;
    readonly cutoff: string;
    readonly stateHash: string;
    readonly sections: readonly {
      readonly heading: string;
      readonly figures: readonly {
        readonly label: string;
        readonly minor: string;
        readonly display: string;
        readonly inputHash: string;
      }[];
    }[];
  };
  readonly onboarding: {
    readonly steps: readonly {
      readonly id: string;
      readonly label: string;
      readonly state: string;
    }[];
    readonly certificate: {
      readonly bookCash: MoneyCell;
      readonly bankCash: MoneyCell;
      readonly difference: MoneyCell;
      readonly status: string;
      readonly sourceDocument: string;
      readonly engineVersion: string;
      readonly inputHash: string;
    };
  };
  readonly approvals: readonly {
    readonly id: string;
    readonly status: string;
    readonly agent: string;
    readonly title: string;
    readonly summary: string;
    readonly citationId: string;
    readonly amountMinor: string;
  }[];
  readonly documents: readonly {
    readonly id: string;
    readonly title: string;
    readonly fileName: string;
    readonly excerpt: string;
  }[];
  readonly admin: {
    readonly members: readonly { readonly actorId: string; readonly role: string }[];
    readonly policies: readonly {
      readonly id: string;
      readonly name: string;
      readonly body: string;
    }[];
    readonly audit: readonly {
      readonly eventId: string;
      readonly eventType: string;
      readonly occurredAt: string;
      readonly actorId: string;
      readonly aggregateType: string;
    }[];
    readonly auditLocked: boolean;
  };
  readonly series: readonly {
    readonly label: string;
    readonly revenue: string;
    readonly netIncome: string;
    readonly cash: string;
    readonly revenueDelta: string;
    readonly netIncomeDelta: string;
    readonly cashDelta: string;
  }[];
}

export interface SessionView {
  readonly actorId: string;
  readonly tenantId: string | null;
  readonly region: string;
  readonly roles: readonly string[];
  readonly platformAdmin: boolean;
  readonly csrfToken: string;
}

export interface CompanyCard {
  readonly tenantId: string;
  readonly name: string;
  readonly region: string;
  readonly status: string;
}

export interface PlatformView {
  readonly tenants: readonly {
    readonly tenantId: string;
    readonly name: string;
    readonly region: string;
    readonly status: string;
  }[];
  readonly flags: readonly {
    readonly id: string;
    readonly tenantId: string;
    readonly key: string;
    readonly label: string;
    readonly enabled: boolean;
    readonly status: string;
  }[];
  readonly connectors: readonly {
    readonly id: string;
    readonly label: string;
    readonly status: string;
    readonly detail: string;
  }[];
  readonly runs: readonly {
    readonly id: string;
    readonly status: string;
    readonly agent: string;
    readonly mode: string;
    readonly createdAt: string;
  }[];
  readonly support: readonly {
    readonly id: string;
    readonly status: string;
    readonly actorId: string;
    readonly expiresAt: string;
    readonly reason: string;
  }[];
}

export interface CopilotReply {
  readonly mode: string;
  readonly agent: string;
  readonly text: string;
  readonly accepted: boolean;
  readonly rejectedNumbers: readonly string[];
  readonly citations: readonly { readonly id: string; readonly label: string }[];
  readonly proposal: { readonly title: string; readonly summary: string } | null;
}

export function isWorkspace(value: unknown): value is Workspace {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { engineVersion?: unknown; statements?: { rows?: unknown } };
  return typeof record.engineVersion === "string" && Array.isArray(record.statements?.rows);
}

export function isSession(value: unknown): value is SessionView {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { actorId?: unknown; csrfToken?: unknown; platformAdmin?: unknown };
  return (
    typeof record.actorId === "string" &&
    typeof record.csrfToken === "string" &&
    typeof record.platformAdmin === "boolean"
  );
}

export function isPlatform(value: unknown): value is PlatformView {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { tenants?: unknown; flags?: unknown; connectors?: unknown };
  return (
    Array.isArray(record.tenants) && Array.isArray(record.flags) && Array.isArray(record.connectors)
  );
}
