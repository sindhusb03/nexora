"use client";

import {
  columnFilteringFeature,
  columnPinningFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";

import type { StatementPeriod, StatementRow } from "./types";

const features = tableFeatures({
  columnFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  columnPinningFeature,
});

const helper = createColumnHelper<typeof features, StatementRow>();

function compareMinor(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function StatementGrid({
  periods,
  rows,
  selectedPeriodId,
  onSelectPeriod,
}: {
  readonly periods: readonly StatementPeriod[];
  readonly rows: readonly StatementRow[];
  readonly selectedPeriodId: string;
  readonly onSelectPeriod: (periodId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("label", {
          id: "label",
          header: "Line",
          filterFn: (row, _columnId, filterValue) => {
            const needle = String(filterValue).trim().toLowerCase();
            if (needle.length === 0) return true;
            return `${row.original.label} ${row.original.section}`.toLowerCase().includes(needle);
          },
        }),
        ...periods.map((period, index) =>
          helper.accessor((row) => row.values[index]?.minor ?? "0", {
            id: period.periodId,
            header: period.label,
            cell: (info) => info.row.original.values[index]?.display ?? "",
            sortFn: (left, right) => compareMinor(left.original.values[index]?.minor ?? "0", right.original.values[index]?.minor ?? "0"),
          }),
        ),
      ]),
    [periods],
  );
  const data = useMemo(() => [...rows], [rows]);
  const table = useTable({
    features,
    data,
    columns,
    initialState: { columnPinning: { start: ["label"], end: [] } },
    state: { columnFilters: query.trim().length > 0 ? [{ id: "label", value: query }] : [] },
    onColumnFiltersChange: () => undefined,
  });
  const modelRows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: modelRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 36,
    overscan: 8,
    getItemKey: (index) => modelRows[index]?.id ?? String(index),
  });
  const template = `11.5rem repeat(${periods.length}, minmax(6.5rem, 1fr))`;

  return (
    <div className="nx-grid-wrap">
      <div className="nx-toolbar">
        <label className="nx-search">
          <span>Filter lines</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Revenue, cash, balance" data-testid="statement-filter" />
        </label>
        <p className="nx-muted">{modelRows.length} lines · line column pinned · click a month to drill into journals</p>
      </div>
      <div className="nx-grid-scroll" ref={scrollRef} data-testid="statement-grid">
        <div className="nx-grid-head" style={{ gridTemplateColumns: template }}>
          {table.getHeaderGroups().map((group) =>
            group.headers.map((header) => {
              const pinned = header.column.getIsPinned() === "start";
              const period = periods.find((item) => item.periodId === header.column.id);
              return (
                <button
                  key={header.id}
                  type="button"
                  className={`nx-grid-h ${pinned ? "is-pin" : ""} ${period?.periodId === selectedPeriodId ? "is-on" : ""}`}
                  onClick={() => {
                    if (period) onSelectPeriod(period.periodId);
                    else if (header.column.getCanSort()) header.column.toggleSorting();
                  }}
                >
                  <table.FlexRender header={header} />
                  {header.column.getIsSorted() === "asc" ? " ↑" : null}
                  {header.column.getIsSorted() === "desc" ? " ↓" : null}
                </button>
              );
            }),
          )}
        </div>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = modelRows[item.index];
            if (!row) return null;
            return (
              <div
                key={row.id}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="nx-grid-row"
                style={{ transform: `translateY(${item.start}px)`, gridTemplateColumns: template }}
              >
                {row.getAllCells().map((cell) => {
                  const pinned = cell.column.getIsPinned() === "start";
                  const period = periods.find((entry) => entry.periodId === cell.column.id);
                  return (
                    <button
                      key={cell.id}
                      type="button"
                      className={`nx-grid-c ${pinned ? "is-pin" : ""} ${period?.periodId === selectedPeriodId ? "is-on" : ""} ${row.original.key === "net" || row.original.key === "end" ? "is-total" : ""}`}
                      onClick={() => {
                        if (period) onSelectPeriod(period.periodId);
                      }}
                    >
                      <table.FlexRender cell={cell} />
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        {modelRows.length === 0 ? <p className="nx-empty">No statement lines match that filter.</p> : null}
      </div>
    </div>
  );
}
