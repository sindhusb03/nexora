/** Calculation-engine version. Independent of the HTTP API version. */
export const ENGINE_VERSION = "fe-kernel-0.3.0";

/** Analytical outputs are fixed-point strings at this scale. Ledger amounts stay integer minor units. */
export const ANALYTICAL_SCALE = 12;

export const MAX_JOURNAL_LINES = 10_000;
export const MAX_GRAPH_NODES = 10_000;
export const MAX_GRAPH_DEPTH = 256;
