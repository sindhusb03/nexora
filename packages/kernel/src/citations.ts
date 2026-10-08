import { hashMaterial } from "./hash.js";
import { ENGINE_VERSION } from "./version.js";

export interface CitedClaim {
  readonly text: string;
  readonly citationId: string | null;
}

/**
 * A numeric claim without a calculation run, statement hash, or document id
 * is discarded before it can be shown as a figure.
 */
export function acceptCitedClaims(
  claims: readonly CitedClaim[],
  sourceIds: readonly string[] = [],
): {
  readonly engineVersion: string;
  readonly inputHash: string;
  readonly accepted: readonly CitedClaim[];
  readonly discarded: readonly CitedClaim[];
} {
  const accepted: CitedClaim[] = [];
  const discarded: CitedClaim[] = [];
  for (const claim of claims) {
    if (
      (claim.citationId !== null && !sourceIds.includes(claim.citationId)) ||
      (/\d/.test(claim.text) && !claim.citationId)
    ) {
      discarded.push(claim);
    } else {
      accepted.push(claim);
    }
  }
  return {
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial({ claims, sourceIds }),
    accepted,
    discarded,
  };
}
