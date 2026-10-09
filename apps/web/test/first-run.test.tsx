import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FirstRun, defaultFiscalYearEnd, fiscalYearEndLabel } from "../app/studio/first-run";

afterEach(() => {
  cleanup();
});

describe("fiscal year end defaults", () => {
  it("uses 31 March for INR and 31 December otherwise", () => {
    expect(defaultFiscalYearEnd("INR")).toEqual({ month: 3, day: 31 });
    expect(defaultFiscalYearEnd(" inr ")).toEqual({ month: 3, day: 31 });
    expect(defaultFiscalYearEnd("USD")).toEqual({ month: 12, day: 31 });
    expect(fiscalYearEndLabel(3, 31)).toBe("31 March");
    expect(fiscalYearEndLabel(2, 31)).toBe("—");
  });
});

describe("first-run stepper", () => {
  it("walks company, currency, and an editable year end", async () => {
    const onOpen = vi.fn(async () => undefined);
    render(<FirstRun busy={false} notice={null} onOpen={onOpen} />);
    expect(screen.getByTestId("first-run")).toBeInTheDocument();
    expect(screen.queryByLabelText(/country/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("first-run-next"));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the company name.");

    fireEvent.change(screen.getByTestId("company-name"), { target: { value: "Harbor Analytics" } });
    fireEvent.click(screen.getByTestId("first-run-next"));
    fireEvent.change(screen.getByTestId("base-currency"), { target: { value: "usd" } });
    fireEvent.click(screen.getByTestId("first-run-next"));
    expect(screen.getByTestId("fye-month")).toHaveValue("12");
    expect(screen.getByTestId("fye-day")).toHaveValue("31");

    fireEvent.click(screen.getByTestId("first-run-back"));
    fireEvent.change(screen.getByTestId("base-currency"), { target: { value: "INR" } });
    fireEvent.click(screen.getByTestId("first-run-next"));
    expect(screen.getByTestId("fye-month")).toHaveValue("3");
    expect(screen.getByTestId("fye-day")).toHaveValue("31");
    expect(screen.getByTestId("first-run")).toHaveTextContent("31 March");

    fireEvent.change(screen.getByTestId("fye-day"), { target: { value: "15" } });
    fireEvent.click(screen.getByTestId("first-run-back"));
    fireEvent.change(screen.getByTestId("base-currency"), { target: { value: "USD" } });
    fireEvent.click(screen.getByTestId("first-run-next"));
    expect(screen.getByTestId("fye-month")).toHaveValue("3");
    expect(screen.getByTestId("fye-day")).toHaveValue("15");

    fireEvent.click(screen.getByTestId("first-run-submit"));
    expect(onOpen).toHaveBeenCalledWith({
      name: "Harbor Analytics",
      currency: "USD",
      fiscalYearEndMonth: 3,
      fiscalYearEndDay: 15,
    });
  });
});
