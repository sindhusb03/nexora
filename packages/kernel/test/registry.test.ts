import { describe, expect, it } from "vitest";

import { CALC_ENTRIES, CalcRegistry, calcRegistry, KernelError } from "../src/index.js";
import type { CalcValueShape } from "../src/index.js";

describe("calculation registry", () => {
  it("looks up approved money helpers and returns undefined for unknown ids", () => {
    expect(calcRegistry.lookup("money.add")).toEqual({
      id: "money.add",
      domain: "money",
      helper: "addMoney",
      inputShape: { left: "Money", right: "Money" },
      outputShape: "Money",
      version: "1.0.0",
    });
    expect(calcRegistry.lookup("valuation.missing")).toBeUndefined();
  });

  it("registers entries and rejects duplicate ids without replacing the original", () => {
    const registry = new CalcRegistry();
    const entry = CALC_ENTRIES[0];
    registry.register(entry);
    expect(() => registry.register({ ...entry, version: "2.0.0" })).toThrow(KernelError);
    expect(registry.lookup(entry.id)?.version).toBe("1.0.0");
    expect(() => new CalcRegistry([entry, entry])).toThrow(/Duplicate calculation id/);
  });

  it("catalogs unique ids for the existing pure helpers", () => {
    const entries = calcRegistry.list();
    expect(entries.map((entry) => entry.helper)).toEqual([
      "addMoney",
      "subtractMoney",
      "negateMoney",
    ]);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    expect(
      entries.every((entry) => entry.domain === "money" && entry.outputShape === "Money"),
    ).toBe(true);
  });

  it("keeps registered metadata and list snapshots isolated from caller mutation", () => {
    const registry = new CalcRegistry();
    const entry = {
      ...CALC_ENTRIES[0],
      version: "1.0.0",
      inputShape: { left: "Money" as CalcValueShape },
    };
    registry.register(entry);
    entry.version = "changed";
    entry.inputShape.left = "integer-string";
    const listed = registry.list();
    listed.pop();
    expect(registry.list()).toHaveLength(1);
    expect(registry.lookup(entry.id)?.version).toBe("1.0.0");
    expect(registry.lookup(entry.id)?.inputShape).toEqual({ left: "Money" });
    expect(Object.isFrozen(registry.lookup(entry.id)?.inputShape)).toBe(true);
  });
});
