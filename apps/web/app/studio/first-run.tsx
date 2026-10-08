"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type FormEvent, useRef, useState } from "react";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export interface CompanySetup {
  readonly name: string;
  readonly currency: string;
  readonly fiscalYearEndMonth: number;
  readonly fiscalYearEndDay: number;
}

export interface OpenedCompany {
  readonly name: string;
  readonly legalName: string;
  readonly currency: string;
  readonly region: string;
  readonly fiscalYearEndLabel: string | null;
}

/** INR companies default to 31 March. Every other currency defaults to 31 December. */
export function defaultFiscalYearEnd(currency: string): { month: number; day: number } {
  return currency.trim().toUpperCase() === "INR" ? { month: 3, day: 31 } : { month: 12, day: 31 };
}

/** February allows the 29th. A fiscal year end is a month and day, not a calendar date. */
export function daysInFiscalMonth(month: number): number {
  if (month === 2) return 29;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

export function fiscalYearEndLabel(month: number, day: number): string {
  const name = MONTHS[month - 1];
  if (!name || day < 1 || day > daysInFiscalMonth(month)) return "—";
  return `${day} ${name}`;
}

const STEPS = [
  { id: "company", label: "Company" },
  { id: "currency", label: "Currency" },
  { id: "year-end", label: "Year end" },
] as const;

/**
 * First-run company setup. The grid collects a name, a base currency, and a
 * fiscal year end. The kernel records them; this screen does not publish figures.
 */
export function FirstRun(props: {
  readonly busy: boolean;
  readonly notice: string | null;
  readonly onOpen: (setup: CompanySetup) => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [month, setMonth] = useState(12);
  const [day, setDay] = useState(31);
  const [yearEndTouched, setYearEndTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opening = useRef(false);

  function applyCurrency(next: string) {
    const code = next
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 3);
    setCurrency(code);
    if (!yearEndTouched) {
      const fiscal = defaultFiscalYearEnd(code);
      setMonth(fiscal.month);
      setDay(fiscal.day);
    }
  }

  function goNext() {
    if (step === 0 && name.trim().length === 0) {
      setError("Enter the company name.");
      return;
    }
    if (step === 0 && name.trim().length > 200) {
      setError("Company name must be 200 characters or fewer.");
      return;
    }
    if (step === 1 && !/^[A-Z]{3}$/.test(currency)) {
      setError("Enter a three-letter currency code.");
      return;
    }
    setError(null);
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  }

  async function finish() {
    if (opening.current || props.busy) return;
    if (day > daysInFiscalMonth(month)) {
      setError("That day does not fall in the selected month.");
      return;
    }
    opening.current = true;
    setError(null);
    try {
      await props.onOpen({
        name: name.trim(),
        currency,
        fiscalYearEndMonth: month,
        fiscalYearEndDay: day,
      });
    } finally {
      opening.current = false;
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step < STEPS.length - 1) goNext();
    else void finish();
  }

  const message = error ?? props.notice;
  const yearLabel = fiscalYearEndLabel(month, day);

  return (
    <section className="nx-setup" data-testid="first-run" aria-label="Open your company">
      <ol className="nx-setup-steps">
        {STEPS.map((item, index) => (
          <li key={item.id} aria-current={index === step ? "step" : undefined}>
            <span>{index + 1}</span>
            <span>{item.label}</span>
          </li>
        ))}
      </ol>
      <form onSubmit={(event) => void onSubmit(event)}>
        {step === 0 ? (
          <div className="nx-field-grid">
            <p className="nx-kicker nx-span">Company</p>
            <h1 className="nx-span" id="setup-company">
              Name the company
            </h1>
            <p className="nx-lede nx-span">
              This becomes the company you own. The kernel creates it in your region.
            </p>
            <label htmlFor="company-name">Company name</label>
            <Input
              id="company-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="organization"
              data-testid="company-name"
              required
            />
          </div>
        ) : null}
        {step === 1 ? (
          <div className="nx-field-grid">
            <p className="nx-kicker nx-span">Currency</p>
            <h1 className="nx-span">Base currency</h1>
            <p className="nx-lede nx-span">
              Functional currency for this company&apos;s books. INR sets the year end to 31 March.
              Any other code sets it to 31 December. You can change that date on the next step.
            </p>
            <label htmlFor="base-currency">ISO code</label>
            <Input
              id="base-currency"
              value={currency}
              onChange={(event) => applyCurrency(event.target.value)}
              maxLength={3}
              spellCheck={false}
              autoComplete="off"
              className="uppercase"
              data-testid="base-currency"
              required
            />
          </div>
        ) : null}
        {step === 2 ? (
          <div className="nx-field-grid">
            <p className="nx-kicker nx-span">Year end</p>
            <h1 className="nx-span">Fiscal year end</h1>
            <p className="nx-lede nx-span">
              {currency === "INR"
                ? "Indian companies default to 31 March."
                : "The default year end is 31 December."}{" "}
              Change it if {name.trim() || "this company"} closes on another day. Current year end:{" "}
              <strong className="tabular-nums">{yearLabel}</strong>.
            </p>
            <label htmlFor="fye-month">Month and day</label>
            <div className="nx-fye">
              <select
                id="fye-month"
                data-testid="fye-month"
                value={String(month)}
                onChange={(event) => {
                  const nextMonth = Number(event.target.value);
                  setYearEndTouched(true);
                  setMonth(nextMonth);
                  setDay((current) => Math.min(current, daysInFiscalMonth(nextMonth)));
                }}
              >
                {MONTHS.map((label, index) => (
                  <option key={label} value={String(index + 1)}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                id="fye-day"
                aria-label="Fiscal year end day"
                data-testid="fye-day"
                value={String(day)}
                onChange={(event) => {
                  setYearEndTouched(true);
                  setDay(Number(event.target.value));
                }}
              >
                {Array.from({ length: daysInFiscalMonth(month) }, (_, index) => index + 1).map(
                  (value) => (
                    <option key={value} value={String(value)}>
                      {value}
                    </option>
                  ),
                )}
              </select>
            </div>
          </div>
        ) : null}
        {message ? (
          <p className="nx-notice" role="alert" data-testid="first-run-notice">
            {message}
          </p>
        ) : null}
        <div className="nx-setup-actions">
          {step > 0 ? (
            <Button
              type="button"
              variant="outline"
              data-testid="first-run-back"
              onClick={() => {
                setError(null);
                setStep((current) => current - 1);
              }}
            >
              Back
            </Button>
          ) : null}
          {step < STEPS.length - 1 ? (
            <Button type="button" data-testid="first-run-next" onClick={goNext}>
              Continue
            </Button>
          ) : (
            <Button
              type="button"
              disabled={props.busy}
              data-testid="first-run-submit"
              onClick={() => void finish()}
            >
              {props.busy ? "Opening company" : "Open company"}
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

/** Company the kernel just opened. Figures stay hidden until the books can produce statements. */
export function CompanyHome({ company }: { readonly company: OpenedCompany }) {
  return (
    <section className="nx-stack" data-testid="company-home">
      <header className="nx-page-head">
        <div>
          <p className="nx-kicker">Company</p>
          <h1>{company.name}</h1>
          <p className="nx-lede">
            The kernel recorded this company and its legal entity. Statement figures stay hidden
            until the books have a retained-earnings account and a period.
          </p>
        </div>
      </header>
      <dl className="nx-home-facts">
        <div>
          <dt>Legal entity</dt>
          <dd>{company.legalName}</dd>
        </div>
        <div>
          <dt>Base currency</dt>
          <dd className="tabular-nums">{company.currency}</dd>
        </div>
        <div>
          <dt>Region</dt>
          <dd>{company.region || "—"}</dd>
        </div>
        <div>
          <dt>Fiscal year end</dt>
          <dd className="tabular-nums">{company.fiscalYearEndLabel ?? "—"}</dd>
        </div>
      </dl>
    </section>
  );
}
