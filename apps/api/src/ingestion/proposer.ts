import { canonicalAccount } from "@nexora/kernel";

/** AI mapping is a proposal. The stub is deterministic so tests and CI do not call a model. */
export interface MappingProposalRequest {
  readonly label: string;
  readonly statementType: string;
  readonly rawText: string;
}

export interface MappingProposal {
  readonly accountCode: string;
  readonly confidence: string;
  readonly rationale: string;
}

export interface ExtractionProposalRow {
  readonly label: string;
  readonly amount: string;
  readonly periodLabel: string;
  readonly statementType: "income_statement" | "balance_sheet";
}

export interface ExtractionProposal {
  readonly rows: readonly ExtractionProposalRow[];
}

export interface MappingProposer {
  propose(input: MappingProposalRequest): Promise<MappingProposal | null>;
  proposeExtraction(input: { fileName: string; text: string }): Promise<ExtractionProposal | null>;
}

const MARKER = /\[ai:([a-z][a-z0-9_]*):([0-9]+(?:\.[0-9]+)?)\]/i;

/**
 * Deterministic stand-in for a hosted mapper.
 * A label may carry `[ai:account_code:0.99]` for an explicit proposal.
 * Anything else is a low-confidence guess and must become an exception.
 */
/** Production proposer. Document text is untrusted, so embedded confidence markers are ignored. */
export function reviewMappingProposer(): MappingProposer {
  return {
    async propose() {
      return null;
    },
    async proposeExtraction() {
      return null;
    },
  };
}

export function stubMappingProposer(): MappingProposer {
  return {
    async proposeExtraction() {
      return null;
    },
    async propose(input) {
      const marker = MARKER.exec(input.label);
      const markedCode = marker?.[1]?.toLowerCase();
      const markedConfidence = marker?.[2];
      if (markedCode && markedConfidence && canonicalAccount(markedCode)) {
        return {
          accountCode: markedCode,
          confidence: markedConfidence,
          rationale: "Deterministic stub accepted an explicit proposal marker",
        };
      }
      const accountCode =
        input.statementType === "income_statement" ? "operating_expenses" : "other_assets";
      return {
        accountCode,
        confidence: "0.62",
        rationale: "Deterministic stub. Confidence is below the auto-accept threshold.",
      };
    },
  };
}
