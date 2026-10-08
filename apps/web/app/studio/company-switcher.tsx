"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Building2, CheckIcon, ChevronDown, Search } from "lucide-react";
import { useMemo, useState } from "react";

import type { CompanyCard } from "./types";

export function CompanySwitcher({
  companies,
  tenantId,
  currentName,
  onSwitch,
}: {
  readonly companies: readonly CompanyCard[];
  readonly tenantId: string;
  readonly currentName: string | null;
  readonly onSwitch: (tenantId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const active = companies.find((company) => company.tenantId === tenantId);
  const name = active?.name || currentName || "No company";
  const normalized = search.trim().toLowerCase();
  const visible = useMemo(() => {
    const ordered = [...companies].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
    if (normalized.length === 0) return ordered;
    return ordered.filter((company) =>
      `${company.name} ${company.region}`.toLowerCase().includes(normalized),
    );
  }, [companies, normalized]);

  return (
    <div className="nx-switcher">
      <span className="nx-nav-label">Workspace</span>
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) setSearch("");
        }}
      >
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" type="button" />}
          data-testid="tenant-switch"
          title={name}
          aria-label={`Company switcher, current: ${name}`}
          className="w-full justify-start px-2"
        >
          <Building2 className="text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left">{name}</span>
          <ChevronDown className="text-muted-foreground" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-2rem)]">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex items-center justify-between gap-2">
              <span>Companies</span>
              <span>{companies.length}</span>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <div className="px-1.5 py-1">
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
                placeholder="Search companies"
                className="h-8 pl-7 text-sm"
                data-testid="company-switcher-search"
                aria-label="Search companies"
              />
            </div>
          </div>
          <DropdownMenuSeparator />
          <div className="max-h-72 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                No companies found
              </p>
            ) : (
              visible.map((company) => {
                const selected = company.tenantId === tenantId;
                return (
                  <DropdownMenuItem
                    key={company.tenantId}
                    onClick={() => onSwitch(company.tenantId)}
                    data-testid={`company-${company.tenantId}`}
                    className="items-start"
                  >
                    <Building2 className="mt-0.5 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{company.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {company.region}
                      </span>
                    </span>
                    {selected ? <CheckIcon className="text-primary" aria-hidden="true" /> : null}
                  </DropdownMenuItem>
                );
              })
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
