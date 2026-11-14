/**
 * Webhooks (FR-API-04). Endpoints are https and public only: the address is checked when it is saved and again at the moment of
 * connecting (so a name that later points inside the network is refused), redirects are never followed, and the connection uses
 * the very address that was checked. Each delivery is signed with HMAC-SHA256 over "timestamp.body" using a secret that is shown once.
 */
import { createHmac, randomBytes } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { getEnv } from '../../config/env.js';
import { withOwner, withTenant } from '../../db/pool.js';
import { decryptField, encryptField } from '../../lib/crypto.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { Principal } from '../../lib/security.js';
import { recordAudit } from '../audit/audit.js';
import { WEBHOOK_EVENTS } from '../audit/outbox.js';

const MAX_ENDPOINTS = 10;
const BACKOFF_MINUTES = [1, 5, 30, 120, 360];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
const DISABLE_AFTER = 10;

// ------------------------------------------------------------------ address safety
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
  }
  return true; // not an address at all: treat as unsafe
}

/** Checks what can be checked without the network. */
export function assertWebhookUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ApiError(422, 'invalid_url', 'That is not a valid web address.'); }
  const env = getEnv();
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && env.WEBHOOK_ALLOW_INSECURE)) throw new ApiError(422, 'invalid_url', 'The address must start with https://.');
  if (u.username || u.password) throw new ApiError(422, 'invalid_url', 'Do not put a user name or password in the address.');
  if (u.hash) throw new ApiError(422, 'invalid_url', 'The address cannot have a fragment.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!env.WEBHOOK_ALLOW_PRIVATE) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new ApiError(422, 'invalid_url', 'That address points inside a private network.');
    if (net.isIP(host) && isPrivateAddress(host)) throw new ApiError(422, 'invalid_url', 'That address points inside a private network.');
  }
  return u;
}

/** dns.lookup that refuses private answers; the socket then connects to exactly the address it returns. */
const safeLookup = ((hostname: string, options: dns.LookupOptions, cb: (err: Error | null, address?: string | dns.LookupAddress[], family?: number) => void) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = addrs as dns.LookupAddress[];
    if (!getEnv().WEBHOOK_ALLOW_PRIVATE && list.some((a) => isPrivateAddress(a.address))) return cb(new Error('address not allowed'));
    if (options.all) return cb(null, list);
    return cb(null, list[0]!.address, list[0]!.family);
  });
}) as unknown as net.LookupFunction;

function post(u: URL, body: string, headers: Record<string, string>, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: u.pathname + u.search, method: 'POST', headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) }, lookup: safeLookup, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

export const sign = (secret: string, timestamp: number, body: string): string => createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

// ------------------------------------------------------------------ managing endpoints
const notAKey = (p: Principal) => { if (p.apiKeyId) throw new ApiError(403, 'forbidden', 'An API key cannot manage webhooks.'); };
const EP_COLS = 'id, url, events, is_active, consecutive_failures, disabled_reason, created_at';

export const createEndpoint = (p: Principal, a: { url: string; events: string[] }, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    notAKey(p);
    assertWebhookUrl(a.url);
    const events = [...new Set(a.events)];
    for (const e of events) if (!(WEBHOOK_EVENTS as readonly string[]).includes(e)) throw new ApiError(422, 'invalid_event', `Unknown event: ${e}`);
    const n = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM webhook_endpoints WHERE tenant_id = $1', [p.tenantId])).rows[0]!.n);
    if (n >= MAX_ENDPOINTS) throw new ApiError(409, 'too_many_webhooks', 'Remove a webhook you no longer use first.');
    const secret = 'whsec_' + randomBytes(24).toString('base64url');
    const id = (await c.query<{ id: string }>('INSERT INTO webhook_endpoints (tenant_id, url, secret_enc, events, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [p.tenantId, a.url, await encryptField(c, p.tenantId, secret), events, p.userId])).rows[0]!.id;
    await recordAudit(c, { tenantId: p.tenantId, action: 'webhook.created', actorUserId: p.userId, entityType: 'webhook', entityId: id, ip, detail: { events: events.length } });
    return { ...(await c.query('SELECT ' + EP_COLS + ' FROM webhook_endpoints WHERE tenant_id = $1 AND id = $2', [p.tenantId, id])).rows[0], secret, note: 'Copy the signing secret now. It is not shown again.' };
  });

export const listEndpoints = (p: Principal) =>
  withTenant(p.tenantId, async (c) => { notAKey(p); return (await c.query('SELECT ' + EP_COLS + ' FROM webhook_endpoints WHERE tenant_id = $1 ORDER BY created_at DESC', [p.tenantId])).rows; });

export const updateEndpoint = (p: Principal, id: string, patch: { is_active?: boolean; events?: string[] }, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    notAKey(p);
    if (patch.events) for (const e of patch.events) if (!(WEBHOOK_EVENTS as readonly string[]).includes(e)) throw new ApiError(422, 'invalid_event', `Unknown event: ${e}`);
    const r = await c.query(
      `UPDATE webhook_endpoints SET is_active = COALESCE($3, is_active), events = COALESCE($4, events),
          consecutive_failures = CASE WHEN $3 IS TRUE THEN 0 ELSE consecutive_failures END, disabled_reason = CASE WHEN $3 IS TRUE THEN NULL ELSE disabled_reason END
        WHERE tenant_id = $1 AND id = $2`, [p.tenantId, id, patch.is_active ?? null, patch.events ? [...new Set(patch.events)] : null]);
    if (!r.rowCount) throw notFound('Webhook');
    await recordAudit(c, { tenantId: p.tenantId, action: 'webhook.updated', actorUserId: p.userId, entityType: 'webhook', entityId: id, ip, detail: { fields: Object.keys(patch).sort() } });
    return (await c.query('SELECT ' + EP_COLS + ' FROM webhook_endpoints WHERE tenant_id = $1 AND id = $2', [p.tenantId, id])).rows[0];
  });

