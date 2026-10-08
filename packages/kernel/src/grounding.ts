import { hashMaterial } from "./hash.js";
import { ENGINE_VERSION } from "./version.js";

// Consume the whole numeric token, including malformed separators, before validating it.
const NUMBER =
  /(?:\d{4}-\d{2}-\d{2}|(?:\(\s*)?[+\-−]?\d[\d,.]*(?:[eE][+-]?\d+)?(?:\s*%)?(?:\s*\))?)/g;
const CITATION = /\[([^\]]+)\](?:\(([^)]+)\))?/g;

interface GroundingSources {
  readonly factIds?: readonly string[];
  readonly documents?: readonly { readonly id: string; readonly text: string }[];
}

/**
 * A model may only repeat numbers that already appear in a tool result.
 * Ungrounded numbers are replaced before the text can be shown as a figure.
 */
export function groundModelText(
  modelText: string,
  toolCorpus: readonly string[],
  sources: GroundingSources = {},
): {
  readonly engineVersion: string;
  readonly inputHash: string;
  readonly accepted: boolean;
  readonly rejectedNumbers: readonly string[];
  readonly rejectedCitations: readonly string[];
  readonly text: string;
} {
  const corpus = new Set(
    toolCorpus.flatMap((fact) =>
      [...fact.matchAll(NUMBER)].map((match) => numericKey(match[0])).filter((key) => key !== null),
    ),
  );
  const ids = new Set([
    ...(sources.factIds ?? []),
    ...(sources.documents ?? []).map((doc) => doc.id),
  ]);
  const rejectedCitations = [...modelText.matchAll(CITATION)]
    .map((match) => match[2] ?? match[1] ?? "")
    .filter((id) => !ids.has(id));
  const rejected: string[] = [];
  const groundNumber = (token: string): string => {
    const core = numericKey(token);
    if (core !== null && corpus.has(core)) {
      return token;
    }
    rejected.push(core ?? token);
    return "[ungrounded]";
  };
  const text = modelText.replace(
    new RegExp(`${CITATION.source}|${NUMBER.source}`, "g"),
    (token, label: string | undefined, target: string | undefined) => {
      if (label !== undefined)
        return target === undefined ? token : `[${label.replace(NUMBER, groundNumber)}](${target})`;
      return groundNumber(token);
    },
  );
  return {
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial({ modelText, toolCorpus: [...toolCorpus], sources }),
    accepted: rejected.length === 0 && rejectedCitations.length === 0,
    rejectedNumbers: rejected,
    rejectedCitations,
    text,
  };
}

function numericKey(token: string): string | null {
  const value = token.replace(/\s/g, "").replace(/[.,]$/, "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = /^(\()?([+-]?)(\d+|\d{1,3}(?:,\d{3})+)(\.\d+)?(%)?(\))?$/.exec(value);
  if (!match || Boolean(match[1]) !== Boolean(match[6]) || (match[1] && match[2])) return null;
  const sign = match[1] || match[2] === "-" ? "-" : "";
  return `${sign}${match[3]?.replace(/,/g, "")}${match[4] ?? ""}${match[5] ?? ""}`;
}
