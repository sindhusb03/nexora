import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";
import { projectScenario } from "./scenario.js";
import { ENGINE_VERSION } from "./version.js";

/**
 * A deal scenario is a projection over a published state hash.
 * The base assumption record is copied and left unchanged.
 */
export function applyDealScenario(input: {
  readonly publishedStateHash: string;
  readonly base: Readonly<Record<string, string>>;
  readonly overrides: Readonly<Record<string, string>>;
}): {
  readonly engineVersion: string;
  readonly publishedStateHash: string;
  readonly base: Readonly<Record<string, string>>;
  readonly scenario: Readonly<Record<string, string>>;
  readonly outputHash: string;
} {
  if (!/^[0-9a-f]{64}$/.test(input.publishedStateHash)) {
    throw new KernelError("PUBLISH_BLOCKED", "Deal math requires a published state hash");
  }
  const projected = projectScenario(input.base, input.overrides);
  return {
    engineVersion: ENGINE_VERSION,
    publishedStateHash: input.publishedStateHash,
    base: projected.base,
    scenario: projected.scenario,
    outputHash: hashMaterial({
      publishedStateHash: input.publishedStateHash,
      scenario: projected.scenario,
    }),
  };
}
