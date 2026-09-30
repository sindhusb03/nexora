/**
 * A scenario is a new projection. The base record is copied and then left alone.
 * Callers that need a durable scenario persist `scenario`, never by editing `base`.
 */
export function projectScenario<T extends Record<string, string>>(
  base: Readonly<T>,
  overrides: Readonly<Partial<T>>,
): { readonly base: T; readonly scenario: T } {
  const frozenBase = { ...base };
  const scenario = { ...base, ...overrides };
  return { base: frozenBase, scenario };
}
