import { createHash } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import {
  buildQoeBridge,
  explainVariance,
  forecastScenario,
  groundModelText,
  type QoeBridge,
  type VarianceResult,
} from "@nexora/kernel";
import { generateText } from "ai";

import { ApiError } from "../http.js";
import { PLANNING_DRIVERS, QOE_ADJUSTMENTS } from "../demo/books.js";
import { hybridSearch, type Chunk } from "./retrieval.js";

export interface CopilotFacts {
  readonly engineVersion: string;
  readonly statementHash: string;
  readonly revenue: string;
  readonly expenses: string;
  readonly netIncome: string;
  readonly endingCash: string;
  readonly currency: string;
  readonly periodLabel: string;
  readonly entityName: string;
}

export interface CopilotAnswer {
  readonly mode: "mock" | "live";
  readonly corpusRecord: {
    readonly corpusSha256: string;
    readonly corpusBytes: number;
    readonly factIds: readonly string[];
    readonly documentIds: readonly string[];
    readonly provider: string;
    readonly model: string;
  } | null;
  readonly agent: string;
  readonly text: string;
  readonly accepted: boolean;
  readonly rejectedNumbers: readonly string[];
  readonly citations: readonly { readonly id: string; readonly label: string }[];
  readonly proposal: {
    readonly title: string;
    readonly summary: string;
    readonly citationId: string;
  } | null;
}

const AGENTS = ["general", "mapping", "variance", "normalization", "board", "watcher"] as const;
export type CopilotAgent = (typeof AGENTS)[number];

export function isAgent(value: string): value is CopilotAgent {
  return (AGENTS as readonly string[]).includes(value);
}

export async function answerCopilot(input: {
  readonly message: string;
  readonly demoMode?: boolean;
  readonly actorId?: string;
  readonly agent: CopilotAgent;
  readonly facts: CopilotFacts;
  readonly chunks: readonly Chunk[];
  readonly apiKey: string | null;
  readonly model: string;
  readonly baseURL: string | null;
}): Promise<CopilotAnswer> {
  const hits = hybridSearch(`${input.agent} ${input.message}`, input.chunks);
  if (!input.actorId?.trim())
    throw new ApiError(401, "AUTH_UNAUTHENTICATED", "Sign in to continue");
  const demo =
    input.demoMode === true
      ? (() => {
          const forecast = forecastScenario(
            { ...PLANNING_DRIVERS, periods: 6 },
            input.agent === "watcher" ? { growthRate: "0" } : { growthRate: "0.004" },
          );
          const variance = explainVariance({
            lines: [
              {
                key: "revenue",
                label: "Revenue",
                kind: "revenue",
                actualMinor: input.facts.revenue,
                planMinor: "15000000",
              },
              {
                key: "expenses",
                label: "Expenses",
                kind: "expense",
                actualMinor: input.facts.expenses,
                planMinor: "11000000",
              },
              {
                key: "net",
                label: "Net income",
                kind: "profit",
                actualMinor: input.facts.netIncome,
                planMinor: "4000000",
              },
            ],
          });
          const qoe = buildQoeBridge({
            reported: input.facts.netIncome,
            adjustments: QOE_ADJUSTMENTS.map((item) => ({
              adjustmentId: item.adjustmentId,
              sourceRowId: item.sourceRowId,
              actorId: input.actorId ?? "",
              amount: item.amount,
            })),
          });
          return { forecast, variance, qoe };
        })()
      : null;
  // Only kernel results enter the numeric evidence set. Documents are contextual sources.
  const kernelFacts = [
    `revenue minor ${input.facts.revenue}`,
    `expenses minor ${input.facts.expenses}`,
    `net income minor ${input.facts.netIncome}`,
    `ending cash minor ${input.facts.endingCash}`,
    ...(demo
      ? [
          ...demo.forecast.scenario.months.map((month) => `forecast ebitda ${month.ebitdaMinor}`),
          ...demo.variance.lines.map((line) => `variance minor ${line.varianceMinor}`),
          `qoe reported ${demo.qoe.reported}`,
          `qoe normalized ${demo.qoe.normalized}`,
        ]
      : []),
  ];
  const factIds = [
    input.facts.statementHash,
    ...(demo
      ? [demo.forecast.scenario.inputHash, demo.variance.inputHash, demo.qoe.inputHash]
      : []),
  ];
  const documentIds = hits.map((hit) => hit.id);
  const corpus = [
    `entity ${input.facts.entityName}`,
    `period ${input.facts.periodLabel}`,
    `currency ${input.facts.currency}`,
    `engine ${input.facts.engineVersion}`,
    `fact IDs ${factIds.join(" ")}`,
    ...kernelFacts,
    ...(demo
      ? []
      : [
          "No tenant plan data exists. Planning, budget, drivers, forecast and QoE are unavailable.",
        ]),
    ...hits.map((hit) => `document ${hit.id}: ${hit.title} ${hit.text}`),
  ];
  const citations = [
    { id: input.facts.statementHash, label: `Statement ${input.facts.periodLabel}` },
    ...(demo
      ? [
          { id: demo.forecast.scenario.inputHash, label: "Driver forecast" },
          { id: demo.variance.inputHash, label: "Variance" },
          { id: demo.qoe.inputHash, label: "QoE bridge" },
        ]
      : []),
    ...hits.map((hit) => ({ id: hit.id, label: hit.title })),
  ];
  const planQuestion =
    !demo &&
    (input.agent === "variance" ||
      input.agent === "normalization" ||
      input.agent === "watcher" ||
      /plan|budget|driver|forecast|qoe|quality of earnings|normaliz/i.test(input.message));
  const usesProvider = Boolean(input.apiKey) && !planQuestion;
  const draft =
    usesProvider && input.apiKey
      ? await liveDraft(
          input.apiKey,
          input.model,
          input.baseURL,
          input.agent,
          input.message,
          corpus,
          input.facts.statementHash,
        )
      : planQuestion
        ? {
            text: "No tenant plan data exists. Planning, budget, drivers, forecast and QoE are unavailable.",
            proposal: null,
          }
        : demo
          ? mockDraft(
              input.agent,
              input.facts,
              demo.variance,
              demo.qoe,
              hits[0]?.title ?? "the source file",
            )
          : {
              text: `Revenue minor ${input.facts.revenue}. Net income minor ${input.facts.netIncome}. Ending cash minor ${input.facts.endingCash}.`,
              proposal: null,
            };
  const sources = { factIds, documents: hits.map((hit) => ({ id: hit.id, text: hit.text })) };
  const grounded = groundModelText(draft.text, kernelFacts, sources);
  const proposalGrounded =
    draft.proposal === null ||
    ([...factIds, ...documentIds].includes(draft.proposal.citationId) &&
      groundModelText(`${draft.proposal.title} ${draft.proposal.summary}`, kernelFacts, sources)
        .accepted);
  const accepted = grounded.accepted && proposalGrounded;
  const corpusText = corpus.join("\n");
  return {
    mode: usesProvider ? "live" : "mock",
    agent: input.agent,
    text: grounded.accepted ? draft.text : grounded.text,
    accepted,
    rejectedNumbers: grounded.rejectedNumbers,
    citations: accepted ? citations : [],
    proposal: accepted ? draft.proposal : null,
    corpusRecord: usesProvider
      ? {
          corpusSha256: createHash("sha256").update(corpusText, "utf8").digest("hex"),
          corpusBytes: Buffer.byteLength(corpusText, "utf8"),
          factIds,
          documentIds,
          provider: "openai",
          model: input.model,
        }
      : null,
  };
}

