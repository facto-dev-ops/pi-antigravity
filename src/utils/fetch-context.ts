import { AsyncLocalStorage } from "node:async_hooks";

export type ScopedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
const transport = new AsyncLocalStorage<ScopedFetch>();

/** Override only this async operation; never alter the host/CLI global dispatcher. */
export function withAntigravityFetch<T>(fetcher: ScopedFetch, operation: () => T): T {
  return transport.run(fetcher, operation);
}

export function scopedAntigravityFetch(): ScopedFetch | undefined {
  return transport.getStore();
}
