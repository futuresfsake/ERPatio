/**
 * Small in-process cache for dashboards (US-093). Every key starts with the tenant id, so one workspace can never be served
 * another's numbers. An entry is only reused while the ledger has not moved: the caller passes the tenant's journal sequence as
 * the version, so a posting makes the next request recompute at once; the time limit covers everything that is not in the ledger.
 * This is one process: with several instances each keeps its own copy, which is harmless because every entry is short-lived.
 */
interface Entry { expires: number; version: string; value: unknown }
const store = new Map<string, Entry>();
const MAX_ENTRIES = 2000;

export async function cached<T>(tenantId: string, name: string, ttlMs: number, version: string, compute: () => Promise<T>): Promise<T> {
  const key = `${tenantId}:${name}`;
  const hit = store.get(key);
  const now = Date.now();
  if (hit && hit.expires > now && hit.version === version) return hit.value as T;
  const value = await compute();
  if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value as string); // oldest first
  store.set(key, { expires: now + ttlMs, version, value });
  return value;
}

export const clearCache = (): void => store.clear();
export const cacheSize = (): number => store.size;
