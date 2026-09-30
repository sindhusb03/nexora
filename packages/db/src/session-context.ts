import { AsyncLocalStorage } from "node:async_hooks";

/** Actor and tenant taken from a verified session. Store transactions copy these into Postgres settings. */
export interface RlsSessionContext {
  readonly actorId: string;
  readonly tenantId: string | null;
}

const storage = new AsyncLocalStorage<RlsSessionContext>();

export function runWithRlsSession<T>(context: RlsSessionContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

export function currentRlsSession(): RlsSessionContext | undefined {
  return storage.getStore();
}
