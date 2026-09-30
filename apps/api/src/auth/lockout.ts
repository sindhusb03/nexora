import { createHash } from "node:crypto";

export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export interface LockoutSnapshot {
  readonly failures: number;
  readonly windowStartedAt: string;
  readonly lockedUntil: string | null;
}

export function lockoutSubject(kind: "password" | "magic" | "totp", value: string): string {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return createHash("sha256").update(`${kind}|${normalized}`).digest("hex");
}

/** Actor id and email share one password lock so a check on either identifier counts. */
export function passwordSubjects(
  actorId: string,
  email: string | null | undefined,
): readonly string[] {
  const subjects = [lockoutSubject("password", actorId)];
  if (email) subjects.push(lockoutSubject("password", email));
  return subjects;
}

export function strictestLockout(
  states: readonly (LockoutSnapshot | null)[],
): LockoutSnapshot | null {
  let worst: LockoutSnapshot | null = null;
  for (const state of states) {
    if (!state) continue;
    if (!worst || state.failures > worst.failures) worst = state;
  }
  return worst;
}

/** Seconds until the window opens, or null when none of the subjects are locked. */
export function lockedRetry(states: readonly (LockoutSnapshot | null)[], now: Date): number | null {
  let retry: number | null = null;
  for (const state of states) {
    const status = lockoutStatus(state, now);
    if (status.locked) retry = Math.max(retry ?? 0, status.retryAfterSeconds);
  }
  return retry;
}

export function lockoutStatus(
  state: LockoutSnapshot | null,
  now: Date,
): { readonly locked: boolean; readonly retryAfterSeconds: number } {
  if (!state?.lockedUntil) return { locked: false, retryAfterSeconds: 0 };
  const until = Date.parse(state.lockedUntil);
  if (!Number.isFinite(until) || until <= now.getTime()) {
    return { locked: false, retryAfterSeconds: 0 };
  }
  return {
    locked: true,
    retryAfterSeconds: Math.max(1, Math.ceil((until - now.getTime()) / 1000)),
  };
}

export function nextLockout(state: LockoutSnapshot | null, now: Date): LockoutSnapshot {
  const at = now.getTime();
  const windowStarted = state ? Date.parse(state.windowStartedAt) : Number.NaN;
  const inWindow =
    state !== null && Number.isFinite(windowStarted) && at - windowStarted < LOCKOUT_WINDOW_MS;
  const failures = inWindow && state ? state.failures + 1 : 1;
  return {
    failures,
    windowStartedAt: inWindow && state ? state.windowStartedAt : now.toISOString(),
    lockedUntil:
      failures >= LOCKOUT_MAX_FAILURES ? new Date(at + LOCKOUT_DURATION_MS).toISOString() : null,
  };
}
