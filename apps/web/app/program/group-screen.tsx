"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CopyIcon } from "lucide-react";

import { useEffect, useMemo, useState } from "react";

import {
  listAccounts,
  listConsolidationGroups,
  listPeriods,
  type Account,
  type ConsolidationGroup,
  type Entity,
  type Period,
  type Session,
} from "../books/api";
import { useAction, useResource, type Resource } from "../books/hooks";
import { ErrorNotice } from "../books/ui";
import { shortHash } from "../studio/format";
import { kernelCall } from "./api";
import {
  buildTranslateRequest,
  decodeTranslation,
  displayRows,
  explainConsolidationError,
  controlBalanceLabel,
  formatMinorAccounting,
  rateTypeLabel,
  type RateTripleInput,
  type RateType,
  type TranslationView,
} from "./group-translate";
import { WorkbenchHead } from "./workbench";

export function GroupScreen({
  session,
  entities,
  disabled,
}: {
  session: Session;
  entities: Resource<readonly Entity[]>;
  disabled: boolean;
}) {
  const { resource: groupResource } = useResource(
    `groups:${session.tenantId}:${session.actorId}`,
    () => listConsolidationGroups(session),
  );
  const createAction = useAction();
  const translateAction = useAction();
  const [groupName, setGroupName] = useState("Group");
  const [reportingCurrency, setReportingCurrency] = useState("EUR");
  const [createdGroups, setCreatedGroups] = useState<readonly ConsolidationGroup[]>([]);
  const [groupId, setGroupId] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [periodByEntity, setPeriodByEntity] = useState<Record<string, string>>({});
  const [periodsByEntity, setPeriodsByEntity] = useState<Record<string, readonly Period[]>>({});
  const [accountsByEntity, setAccountsByEntity] = useState<Record<string, readonly Account[]>>({});
  const [scopeStatus, setScopeStatus] = useState<"idle" | "loading" | "ready">("idle");
  const [scopeError, setScopeError] = useState<{
    code: string;
    message: string;
    status: number;
  } | null>(null);
  const [ctaAccountId, setCtaAccountId] = useState("cta");
  const [rates, setRates] = useState<Record<string, RateTripleInput>>({});
  const [submittedRates, setSubmittedRates] = useState<Record<string, RateTripleInput>>({});
  const [formNote, setFormNote] = useState<string | null>(null);
  const [result, setResult] = useState<TranslationView | null>(null);

  const listed = groupResource.status === "ready" ? groupResource.data : EMPTY_GROUPS;
  const groupRows = useMemo(() => {
    const known = new Set(listed.map((group) => group.consolidationGroupId));
    const extras = createdGroups.filter((group) => !known.has(group.consolidationGroupId));
    return extras.length === 0 ? listed : [...listed, ...extras];
  }, [listed, createdGroups]);
  const group = groupRows.find((row) => row.consolidationGroupId === groupId) ?? null;
  const entityRows = entities.status === "ready" ? entities.data : [];
  const selectedEntities = entityRows.filter((entity) => selectedIds.includes(entity.entityId));
  const selectedKey = selectedIds.slice().sort().join(",");
  const currencies = [
    ...new Set(selectedEntities.map((entity) => entity.functionalCurrency)),
  ].sort();
  const periodsReady = selectedEntities.every(
    (entity) => (periodByEntity[entity.entityId] ?? "").length > 0,
  );
  const ratesReady = currencies.every((currency) => {
    const rate = rates[currency];
    return filled(rate?.closing) && filled(rate?.historical) && filled(rate?.average);
  });
  const translateReady =
    group !== null && selectedEntities.length > 0 && periodsReady && ratesReady;

  useEffect(() => {
    if (groupId.length > 0 || groupRows.length === 0) return;
    const first = groupRows[0];
    if (first) setGroupId(first.consolidationGroupId);
  }, [groupId, groupRows]);

  useEffect(() => {
    if (selectedIds.length === 0) {
      setPeriodsByEntity({});
      setAccountsByEntity({});
      setScopeStatus("idle");
      setScopeError(null);
      return;
    }
    let cancelled = false;
    setScopeStatus("loading");
    setScopeError(null);
    void (async () => {
      const periods: Record<string, readonly Period[]> = {};
      const accounts: Record<string, readonly Account[]> = {};
      for (const id of selectedIds) {
        const [periodResult, accountResult] = await Promise.all([
          listPeriods(session, id),
          listAccounts(session, id),
        ]);
        if (cancelled) return;
        if (!periodResult.ok) {
          setScopeError({ ...periodResult.error, status: periodResult.status });
          setScopeStatus("idle");
          return;
        }
        if (!accountResult.ok) {
          setScopeError({ ...accountResult.error, status: accountResult.status });
          setScopeStatus("idle");
          return;
        }
        periods[id] = periodResult.data;
        accounts[id] = accountResult.data;
      }
      if (cancelled) return;
      setPeriodsByEntity(periods);
      setAccountsByEntity(accounts);
      setScopeStatus("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [session, selectedKey]);

  useEffect(() => {
    if (scopeStatus !== "ready") return;
    setPeriodByEntity((current) => {
      const next = { ...current };
      let changed = false;
      for (const id of selectedIds) {
        const periods = periodsByEntity[id] ?? [];
        if (periods.some((period) => period.periodId === next[id])) continue;
        const latest = [...periods].sort((left, right) =>
          left.endDate < right.endDate ? 1 : left.endDate > right.endDate ? -1 : 0,
        )[0];
        if (!latest) continue;
        next[id] = latest.periodId;
        changed = true;
      }
      for (const key of Object.keys(next)) {
        if (!selectedIds.includes(key)) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [scopeStatus, periodsByEntity, selectedIds]);

  const rows = useMemo(() => {
    if (!result) return [];
    return displayRows(result, {
      entityName: (id) => entityRows.find((entity) => entity.entityId === id)?.legalName ?? id,
      accountName: (accountId) => accountLabel(accountsByEntity, accountId),
      rateFor: (currency, rateType) => submittedRates[currency]?.[rateType] ?? null,
    });
  }, [result, entityRows, accountsByEntity, submittedRates]);
  const balance = result ? controlBalanceLabel(result.controlTotalMinor) : null;

  async function createGroup() {
    const name = groupName.trim();
    const currency = reportingCurrency.trim().toUpperCase();
    if (name.length === 0 || !/^[A-Z]{3}$/.test(currency)) {
      setFormNote("Enter a group name and a 3-letter reporting currency, for example EUR.");
      return;
    }
    setFormNote(null);
    const data = await createAction.run(() =>
      kernelCall(session, "POST", "/v1/consolidation-groups", {
        name,
        reportingCurrency: currency,
      }),
    );
    const id =
      data && typeof data.consolidationGroupId === "string" ? data.consolidationGroupId : null;
    if (!id) return;
    setCreatedGroups((current) => [
      ...current,
      { consolidationGroupId: id, name, reportingCurrency: currency },
    ]);
    setGroupId(id);
    setResult(null);
  }

  async function translate() {
    if (!group) {
      setFormNote("Choose a consolidation group first.");
      return;
    }
    if (selectedEntities.length === 0) {
      setFormNote("Choose at least one entity in this company.");
      return;
    }
    const scoped = selectedEntities.flatMap((entity) => {
      const periodId = periodByEntity[entity.entityId];
      return periodId
        ? [{ entityId: entity.entityId, periodId, currency: entity.functionalCurrency }]
        : [];
    });
    if (scoped.length !== selectedEntities.length) {
      setFormNote("Choose a period for every entity in the translation.");
      return;
    }
    setFormNote(null);
    setResult(null);
    const body = buildTranslateRequest({
      ctaAccountId,
      reportingCurrency: group.reportingCurrency,
      entities: scoped,
      rates,
    });
    const data = await translateAction.run(() =>
      kernelCall(
        session,
        "POST",
        `/v1/consolidation-groups/${group.consolidationGroupId}/translate`,
        body,
      ),
    );
    if (!data) return;
    const view = decodeTranslation(data);
    if (!view) {
      setFormNote("The kernel response did not include a translated trial balance.");
      return;
    }
    setSubmittedRates(rates);
    setResult(view);
  }

  const translateError = translateAction.state.error;
  const explained = translateError
    ? explainConsolidationError(
        translateAction.state.httpStatus ?? 0,
        translateError.code,
        translateError.message,
      )
    : null;

  return (
    <section className="panel" data-testid="group-screen">
      <WorkbenchHead
        title="Group and FX"
        note="CTA is an explicit equity line. The entity books stay in their functional currency. Intercompany eliminations are a follow-up."
      />

      {groupResource.status === "loading" || groupResource.status === "idle" ? (
        <div className="grid gap-2" aria-busy="true" aria-label="Loading consolidation groups">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : null}
      {groupResource.status === "error" ? (
        <ErrorNotice error={groupResource.error} httpStatus={groupResource.httpStatus} />
      ) : null}

      {groupResource.status === "ready" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Consolidation scope</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_7rem_auto] sm:items-end">
                <Label className="grid gap-1.5">
                  Group name
                  <Input
                    value={groupName}
                    onChange={(event) => {
                      setGroupName(event.target.value);
                      setResult(null);
                    }}
                  />
                </Label>
                <Label className="grid gap-1.5">
                  Reporting currency
                  <Input
                    value={reportingCurrency}
                    maxLength={3}
                    onChange={(event) => {
                      setReportingCurrency(event.target.value.toUpperCase());
                      setResult(null);
                    }}
                  />
                </Label>
                <Button
                  type="button"
                  disabled={disabled || createAction.state.pending}
                  onClick={() => void createGroup()}
                >
                  {createAction.state.pending ? "Creating…" : "Create group"}
                </Button>
              </div>
              {createAction.state.error ? (
                <ErrorNotice
                  error={createAction.state.error}
                  httpStatus={createAction.state.httpStatus}
                />
              ) : null}
              {groupRows.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyDescription>
                      No consolidation groups yet. Create one to translate.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <Label className="grid gap-1.5">
                  Consolidation group
                  <NativeSelect
                    className="w-full"
                    value={groupId}
                    onChange={(event) => {
                      setGroupId(event.target.value);
                      setResult(null);
                    }}
                  >
                    <NativeSelectOption value="">Select a group</NativeSelectOption>
                    {groupRows.map((row) => (
                      <NativeSelectOption
                        key={row.consolidationGroupId}
                        value={row.consolidationGroupId}
                      >
                        {row.name} · {row.reportingCurrency}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Label>
              )}
              {group ? (
                <p className="text-sm" data-testid="reporting-currency">
                  Reporting currency <strong>{group.reportingCurrency}</strong>
                </p>
              ) : null}

              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">Entities in this translation</legend>
                {entities.status === "loading" || entities.status === "idle" ? (
                  <div aria-busy="true">
                    <Skeleton className="h-4 w-1/2" />
                  </div>
                ) : null}
                {entities.status === "error" ? (
                  <ErrorNotice error={entities.error} httpStatus={entities.httpStatus} />
                ) : null}
                {entities.status === "ready" && entityRows.length === 0 ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyDescription>This company has no entities.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : null}
                {entities.status === "ready"
                  ? entityRows.map((entity) => {
                      const inputId = `entity-${entity.entityId}`;
                      const labelId = `include-${entity.entityId}`;
                      return (
                        <div key={entity.entityId} className="flex items-center gap-2">
                          <Checkbox
                            id={inputId}
                            aria-labelledby={labelId}
                            checked={selectedIds.includes(entity.entityId)}
                            onCheckedChange={(checked) => {
                              setSelectedIds((current) =>
                                checked
                                  ? [...current, entity.entityId]
                                  : current.filter((id) => id !== entity.entityId),
                              );
                              setResult(null);
                            }}
                          />
                          <Label id={labelId} htmlFor={inputId} className="font-normal">
                            Include {entity.legalName} ({entity.functionalCurrency})
                          </Label>
                        </div>
                      );
                    })
                  : null}
              </fieldset>

              {selectedEntities.map((entity) => (
                <Label key={entity.entityId} className="grid gap-1.5">
                  Period for {entity.legalName}
                  <NativeSelect
                    className="w-full"
                    value={periodByEntity[entity.entityId] ?? ""}
                    disabled={scopeStatus !== "ready"}
                    onChange={(event) => {
                      setPeriodByEntity((current) => ({
                        ...current,
                        [entity.entityId]: event.target.value,
                      }));
                      setResult(null);
                    }}
                  >
                    <NativeSelectOption value="">
                      {scopeStatus === "loading" ? "Loading periods…" : "Select a period"}
                    </NativeSelectOption>
                    {(periodsByEntity[entity.entityId] ?? []).map((period) => (
                      <NativeSelectOption key={period.periodId} value={period.periodId}>
                        {period.startDate} → {period.endDate}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Label>
              ))}
              {scopeError ? (
                <ErrorNotice error={scopeError} httpStatus={scopeError.status} />
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Rates and CTA</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Label className="grid gap-1.5">
                CTA equity account
                <Input
                  value={ctaAccountId}
                  onChange={(event) => {
                    setCtaAccountId(event.target.value);
                    setResult(null);
                  }}
                />
              </Label>
              <p className="text-muted-foreground text-sm">
                The CTA account is the translation plug. It must not match an account already in the
                entity books. Amounts are read from posted journals.
              </p>
              {currencies.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyDescription>Choose an entity to enter its rates.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="grid gap-2" data-testid="rate-grid">
                  <div className="text-muted-foreground grid grid-cols-[5.5rem_1fr_1fr_1fr] gap-2 text-xs font-medium">
                    <span>Currency</span>
                    <span>Closing</span>
                    <span>Historical</span>
                    <span>Average</span>
                  </div>
                  {currencies.map((currency) => (
                    <div key={currency} className="grid gap-2">
                      {group && currency === group.reportingCurrency ? (
                        <p className="text-sm">
                          This entity already uses the group currency. Closing, historical, and
                          average must each be exactly 1.
                        </p>
                      ) : null}
                      <div className="grid grid-cols-[5.5rem_1fr_1fr_1fr] items-center gap-2">
                        <span className="text-sm font-medium">{currency}</span>
                        {(["closing", "historical", "average"] as const).map((rateType) => {
                          const value = rates[currency]?.[rateType] ?? "";
                          const inputId = `rate-${currency}-${rateType}`;
                          return (
                            <div key={rateType}>
                              <Label className="sr-only" htmlFor={inputId}>
                                {rateFieldLabel(rateType, currency, group?.reportingCurrency ?? "")}
                              </Label>
                              <Input
                                id={inputId}
                                inputMode="decimal"
                                value={value}
                                aria-invalid={!filled(value)}
                                onChange={(event) => {
                                  const next = event.target.value;
                                  setRates((current) => ({
                                    ...current,
                                    [currency]: {
                                      closing: current[currency]?.closing ?? "",
                                      historical: current[currency]?.historical ?? "",
                                      average: current[currency]?.average ?? "",
                                      [rateType]: next,
                                    },
                                  }));
                                  setResult(null);
                                }}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  data-testid="translate-group"
                  disabled={disabled || translateAction.state.pending || !translateReady}
                  onClick={() => void translate()}
                >
                  {translateAction.state.pending ? "Translating…" : "Translate"}
                </Button>
              </div>
              {formNote ? (
                <p className="notice notice-quiet" role="status">
                  {formNote}
                </p>
              ) : null}
              {explained ? (
                <Alert variant="destructive" data-testid="translate-error">
                  <AlertTitle>{explained.title}</AlertTitle>
                  <AlertDescription>
                    <p>{explained.detail}</p>
                    <p>{translateError?.code}</p>
                  </AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {translateAction.state.pending ? (
        <div className="mt-4 grid gap-2" aria-busy="true" aria-label="Translating posted balances">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : null}

      {result ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Translated group trial balance</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p className="text-sm">
              {result.groupCurrency}, exact amounts. Source amounts stay in each entity currency.
              Translated amounts are {result.groupCurrency}.
            </p>
            <Table aria-label="Translated group trial balance">
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead className="text-right">Source amount</TableHead>
                  <TableHead>Rate type</TableHead>
                  <TableHead className="text-right">Translated amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.key} data-testid={row.cta ? "cta-line" : undefined}>
                    <TableCell>
                      <div>{row.accountLabel}</div>
                      <div className="text-muted-foreground text-xs">{row.accountId}</div>
                    </TableCell>
                    <TableCell>{row.entityLabel}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMinorAccounting(
                        row.sourceMinor,
                        row.sourceCurrency ?? result.groupCurrency,
                      )}
                    </TableCell>
                    <TableCell>
                      <span title={rateTitle(row.rate, row.sourceCurrency, result.groupCurrency)}>
                        {rateTypeLabel(row.rateType)}
                        {row.rate ? ` · ${row.rate}` : ""}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMinorAccounting(row.translatedMinor, result.groupCurrency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={4}>Control total</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMinorAccounting(result.controlTotalMinor, result.groupCurrency)}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={balance?.balances ? "secondary" : "destructive"}
                data-testid="zero-sum"
              >
                {balance?.label}
              </Badge>
              <span className="text-muted-foreground text-sm">
                CTA {formatMinorAccounting(result.ctaMinor, result.groupCurrency)}
              </span>
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <HashFact label="Input hash" value={result.inputHash} testId="input-hash" />
              <HashFact label="Output hash" value={result.outputHash} testId="output-hash" />
              <HashFact
                label="Calculation run"
                value={result.calculationRunId}
                testId="calculation-run"
              />
              <div>
                <dt className="text-muted-foreground">Formula</dt>
                <dd>
                  <code>{result.formulaVersion ?? "—"}</code>
                  {result.engineVersion ? <span> · {result.engineVersion}</span> : null}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

const EMPTY_GROUPS: readonly ConsolidationGroup[] = [];

function filled(value: string | undefined): boolean {
  return (value ?? "").trim().length > 0;
}

function accountLabel(
  accountsByEntity: Record<string, readonly Account[]>,
  accountId: string,
): string {
  for (const accounts of Object.values(accountsByEntity)) {
    const match = accounts.find((account) => account.accountId === accountId);
    if (match) return `${match.code} ${match.name}`;
  }
  return accountId;
}

function rateFieldLabel(rateType: RateType, source: string, quote: string): string {
  const pair = quote.length > 0 ? `${source} to ${quote}` : source;
  switch (rateType) {
    case "closing":
      return `Closing rate, ${pair}`;
    case "historical":
      return `Historical rate, ${pair}`;
    case "average":
      return `Average rate, ${pair}`;
  }
}

function rateTitle(rate: string | null, source: string | null, quote: string): string | undefined {
  if (!rate || !source) return undefined;
  return `${rate} ${quote} per 1 ${source}`;
}

function HashFact({ label, value, testId }: { label: string; value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="font-mono text-xs"
                data-testid={testId}
                data-hash={value}
              >
                {shortHash(value)}
              </button>
            }
          />
          <TooltipContent className="max-w-sm font-mono break-all">{value}</TooltipContent>
        </Tooltip>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Copy ${label}`}
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          <CopyIcon />
          <span className="sr-only">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </dd>
    </div>
  );
}
