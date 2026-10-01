import "@testing-library/jest-dom/vitest";
import { HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE } from "@nexora/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AcceptButton } from "../app/review/accept-action";

const values = {
  expected: null,
  actual: null as string | null,
  diff: null,
  currency: "USD" as const,
};

afterEach(() => {
  cleanup();
});

describe("accept action", () => {
  it.each(["expected", "actual", "diff"] as const)(
    "disables Accept with an accessible explanation for non-null %s",
    (field) => {
      render(
        <AcceptButton
          exception={{ type: "header_as_value", values: { ...values, [field]: "0" } }}
          canResolve
          selected={false}
          onSelect={vi.fn()}
        />,
      );
      expect((screen.getByTestId("action-accept") as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByRole("button", { name: "Accept" })).toHaveAccessibleDescription(
        HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE,
      );
      expect(screen.getByTestId("action-accept-wrap").getAttribute("title")).toBe(
        HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE,
      );
    },
  );

  it("leaves Accept available when the header has no number", () => {
    const onSelect = vi.fn();
    render(
      <AcceptButton
        exception={{ type: "header_as_value", values }}
        canResolve
        selected={false}
        onSelect={onSelect}
      />,
    );
    const button = screen.getByTestId("action-accept") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.getByTestId("action-accept-wrap").hasAttribute("title")).toBe(false);
    button.click();
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