export const deleteEndpoint = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    notAKey(p);
    const r = await c.query('DELETE FROM webhook_endpoints WHERE tenant_id = $1 AND id = $2', [p.tenantId, id]);
    if (!r.rowCount) throw notFound('Webhook');
    await recordAudit(c, { tenantId: p.tenantId, action: 'webhook.deleted', actorUserId: p.userId, entityType: 'webhook', entityId: id, ip });
    return { deleted: true };
  });

export const listDeliveries = (p: Principal, id: string) =>
  withTenant(p.tenantId, async (c) => {
    notAKey(p);
    return (await c.query('SELECT id, event, status, attempts, next_attempt_at, last_status_code, last_error, created_at, delivered_at FROM webhook_deliveries WHERE tenant_id = $1 AND endpoint_id = $2 ORDER BY created_at DESC LIMIT 50', [p.tenantId, id])).rows;
  });

/** Queue a test event for one endpoint, whatever it subscribes to. */
export const sendTest = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    notAKey(p);
    const e = (await c.query('SELECT 1 FROM webhook_endpoints WHERE tenant_id = $1 AND id = $2', [p.tenantId, id])).rowCount;
    if (!e) throw notFound('Webhook');
    const d = (await c.query<{ id: string }>(
      `INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event, payload) VALUES ($1, $2, 'ping', jsonb_build_object('event', 'ping'::text, 'occurred_at', now(), 'data', jsonb_build_object('message', 'This is a test.'))) RETURNING id`, [p.tenantId, id])).rows[0]!.id;
    await recordAudit(c, { tenantId: p.tenantId, action: 'webhook.tested', actorUserId: p.userId, entityType: 'webhook', entityId: id, ip });
    return { queued: d };
  });

// ------------------------------------------------------------------ delivery
interface Due { id: string; tenant_id: string; endpoint_id: string; event: string; payload: unknown; attempts: number; url: string; secret_enc: string }

/** One pass of the worker: claims due deliveries (skipping any another worker holds), sends them, records the outcome. Returns how many it tried. */
export async function processDue(limit = 20): Promise<number> {
  return withOwner(async (c) => {
    // System-wide on purpose: the worker serves every workspace. Each delivery carries its own tenant_id for the lookups that follow.
    const due = (await c.query<Due>(
      `SELECT d.id, d.tenant_id, d.endpoint_id, d.event, d.payload, d.attempts, e.url, e.secret_enc
         FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id AND e.tenant_id = d.tenant_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND e.is_active
        ORDER BY d.next_attempt_at LIMIT $1 FOR UPDATE OF d SKIP LOCKED`, [limit])).rows;
    for (const d of due) {
      let code = 0; let error: string | null = null;
      try {
        const secret = await decryptField(c, d.tenant_id, d.secret_enc);
        const body = JSON.stringify({ id: d.id, ...(d.payload as object) });
        const ts = Math.floor(Date.now() / 1000);
        code = await post(assertWebhookUrl(d.url), body, {
          'Content-Type': 'application/json', 'User-Agent': 'ERPatio-Webhooks/1', 'X-ERPatio-Event': d.event, 'X-ERPatio-Delivery': d.id,
          'X-ERPatio-Timestamp': String(ts), 'X-ERPatio-Signature': `v1=${sign(secret, ts, body)}`,
        });
        if (code < 200 || code >= 300) error = `HTTP ${code}`;
      } catch (e) {
        error = (e instanceof Error ? e.message : 'failed').slice(0, 150);
      }
      const attempts = d.attempts + 1;
      if (!error) {
        await c.query("UPDATE webhook_deliveries SET status = 'delivered', attempts = $3, last_status_code = $4, last_error = NULL, delivered_at = now() WHERE tenant_id = $1 AND id = $2", [d.tenant_id, d.id, attempts, code]);
        await c.query('UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE tenant_id = $1 AND id = $2', [d.tenant_id, d.endpoint_id]);
      } else {
        const give = attempts >= MAX_ATTEMPTS;
        await c.query(
          "UPDATE webhook_deliveries SET status = $3, attempts = $4, last_status_code = $5, last_error = $6, next_attempt_at = now() + ($7 || ' minutes')::interval WHERE tenant_id = $1 AND id = $2",
          [d.tenant_id, d.id, give ? 'failed' : 'pending', attempts, code || null, error, String(BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)])]);
        const ep = (await c.query<{ consecutive_failures: number }>('UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1 WHERE tenant_id = $1 AND id = $2 RETURNING consecutive_failures', [d.tenant_id, d.endpoint_id])).rows[0];
        if (ep && ep.consecutive_failures >= DISABLE_AFTER) {
          await c.query("UPDATE webhook_endpoints SET is_active = false, disabled_reason = 'Too many failed deliveries' WHERE tenant_id = $1 AND id = $2", [d.tenant_id, d.endpoint_id]);
          await recordAudit(c, { tenantId: d.tenant_id, action: 'webhook.disabled', entityType: 'webhook', entityId: d.endpoint_id, detail: { reason: 'failures' } });
        }
        logger().warn({ delivery: d.id, attempts, error }, 'webhook delivery failed');
      }
    }
    return due.length;
  });
}

/** Starts the in-process worker. One timer, never overlapping itself. Not started in tests, which call processDue directly. */
export function startWebhookWorker(everyMs = 15_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    processDue().catch((e) => logger().error({ err: e instanceof Error ? e.message : e }, 'webhook worker error')).finally(() => { running = false; });
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
