import { describe, expect, it } from "vitest";

import {
  KernelError,
  buildReversalLines,
  lineToMoneyPair,
  money,
  netLinesToZero,
  validateJournal,
} from "../src/index.js";

function line(
  accountId: string,
  debit: bigint,
  credit: bigint,
): {
  accountId: string;
  debit: ReturnType<typeof money>;
  credit: ReturnType<typeof money>;
} {
  return {
    accountId,
    debit: money("USD", debit),
    credit: money("USD", credit),
  };
}

describe("journals", () => {
  it("accepts a balanced journal and hashes the payload", () => {
    const first = validateJournal({
      currency: "USD",
      entityId: "entity-1",
      periodId: "period-1",
      lines: [line("cash", 1000n, 0n), line("revenue", 0n, 1000n)],
    });
    const second = validateJournal({
      currency: "USD",
      entityId: "entity-1",
      periodId: "period-1",
      lines: [line("cash", 1000n, 0n), line("revenue", 0n, 1000n)],
    });
    expect(first.totalDebitMinor).toBe(first.totalCreditMinor);
    expect(first.payloadHash).toBe(second.payloadHash);
  });

  it("rejects unbalanced journals and mixed line sides", () => {
    expect(() =>
      validateJournal({
        currency: "USD",
        entityId: "entity-1",
        periodId: "period-1",
        lines: [line("cash", 1000n, 0n), line("revenue", 0n, 900n)],
      }),
    ).toThrowError(expect.objectContaining({ code: "FIN_UNBALANCED_JOURNAL" }));

    expect(() =>
      validateJournal({
        currency: "USD",
        entityId: "entity-1",
        periodId: "period-1",
        lines: [line("cash", 1000n, 1000n), line("revenue", 0n, 1000n)],
      }),
    ).toThrow(KernelError);
  });

  it("builds a reversal that nets the original to zero", () => {
    const posted = validateJournal({
      currency: "USD",
      entityId: "entity-1",
      periodId: "period-1",
      lines: [line("cash", 800n, 0n), line("revenue", 0n, 500n), line("gain", 0n, 300n)],
    });
    const reversal = buildReversalLines(posted.lines);
    expect(netLinesToZero(posted.lines, reversal)).toBe(true);
    const replay = validateJournal({
      currency: "USD",
      entityId: "entity-1",
      periodId: "period-2",
      lines: reversal.map((entry) => {
        const pair = lineToMoneyPair(entry);
        return { accountId: entry.accountId, debit: pair.debit, credit: pair.credit };
      }),
    });
    expect(replay.totalDebitMinor).toBe(posted.totalDebitMinor);
  });

  it("conserves debits and credits across generated journals", () => {
    const next = lcg(42);
    for (let index = 0; index < 40; index += 1) {
      const amount = BigInt((next() % 50_000) + 1);
      const posted = validateJournal({
        currency: "USD",
        entityId: "entity-1",
        periodId: "period-1",
        lines: [line("cash", amount, 0n), line("revenue", 0n, amount)],
      });
      expect(netLinesToZero(posted.lines, buildReversalLines(posted.lines))).toBe(true);
    }
  });
});

function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}
