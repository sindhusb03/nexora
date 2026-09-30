import { hashMaterial } from "./hash.js";
import { ENGINE_VERSION } from "./version.js";

/** A leading minus is a sign only when a digit does not sit immediately before it, so ISO dates stay dates. */
const NUMBER = /(?<!\d)-?\d[\d,]*(?:\.\d+)?%?/g;

/**
 * A model may only repeat numbers that already appear in a tool result.
 * Ungrounded numbers are replaced before the text can be shown as a figure.
 */
export function groundModelText(
  modelText: string,
  toolCorpus: readonly string[],
): {
  readonly engineVersion: string;
  readonly inputHash: string;
  readonly accepted: boolean;
  readonly rejectedNumbers: readonly string[];
  readonly text: string;
} {
  const corpus = toolCorpus.join("\n").replace(/,/g, "");
  const rejected: string[] = [];
  const text = modelText.replace(NUMBER, (token) => {
    const core = token.replace(/,/g, "").replace(/%$/, "");
    if (appears(corpus, core)) {
      return token;
    }
    rejected.push(core);
    return "[ungrounded]";
  });
  return {
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial({ modelText, toolCorpus: [...toolCorpus] }),
    accepted: rejected.length === 0,
    rejectedNumbers: rejected,
    text,
  };
}

function appears(corpus: string, core: string): boolean {
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!\\d)${escaped}(?!\\d)`).test(corpus);
}
