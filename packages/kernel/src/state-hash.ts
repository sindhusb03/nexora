import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";

/**
 * Hash only the allow-listed material fields. Presentation labels are omitted
 * because they are absent from the allow-list, not because they were stripped
 * after the fact.
 */
export function stateHash(input: Readonly<Record<string, unknown>>, allow: readonly string[]): string {
  if (allow.length === 0) {
    throw new KernelError("FIN_AMOUNT_SCALE", "State hash allow-list is empty");
  }
  const picked: Record<string, unknown> = {};
  for (const key of allow) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      throw new KernelError("FIN_AMOUNT_SCALE", `State hash is missing ${key}`);
    }
    picked[key] = input[key];
  }
  return hashMaterial(picked);
}
