import type { ReactNode } from "react";

import { smartLedgerApplies, type DataSourceKind } from "./data-source";
import type { ShellSectionGroup } from "./shell";

function aiBadge(): ReactNode {
  return (
    <span className="badge badge-violet" aria-label="Suggested categorization">
      AI
    </span>
  );
}

/** One navigation for the whole product. Smart Ledger is present only for bank and trial balance sources. */
export function productSections(kind: DataSourceKind | null): readonly ShellSectionGroup[] {
  const dataItems: ShellSectionGroup["items"][number][] = [
    { id: "upload", label: "Upload & Map", href: "/classic?section=upload" },
  ];
  if (smartLedgerApplies(kind)) {
    dataItems.push({
      id: "ledger",
      label: "Smart Ledger",
      href: "/classic?section=ledger",
      meta: aiBadge(),
    });
  }

  return [
    {
      label: "Data connections",
      items: dataItems,
    },
    {
      label: "Financial intelligence",
      items: [
        { id: "financials", label: "Actuals", href: "/books?tab=statements" },
        { id: "model", label: "Projections", href: "/program?tab=model" },
        { id: "valuation", label: "Valuation", href: "/program?tab=valuation" },
        { id: "board", label: "Board pack", href: "/program?tab=board" },
      ],
    },
    {
      label: "Operations",
      items: [
        {
          id: "operations",
          label: "AR, AP, inventory, payroll, assets",
          href: "/classic?section=operations",
        },
      ],
    },
    {
      label: "Capital access",
      items: [{ id: "capital", label: "Debt, equity, exit", href: "/program?tab=capital" }],
    },
    {
      label: "Transactions",
      items: [{ id: "deal", label: "Deal", href: "/program?tab=deal" }],
    },
    {
      label: "Administration",
      items: [
        { id: "admin", label: "Admin", href: "/classic?section=admin" },
        { id: "super", label: "Super admin", href: "/classic?section=super" },
        { id: "label", label: "White label / gray label", href: "/classic?section=label" },
      ],
    },
  ];
}