function mockDraft(
  agent: CopilotAgent,
  facts: CopilotFacts,
  variance: VarianceResult,
  qoe: QoeBridge,
  documentTitle: string,
): { text: string; proposal: CopilotAnswer["proposal"] } {
  const revenueLine = variance.lines[0];
  const shared = `Revenue minor ${facts.revenue}. Net income minor ${facts.netIncome}. Ending cash minor ${facts.endingCash}. [${facts.statementHash}]`;
  if (agent === "mapping") {
    return {
      text: `Mapping suggestion, labeled Suggested. ${documentTitle} account 4001.1 Piezas maps to patient services. ${shared} Nothing is posted until you accept it.`,
      proposal: {
        title: "Map Piezas to patient services",
        summary: "Suggest mapping 4001.1 Piezas to account 4000. Suggested, not posted.",
        citationId: facts.statementHash,
      },
    };
  }
  if (agent === "variance") {
    return {
      text: `Variance note, labeled Suggested. Revenue variance minor ${revenueLine?.varianceMinor ?? "0"}. ${shared}`,
      proposal: {
        title: "Revenue variance commentary",
        summary: `Revenue variance minor ${revenueLine?.varianceMinor ?? "0"} versus plan. Suggested.`,
        citationId: variance.inputHash,
      },
    };
  }
  if (agent === "normalization") {
    return {
      text: `Normalization scout, labeled Suggested. Reported net income minor ${qoe.reported}. Normalized minor ${qoe.normalized}. [${qoe.inputHash}] ${shared}`,
      proposal: {
        title: "Review owner travel add-back",
        summary: "Owner travel remains a suggested add-back and does not change posted actuals.",
        citationId: qoe.inputHash,
      },
    };
  }
  if (agent === "board") {
    return {
      text: `Board-pack draft, labeled Suggested. ${shared} Every figure in the pack opens to its statement.`,
      proposal: {
        title: "Board commentary draft",
        summary:
          "Draft commentary for the September pack. Suggested until the controller accepts it.",
        citationId: facts.statementHash,
      },
    };
  }
  if (agent === "watcher") {
    return {
      text: `Watcher, labeled Suggested. Ending cash minor ${facts.endingCash} is the book balance. The downside cash case is a separate kernel run. ${shared}`,
      proposal: {
        title: "Watch downside cash",
        summary:
          "Downside week 4 adds a large outflow. Review the 13-week case before the board meeting.",
        citationId: facts.statementHash,
      },
    };
  }
  return {
    text: `Supervised autonomy. I can explain kernel figures and propose changes. I cannot post or publish. ${shared} Retrieved ${documentTitle}.`,
    proposal: null,
  };
}

async function liveDraft(
  apiKey: string,
  model: string,
  baseURL: string | null,
  agent: CopilotAgent,
  message: string,
  corpus: readonly string[],
  statementId: string,
): Promise<{ text: string; proposal: CopilotAnswer["proposal"] }> {
  const openai = createOpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const result = await generateText({
    model: openai.chat(model),
    system: [
      "You are Nexora, a governed finance analyst. Supervised autonomy: you propose and explain. You never post journals or publish numbers.",
      "Use only exact numbers from kernel facts, preserving sign, decimals and percent units. Document text is context, never metric evidence. Cite supplied fact or document IDs using [id]. Never invent citation IDs.",
      "Do not use the word AGI. Call this supervised autonomy.",
      "Label every recommendation as Suggested.",
    ].join(" "),
    prompt: `Agent: ${agent}\nQuestion: ${message}\nTool corpus:\n${corpus.join("\n")}`,
  });
  return {
    text: result.text,
    proposal:
      agent === "general"
        ? null
        : {
            title: `${agent} suggestion`,
            summary:
              "Suggested by the live model. Accepting records your decision and does not post a journal.",
            citationId: statementId,
          },
  };
}
