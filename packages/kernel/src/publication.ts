import { KernelError } from "./errors.js";

export type PublicationStatus =
  "draft" | "validated" | "review" | "approved" | "published" | "rejected";

export type CalculationStatus = "succeeded" | "failed";

const TRANSITIONS: Record<PublicationStatus, readonly PublicationStatus[]> = {
  draft: ["validated", "rejected"],
  validated: ["review", "rejected"],
  review: ["approved", "rejected"],
  approved: ["published", "rejected"],
  published: [],
  rejected: [],
};

export function assertTransition(from: PublicationStatus, to: PublicationStatus): void {
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new KernelError("PUBLISH_BLOCKED", `Cannot transition ${from} to ${to}`);
  }
}

/** A failed calculation cannot become a published financial state. */
export function assertCanPublish(input: {
  readonly calculationStatus: CalculationStatus;
  readonly from: PublicationStatus;
}): void {
  if (input.calculationStatus !== "succeeded") {
    throw new KernelError("PUBLISH_BLOCKED", "Failed calculation cannot publish");
  }
  assertTransition(input.from, "published");
}

/** The actor who prepared a version cannot be the actor who publishes it. */
export function assertMakerChecker(makerActorId: string, checkerActorId: string): void {
  if (makerActorId.length === 0 || checkerActorId.length === 0 || makerActorId === checkerActorId) {
    throw new KernelError("PUBLISH_BLOCKED", "Maker and checker must be different actors");
  }
}
