/**
 * Security events (FR-SEC-11, US-109): permission denials go to the audit log, and a burst raises an alert line.
 * Best effort: a failure here must never change the response the caller gets.
 */
import { withTenant } from '../db/pool.js';
import { recordAudit } from '../modules/audit/audit.js';
import { logger } from './logger.js';
import type { Principal } from './security.js';

const WINDOW_MS = 5 * 60_000;
const BURST = 10;
const seen = new Map<string, number[]>();

export function recordDenied(p: Principal, permission: string, method: string, path: string): void {
  const now = Date.now();
  const hits = (seen.get(p.userId) ?? []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  seen.set(p.userId, hits);
  if (hits.length === BURST)
    logger().warn({ event: 'security_alert', kind: 'permission_denied_burst', user_id: p.userId, count: hits.length, window_s: WINDOW_MS / 1000 }, 'security alert');
  if (seen.size > 5000) for (const [k, v] of seen) if (!v.some((t) => now - t < WINDOW_MS)) seen.delete(k);
  const write: Promise<unknown> = withTenant(p.tenantId, (c) =>
    recordAudit(c, { tenantId: p.tenantId, action: 'security.permission_denied', actorUserId: p.userId, detail: { permission, method, path } }),
  )
    .catch(() => undefined)
    .finally(() => pending.delete(write));
  pending.add(write);
}

const pending = new Set<Promise<unknown>>();
/** Resolves when every in-flight security-event write has finished (graceful shutdown, deterministic tests). */
export const flushSecurityEvents = (): Promise<unknown> => Promise.allSettled([...pending]);

export const resetSecurityEvents = (): void => seen.clear();
