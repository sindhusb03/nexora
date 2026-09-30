import { z } from "zod";

const uuid = z.uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const amount = z.string().regex(/^\d+(\.\d+)?$/);
const signedAmount = z.string().regex(/^-?\d+(\.\d+)?$/);

export const provisionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  homeRegion: z.string().trim().min(1).max(64),
  ownerActorId: z.string().trim().min(1).max(200),
});

export const membershipSchema = z.object({
  actorId: z.string().trim().min(1).max(200),
  role: z.enum(["owner", "controller", "viewer", "auditor"]),
});

export const entitySchema = z.object({
  legalName: z.string().trim().min(1).max(200),
  functionalCurrency: z.string().regex(/^[A-Z]{3}$/),
});

export const accountSchema = z.object({
  entityId: uuid,
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  report: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
  cashFlow: z.enum(["cash", "cfo", "cfi", "cff", "non_cash", "distribution"]),
  retainedEarnings: z.boolean().default(false),
});

export const periodSchema = z.object({
  entityId: uuid,
  startDate: isoDate,
  endDate: isoDate,
});

export const journalSchema = z.object({
  entityId: uuid,
  periodId: uuid,
  currency: z.string().regex(/^[A-Z]{3}$/),
  sourceRef: z.string().trim().min(1).max(200).nullish(),
  lines: z
    .array(
      z.object({
        accountId: uuid,
        debit: amount,
        credit: amount,
      }),
    )
    .min(2)
    .max(10_000),
});

export const reversalSchema = z.object({
  periodId: uuid,
  sourceRef: z.string().trim().min(1).max(200).nullish(),
});

export const dcfSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  freeCashFlows: z.array(signedAmount).min(1).max(100),
  wacc: signedAmount,
  terminalGrowth: signedAmount,
  netDebt: signedAmount,
  nonOperatingAssets: signedAmount,
  otherClaims: signedAmount,
});

const statusSchema = z.enum(["draft", "validated", "review", "approved", "published", "rejected"]);

export const financialStateSchema = z.object({
  entityId: uuid,
  periodId: uuid,
  basis: z.string().trim().min(1).max(64),
  currency: z.string().regex(/^[A-Z]{3}$/),
  netIncomeMinor: z.string().regex(/^-?\d+$/),
  label: z.string().trim().max(200).optional(),
});

export const transitionSchema = z.object({ to: statusSchema });

export const groupSchema = z.object({
  name: z.string().trim().min(1).max(200),
  reportingCurrency: z.string().regex(/^[A-Z]{3}$/),
});

export const modelSchema = z.object({ name: z.string().trim().min(1).max(200) });

export const calcNodeSchema = z.object({ id: z.string().min(1), type: z.string().min(1) }).passthrough();

export const modelVersionSchema = z.object({ nodes: z.array(calcNodeSchema).min(1) });

export const scenarioSchema = z.object({
  baseVersionId: uuid,
  name: z.string().trim().min(1).max(200),
  base: z.record(z.string(), z.string()),
  overrides: z.record(z.string(), z.string()),
});

export const sensitivitySchema = z.object({
  shocks: z.array(z.object({
    id: z.string().min(1),
    wacc: signedAmount.optional(),
    terminalGrowth: signedAmount.optional(),
  })).min(1),
});

export const reportPackSchema = z.object({
  statementStateId: uuid,
  valuationId: uuid,
});

export const debtSchema = z.object({
  entityId: uuid,
  name: z.string().trim().min(1).max(200),
  openingMinor: z.string().regex(/^\d+$/),
  drawMinor: z.string().regex(/^\d+$/),
  repaymentMinor: z.string().regex(/^\d+$/),
  accruedInterestMinor: z.string().regex(/^\d+$/),
});

export const capTableSchema = z.object({
  entityId: uuid,
  holdings: z.array(z.object({
    holderId: z.string().min(1),
    commonShares: z.string().regex(/^\d+$/),
    options: z.string().regex(/^\d+$/),
    convertibles: z.string().regex(/^\d+$/),
  })).min(1),
});

