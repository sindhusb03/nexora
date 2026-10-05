import { KernelError } from "./errors.js";

/** Financial values are described separately from nonfinancial metadata. */
export type CalcValueShape = "Money" | "AnalyticalDecimal" | "integer-string" | "decimal-string";

/** Catalog metadata for an approved pure helper; this is not an execution engine. */
export interface FormulaEntry {
  readonly id: string;
  readonly domain: "money" | "capital" | "valuation";
  readonly helper: string;
  readonly inputShape: Readonly<Record<string, CalcValueShape>>;
  readonly outputShape: CalcValueShape;
  readonly version: string;
}

/** A calculation id has one approved version in a registry instance. */
export class CalcRegistry {
  private readonly entries = new Map<string, FormulaEntry>();

  constructor(entries: readonly FormulaEntry[] = []) {
    for (const entry of entries) this.register(entry);
  }

  register(entry: FormulaEntry): void {
    if (this.entries.has(entry.id)) {
      throw new KernelError("CALC_INVALID_NODE", `Duplicate calculation id: ${entry.id}`);
    }
    this.entries.set(
      entry.id,
      Object.freeze({ ...entry, inputShape: Object.freeze({ ...entry.inputShape }) }),
    );
  }

  lookup(id: string): FormulaEntry | undefined {
    return this.entries.get(id);
  }

  list(): FormulaEntry[] {
    return [...this.entries.values()];
  }
}

/** Initial coverage of existing money.ts helpers. It does not imply full kernel coverage. */
export const CALC_ENTRIES = [
  {
    id: "money.add",
    domain: "money",
    helper: "addMoney",
    inputShape: { left: "Money", right: "Money" },
    outputShape: "Money",
    version: "1.0.0",
  },
  {
    id: "money.subtract",
    domain: "money",
    helper: "subtractMoney",
    inputShape: { left: "Money", right: "Money" },
    outputShape: "Money",
    version: "1.0.0",
  },
  {
    id: "money.negate",
    domain: "money",
    helper: "negateMoney",
    inputShape: { value: "Money" },
    outputShape: "Money",
    version: "1.0.0",
  },
] as const satisfies readonly FormulaEntry[];

export const calcRegistry = new CalcRegistry(CALC_ENTRIES);
