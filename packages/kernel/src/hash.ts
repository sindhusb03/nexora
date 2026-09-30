import { createHash } from "node:crypto";

import { KernelError } from "./errors.js";

/**
 * Material hashes reject IEEE-754 numbers. Financial inputs must already be
 * decimal strings or integer minor-unit strings so the digest cannot depend
 * on binary floating point.
 */
export function hashMaterial(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      throw new KernelError(
        "FIN_AMOUNT_SCALE",
        "Material hashes reject IEEE numbers; use decimal strings",
      );
    case "bigint":
      throw new KernelError(
        "FIN_AMOUNT_SCALE",
        "Material hashes reject bigint; use decimal strings",
      );
    case "undefined":
    case "function":
    case "symbol":
      throw new KernelError("FIN_AMOUNT_SCALE", "Material hashes reject non-data values");
    case "object": {
      if (Array.isArray(value)) {
        return value.map((entry) => sortValue(entry));
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const sorted: Record<string, unknown> = {};
      for (const key of keys) {
        const entry = record[key];
        if (entry !== undefined) {
          sorted[key] = sortValue(entry);
        }
      }
      return sorted;
    }
    default:
      throw new KernelError("FIN_AMOUNT_SCALE", "Material hashes reject non-data values");
  }
}