export const sourcesUsesSchema = z.object({
  sources: z.array(z.object({ label: z.string().min(1), amountMinor: z.string().regex(/^\d+$/) })).min(1),
  uses: z.array(z.object({ label: z.string().min(1), amountMinor: z.string().regex(/^\d+$/) })).min(1),
});

export const lboSchema = z.object({
  entryEquity: signedAmount,
  exitEquity: signedAmount,
  holdYears: signedAmount,
});

export const importSchema = z.object({
  rows: z.array(z.object({
    rowNo: z.number().int().positive(),
    account: z.string().min(1),
    amount: signedAmount,
  })).min(1),
});

export const qoeSchema = z.object({
  reported: signedAmount,
  adjustments: z.array(z.object({
    adjustmentId: z.string().min(1),
    sourceRowId: z.string().min(1),
    amount: signedAmount,
  })),
});

export const proposalSchema = z.object({
  claims: z.array(z.object({ text: z.string(), citationId: z.string().nullable() })),
});

export const acceptProposalSchema = z.object({
  entityId: uuid,
  periodId: uuid,
  currency: z.string().regex(/^[A-Z]{3}$/),
  lines: z.array(z.object({
    accountId: uuid,
    debitMinor: z.string().regex(/^\d+$/),
    creditMinor: z.string().regex(/^\d+$/),
  })).min(2),
});

export const dealSchema = z.object({
  publishedStateHash: z.string().regex(/^[0-9a-f]{64}$/),
  base: z.record(z.string(), z.string()),
  overrides: z.record(z.string(), z.string()),
});

export const basisSchema = z.object({
  basisVersion: z.string().min(1),
  localBalances: z.array(z.object({ accountId: z.string().min(1), debitPositiveMinor: z.string().regex(/^-?\d+$/) })),
  mappings: z.array(z.object({ localAccountId: z.string().min(1), groupAccountId: z.string().min(1) })),
});

export const ownershipSchema = z.object({
  asOf: isoDate,
  parentEntityId: uuid,
  childEntityId: uuid,
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable(),
  percent: signedAmount,
  subsidiaryEquityMinor: z.string().regex(/^-?\d+$/),
});

export const translateSchema = z.object({
  sourceCurrency: z.string().regex(/^[A-Z]{3}$/),
  ctaAccountId: z.string().min(1),
  lines: z.array(z.object({
    accountId: z.string().min(1),
    rateType: z.enum(["closing", "historical", "average"]),
    debitPositiveMinor: z.string().regex(/^-?\d+$/),
  })).min(1),
  rates: z.object({
    closing: fxRateSchema(),
    historical: fxRateSchema(),
    average: fxRateSchema(),
  }),
});

export const eliminationSchema = z.object({
  evidenceId: z.string().min(1),
  balances: z.array(z.object({ accountId: z.string().min(1), debitPositiveMinor: z.string().regex(/^-?\d+$/) })),
  eliminations: z.array(z.object({
    accountId: z.string().min(1),
    debitMinor: z.string().regex(/^\d+$/),
    creditMinor: z.string().regex(/^\d+$/),
    evidenceId: z.string().min(1),
  })),
});

export const fxSetSchema = z.object({
  label: z.string().min(1),
  rates: z.array(z.object({
    base: z.string().regex(/^[A-Z]{3}$/),
    quote: z.string().regex(/^[A-Z]{3}$/),
    rateType: z.enum(["closing", "historical", "average"]),
    rate: amount,
  })).min(1),
});

function fxRateSchema() {
  return z.object({
    rateSetId: z.string().min(1),
    base: z.string().regex(/^[A-Z]{3}$/),
    quote: z.string().regex(/^[A-Z]{3}$/),
    rate: amount,
    rounding: z.literal("half_even"),
  });
}

export const openApiSchemas = {
  financialState: financialStateSchema,
  transition: transitionSchema,
  valuation: dcfSchema,
  reportPack: reportPackSchema,
  debt: debtSchema,
  capTable: capTableSchema,
  importBatch: importSchema,
  proposal: proposalSchema,
  deal: dealSchema,
  basis: basisSchema,
};
