"use client";

import { Button } from "@/components/ui/button";

import { type ReactNode } from "react";

import { SuggestedBadge } from "../books/ui";
import type { KernelRecord } from "./api";

export type RunCommand = (
  actorId: string | undefined,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
) => Promise<KernelRecord | null>;

export function WorkbenchHead({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{note}</p>
      </div>
      {children ?? null}
    </header>
  );
}

export function ModelPanel({ disabled, run }: { disabled: boolean; run: RunCommand }) {
  return (
    <section className="panel panel-narrow">
      <WorkbenchHead
        title="Models and scenarios"
        note="The grid is evaluated on the server. A downside scenario leaves the base version unchanged."
      />
      <div className="card">
        <Button
          type="button"
          disabled={disabled}
          onClick={async () => {
            const model = await run(undefined, "/v1/models", { name: "Plan" });
            if (!model || typeof model.modelId !== "string") return;
            const nodes = [
              { id: "y1", type: "timeseries", values: ["10", "12"], period: "0" },
              { id: "y2", type: "timeseries", values: ["10", "12"], period: "1" },
              { id: "linked", type: "link", ref: "y2" },
              { id: "total", type: "aggregate", op: "sum", refs: ["y1", "linked"] },
              { id: "out", type: "output", ref: "total" },
            ];
            const version = await run(undefined, `/v1/models/${model.modelId}/versions`, { nodes });
            if (version && typeof version.modelVersionId === "string") {
              await run(undefined, "/v1/scenarios", {
                baseVersionId: version.modelVersionId,
                name: "Downside",
                base: { growth: "0.05", price: "10" },
                overrides: { growth: "0.01" },
              });
            }
            await run(undefined, `/v1/models/${model.modelId}/calculate`, { nodes });
          }}
        >
          Evaluate 10 + 12 and a downside
        </Button>
      </div>
    </section>
  );
}

export function CapitalPanel({
  disabled,
  entityId,
  run,
}: {
  disabled: boolean;
  entityId: string;
  run: RunCommand;
}) {
  return (
    <section className="panel panel-narrow">
      <WorkbenchHead
        title="Capital"
        note="Schedules reconcile in minor units on the server. These runs do not post journals."
      />
      <div className="card">
        <div className="row-actions">
          <Button
            type="button"
            disabled={disabled}
            onClick={() =>
              void run(undefined, "/v1/capital/debt", {
                entityId,
                name: "Term loan",
                openingMinor: "100000",
                drawMinor: "20000",
                repaymentMinor: "5000",
                accruedInterestMinor: "1000",
              })
            }
          >
            Roll debt
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              void run(undefined, "/v1/capital/cap-table", {
                entityId,
                holdings: [
                  { holderId: "a", commonShares: "60", options: "0", convertibles: "0" },
                  { holderId: "b", commonShares: "40", options: "0", convertibles: "0" },
                ],
              })
            }
          >
            Cap table
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              void run(undefined, "/v1/capital/sources-uses", {
                sources: [
                  { label: "equity", amountMinor: "40000" },
                  { label: "debt", amountMinor: "20000" },
                ],
                uses: [{ label: "purchase", amountMinor: "60000" }],
              })
            }
          >
            Sources and uses
          </Button>
        </div>
      </div>
    </section>
  );
}

export function ImportPanel({ disabled, run }: { disabled: boolean; run: RunCommand }) {
  return (
    <section className="panel panel-narrow">
      <WorkbenchHead
        title="Import and QoE"
        note="The same file is one batch. Adjustments sit beside reported results."
      />
      <div className="card">
        <Button
          type="button"
          disabled={disabled}
          onClick={async () => {
            const batch = await run(
              undefined,
              "/v1/imports",
              { rows: [{ rowNo: 1, account: "1000", amount: "500.00" }] },
              "workspace-file",
            );
            if (!batch || typeof batch.importBatchId !== "string") return;
            await run(undefined, "/v1/qoe", {
              reported: "100",
              adjustments: [{ adjustmentId: "a1", sourceRowId: batch.importBatchId, amount: "15" }],
            });
          }}
        >
          Import and normalize
        </Button>
      </div>
    </section>
  );
}

export function AssistantPanel({
  disabled,
  entityId,
  periodId,
  run,
}: {
  disabled: boolean;
  entityId: string;
  periodId: string;
  run: RunCommand;
}) {
  return (
    <section className="panel panel-narrow">
      <WorkbenchHead
        title="Assistant"
        note="The assistant proposes. The kernel validates, and a person approves before anything is recorded."
      />
      <div className="suggested">
        <div className="suggested-head">
          <SuggestedBadge /> Proposal lane
        </div>
        An uncited number is discarded before it can be shown as a figure. An accepted proposal
        still goes through journal validation, so an unbalanced draft is refused.
      </div>
      <div className="card">
        <div className="row-actions">
          <Button
            type="button"
            disabled={disabled}
            onClick={() =>
              void run(undefined, "/v1/proposals", {
                claims: [{ text: "EBITDA is 115", citationId: null }],
              })
            }
          >
            Propose uncited EBITDA
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              void run(undefined, "/v1/proposals/accept", {
                entityId,
                periodId,
                currency: "USD",
                lines: [
                  { accountId: entityId, debitMinor: "1000", creditMinor: "0" },
                  { accountId: periodId, debitMinor: "0", creditMinor: "900" },
                ],
              })
            }
          >
            Accept unbalanced draft
          </Button>
        </div>
      </div>
    </section>
  );
}

export function DealPanel({
  disabled,
  stateHash,
  run,
}: {
  disabled: boolean;
  stateHash: string;
  run: RunCommand;
}) {
  return (
    <section className="panel panel-narrow">
      <WorkbenchHead
        title="Deal"
        note="The deal copies the state hash and leaves the base assumptions unchanged."
      />
      <div className="card">
        <p className="muted small" style={{ marginTop: 0 }}>
          State hash{" "}
          <code className="hash-wrap">
            {stateHash || "appears after a financial state is drafted"}
          </code>
        </p>
        <Button
          type="button"
          disabled={disabled || stateHash.length !== 64}
          onClick={() =>
            void run(undefined, "/v1/deals", {
              publishedStateHash: stateHash,
              base: { growth: "0.05", price: "10" },
              overrides: { growth: "0.01" },
            })
          }
        >
          Apply downside
        </Button>
      </div>
    </section>
  );
}

export function BasisPanel({ disabled, run }: { disabled: boolean; run: RunCommand }) {
  return (
    <section className="panel panel-narrow">
      <WorkbenchHead
        title="Reporting basis"
        note="Local and group hashes are both stored. Locale leaves the minor units unchanged."
      />
      <div className="card">
        <Button
          type="button"
          disabled={disabled}
          onClick={() =>
            void run(undefined, "/v1/reporting-bases", {
              basisVersion: "local-gaap-2024",
              localBalances: [{ accountId: "local-cash", debitPositiveMinor: "100" }],
              mappings: [{ localAccountId: "local-cash", groupAccountId: "group-cash" }],
            })
          }
        >
          Map local cash
        </Button>
      </div>
    </section>
  );
}
