import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";
import { parseMinor } from "./money.js";
import { ENGINE_VERSION } from "./version.js";

export interface BasisMapping {
  readonly localAccountId: string;
  readonly groupAccountId: string;
}

/**
 * Map a local trial balance onto a group chart.
 * Unmapped non-zero accounts fail closed. The local balances are not rewritten.
 */
export function mapReportingBasis(input: {
  readonly basisVersion: string;
  readonly localBalances: readonly {
    readonly accountId: string;
    readonly debitPositiveMinor: string;
  }[];
  readonly mappings: readonly BasisMapping[];
}): {
  readonly engineVersion: string;
  readonly localHash: string;
  readonly groupHash: string;
  readonly basisVersion: string;
  readonly groupBalances: readonly {
    readonly accountId: string;
    readonly debitPositiveMinor: string;
  }[];
} {
  if (input.basisVersion.length === 0) {
    throw new KernelError("FIN_NOT_FOUND", "Reporting basis version is required");
  }
  const mapped = new Map(input.mappings.map((row) => [row.localAccountId, row.groupAccountId]));
  const group = new Map<string, bigint>();
  for (const balance of input.localBalances) {
    const minor = parseMinor(balance.debitPositiveMinor);
    const groupAccountId = mapped.get(balance.accountId);
    if (!groupAccountId) {
      if (minor !== 0n) {
        throw new KernelError("FIN_NOT_FOUND", `Unmapped local account ${balance.accountId}`);
      }
      continue;
    }
    group.set(groupAccountId, (group.get(groupAccountId) ?? 0n) + minor);
  }
  const groupBalances = [...group.keys()].sort().map((accountId) => ({
    accountId,
    debitPositiveMinor: (group.get(accountId) ?? 0n).toString(),
  }));
  return {
    engineVersion: ENGINE_VERSION,
    localHash: hashMaterial(input.localBalances),
    groupHash: hashMaterial({ basisVersion: input.basisVersion, groupBalances }),
    basisVersion: input.basisVersion,
    groupBalances,
  };
}
