import type Decimal from "decimal.js";

import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";
import { AnalyticalDecimal } from "./money.js";
import { ANALYTICAL_SCALE, ENGINE_VERSION, MAX_GRAPH_DEPTH, MAX_GRAPH_NODES } from "./version.js";

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

export type FormulaOp = "add" | "sub" | "mul" | "div";

export type CalcNode =
  | { readonly id: string; readonly type: "input"; readonly value: string }
  | {
      readonly id: string;
      readonly type: "formula";
      readonly op: FormulaOp;
      readonly left: string;
      readonly right: string;
    }
  | { readonly id: string; readonly type: "link"; readonly ref: string }
  | {
      readonly id: string;
      readonly type: "timeseries";
      readonly values: readonly string[];
      /** Zero-based period, stored as an integer string so the input hash stays decimal. */
      readonly period?: string;
    }
  | { readonly id: string; readonly type: "aggregate"; readonly op: "sum"; readonly refs: readonly string[] }
  | { readonly id: string; readonly type: "output"; readonly ref: string };

export interface GraphResult {
  readonly engineVersion: string;
  readonly inputHash: string;
  readonly order: readonly string[];
  readonly outputs: Readonly<Record<string, string>>;
}

/**
 * Explicit dependency graph. Cycles fail compilation. There is no iterative
 * solver in this kernel version, so a cycle cannot be waved through.
 */
export function evaluateGraph(nodes: readonly CalcNode[]): GraphResult {
  if (nodes.length === 0) {
    throw new KernelError("CALC_INVALID_NODE", "Calculation graph is empty");
  }
  if (nodes.length > MAX_GRAPH_NODES) {
    throw new KernelError("CALC_INVALID_NODE", "Calculation graph exceeds the node limit");
  }

  const byId = new Map<string, CalcNode>();
  for (const node of nodes) {
    if (node.id.length === 0 || byId.has(node.id)) {
      throw new KernelError("CALC_INVALID_NODE", `Duplicate or empty node id ${node.id}`);
    }
    byId.set(node.id, node);
  }

  const color = new Map<string, 0 | 1 | 2>();
  const order: string[] = [];

  const visit = (id: string, depth: number): void => {
    if (depth > MAX_GRAPH_DEPTH) {
      throw new KernelError("CALC_INVALID_NODE", "Calculation graph exceeds the depth limit");
    }
    const node = byId.get(id);
    if (!node) {
      throw new KernelError("CALC_INVALID_NODE", `Missing node ${id}`);
    }
    const state = color.get(id) ?? 0;
    if (state === 1) {
      throw new KernelError("CALC_CYCLE_DETECTED", `Cycle detected at ${id}`);
    }
    if (state === 2) {
      return;
    }
    color.set(id, 1);
    for (const dependency of dependencies(node)) {
      visit(dependency, depth + 1);
    }
    color.set(id, 2);
    order.push(id);
  };

  for (const node of nodes) {
    visit(node.id, 0);
  }

  const values = new Map<string, Decimal>();
  for (const id of order) {
    const node = byId.get(id);
    if (!node) {
      throw new KernelError("CALC_INVALID_NODE", `Missing node ${id}`);
    }
    values.set(id, evaluateNode(node, values));
  }

  const outputs: Record<string, string> = {};
  for (const node of nodes) {
    if (node.type === "output") {
      const value = values.get(node.id);
      if (!value) {
        throw new KernelError("CALC_INVALID_NODE", `Output ${node.id} was not evaluated`);
      }
      outputs[node.id] = value.toFixed(ANALYTICAL_SCALE);
    }
  }
  if (Object.keys(outputs).length === 0) {
    throw new KernelError("CALC_INVALID_NODE", "Calculation graph has no output");
  }

  return {
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial(nodes),
    order,
    outputs,
  };
}

function dependencies(node: CalcNode): readonly string[] {
  switch (node.type) {
    case "input":
    case "timeseries":
      return [];
    case "output":
    case "link":
      return [node.ref];
    case "formula":
      return [node.left, node.right];
    case "aggregate":
      return node.refs;
    default:
      return [];
  }
}

function evaluateNode(node: CalcNode, values: ReadonlyMap<string, Decimal>): Decimal {
  switch (node.type) {
    case "input":
      return plainDecimal(node.value, node.id);
    case "output":
    case "link":
      return required(values, node.ref);
    case "timeseries": {
      if (node.values.length === 0) {
        throw new KernelError("CALC_INVALID_NODE", `Timeseries ${node.id} is empty`);
      }
      const index = node.period === undefined ? node.values.length - 1 : periodIndex(node.period, node.id);
      const selected = node.values[index];
      if (selected === undefined) {
        throw new KernelError("CALC_INVALID_NODE", `Timeseries ${node.id} index is out of range`);
      }
      return plainDecimal(selected, node.id);
    }
    case "aggregate": {
      if (node.refs.length === 0) {
        throw new KernelError("CALC_INVALID_NODE", `Aggregate ${node.id} has no inputs`);
      }
      let total = new AnalyticalDecimal(0);
      for (const ref of node.refs) {
        total = total.plus(required(values, ref));
      }
      return total;
    }
    case "formula": {
      const left = required(values, node.left);
      const right = required(values, node.right);
      switch (node.op) {
        case "add":
          return left.plus(right);
        case "sub":
          return left.minus(right);
        case "mul":
          return left.mul(right);
        case "div":
          if (right.isZero()) {
            throw new KernelError("CALC_FAILED", `Division by zero at ${node.id}`);
          }
          return left.div(right);
        default:
          throw new KernelError("CALC_INVALID_NODE", "Unsupported formula");
      }
    }
    default:
      throw new KernelError("CALC_INVALID_NODE", "Unsupported node");
  }
}

function periodIndex(period: string, id: string): number {
  if (!/^\d+$/.test(period)) {
    throw new KernelError("CALC_INVALID_NODE", `Timeseries ${id} period is not an integer string`);
  }
  const index = Number(period);
  if (!Number.isSafeInteger(index)) {
    throw new KernelError("CALC_INVALID_NODE", `Timeseries ${id} period is out of range`);
  }
  return index;
}

function plainDecimal(value: string, id: string): Decimal {
  if (!PLAIN_DECIMAL.test(value)) {
    throw new KernelError("CALC_INVALID_NODE", `Node ${id} is not a decimal string`);
  }
  return new AnalyticalDecimal(value);
}

function required(values: ReadonlyMap<string, Decimal>, id: string): Decimal {
  const value = values.get(id);
  if (!value) {
    throw new KernelError("CALC_INVALID_NODE", `Missing value for ${id}`);
  }
  return value;
}
