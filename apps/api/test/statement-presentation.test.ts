import { describe, expect, it } from "vitest";

import { closeRefusal, plainStatementMessage } from "../src/statement-presentation.js";

describe("statement sentences", () => {
  it("gives a missing retained-earnings account its own sentence and one action", () => {
    expect(plainStatementMessage("Entity has no retained earnings account")).toBe(
      "This entity has no retained earnings account.",
    );
    expect(closeRefusal("Entity has no retained earnings account")).toEqual({
      message: "This entity has no retained earnings account.",
      action: "Set the retained earnings account, then close the period.",
    });
    expect(closeRefusal("lease_additions_needed").action).toBe(
      "Fix the flagged accounts, then close the period.",
    );
  });
});
