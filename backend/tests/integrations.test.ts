import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getEnv, resetEnvCache } from '../src/config/env.js';
import { withTenant } from '../src/db/pool.js';
import { resetApiKeyLimits } from '../src/modules/apikeys/service.js';
import { recordAudit } from '../src/modules/audit/audit.js';
import { isPrivateAddress, processDue } from '../src/modules/webhooks/service.js';
import { accountIds, auth, newApi, owner, resetData, seedPlatform, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

let api: Api;
let t: Seeded;
let acc: Record<string, string>;
let adm: string;
let fin: string;
let vic: string;
const hold = { status: 204, requests: [] as { headers: http.IncomingHttpHeaders; body: string }[] };
let server: http.Server;
let hookUrl: string;

beforeAll(async () => {
  api = newApi();
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => { hold.requests.push({ headers: req.headers, body }); res.statusCode = hold.status; res.end(); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});
beforeEach(async () => {
  await resetData();
  resetApiKeyLimits();
  hold.status = 204;
  hold.requests.length = 0;
  t = await seedTenant('int-co', { adm: ['TenantAdmin'], fin: ['FinanceManager'], vic: ['Viewer'] }, false, { modules: ['finance', 'supply_chain', 'bi'] });
  [adm, fin, vic] = await Promise.all([tokenFor(api, t, 'adm'), tokenFor(api, t, 'fin'), tokenFor(api, t, 'vic')]);
  acc = await accountIds(t.tenantId);
});
const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; resetEnvCache(); });
afterAll(async () => { await new Promise((r) => server.close(r)); await shutdown(); });

const mkKey = async (permissions: string[], extra: object = {}, tok = adm) => (await api.post('/api/v1/api-keys').set(auth(tok)).send({ name: 'ERP link', permissions, ...extra }).expect(201)).body as { id: string; key: string; key_prefix: string };

describe('API keys', () => {
  it('shows the key once, stores only a hash, and never lists it', async () => {
    const k = await mkKey(['accounts:read']);
    expect(k.key.startsWith('erpk_')).toBe(true);
    const row = (await owner.query('SELECT key_hash, key_prefix FROM api_keys WHERE id = $1', [k.id])).rows[0];
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(k.key);
    const list = (await api.get('/api/v1/api-keys').set(auth(adm)).expect(200)).body;
    expect(JSON.stringify(list)).not.toContain(k.key);
    expect(list[0]).toMatchObject({ name: 'ERP link', key_prefix: k.key_prefix });
  });

  it('works as a bearer token for what it was given, and nothing else', async () => {
    const k = await mkKey(['accounts:read', 'receivables:read']);
    expect((await api.get('/api/v1/accounts').set(auth(k.key)).expect(200)).body.length).toBeGreaterThan(5);
    expect((await api.get('/api/v1/invoices').set(auth(k.key)).expect(200)).body.total).toBe(0);
    expect((await api.post('/api/v1/accounts').set(auth(k.key)).send({ code: '9999', name: 'x', type: 'asset' })).status).toBe(403);
    expect((await api.get('/api/v1/journal-entries').set(auth(k.key))).status).toBe(403);
    expect((await api.get('/api/v1/auth/me').set(auth(k.key))).status).toBeLessThan(500);
    expect((await api.get('/api/v1/accounts').set(auth(k.key + 'x'))).status).toBe(401);
    expect((await api.get('/api/v1/accounts').set(auth('erpk_notakey'))).status).toBe(401);
  });

  it('can never hold administration, approval, pay, export or key management, even if the row is edited', async () => {
    for (const p of ['users:manage', 'roles:manage', 'integrations:manage', 'data:export', 'payroll:read', 'platform:manage', 'journal:approve']) {
      const r = await api.post('/api/v1/api-keys').set(auth(adm)).send({ name: 'bad', permissions: [p] });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('forbidden_permission');
    }
    expect((await api.post('/api/v1/api-keys').set(auth(adm)).send({ name: 'bad', permissions: ['nope:nope'] })).status).toBe(422);
    const k = await mkKey(['accounts:read']);
    await owner.query("UPDATE api_keys SET permissions = ARRAY['accounts:read', 'users:manage', 'integrations:manage'] WHERE id = $1", [k.id]);
    expect((await api.get('/api/v1/users').set(auth(k.key))).status).toBe(403);
    expect((await api.get('/api/v1/api-keys').set(auth(k.key))).status).toBe(403);
    expect((await api.get('/api/v1/accounts').set(auth(k.key))).status).toBe(200);
  });

  it('cannot give a key more than the creator holds, and only an administrator can create keys', async () => {
    expect((await api.post('/api/v1/api-keys').set(auth(fin)).send({ name: 'x', permissions: ['accounts:read'] })).status).toBe(403);
    expect((await api.get('/api/v1/api-keys').set(auth(vic))).status).toBe(403);
    expect((await api.get('/api/v1/api-keys')).status).toBe(401);
    // a custom role without inventory access: its holder's key cannot be granted it
    await owner.query("UPDATE api_keys SET revoked_at = now()");
    const k = await mkKey(['inventory:read']);
    await owner.query("DELETE FROM role_permissions WHERE permission = 'inventory:read' AND tenant_id = $1", [t.tenantId]);
    expect((await api.get('/api/v1/items').set(auth(k.key))).status).toBe(403); // the creator no longer holds it
  });

  it('stops at once when revoked, expired, its creator is deactivated, or the workspace is suspended', async () => {
    const use = (k: { key: string }) => api.get('/api/v1/accounts').set(auth(k.key));
    const a = await mkKey(['accounts:read']);
    await use(a).expect(200);
    await api.delete(`/api/v1/api-keys/${a.id}`).set(auth(adm)).expect(200);
    expect((await use(a)).status).toBe(401);
    expect((await api.delete(`/api/v1/api-keys/${a.id}`).set(auth(adm))).status).toBe(404);
    const b = await mkKey(['accounts:read'], { expires_in_days: 1 });
    await use(b).expect(200);
    await owner.query("UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1", [b.id]);
    expect((await use(b)).status).toBe(401);
    const c = await mkKey(['accounts:read']);
    await owner.query('UPDATE users SET is_active = false WHERE id = $1', [t.users.adm!.id]);
    expect((await use(c)).status).toBe(401);
    await owner.query('UPDATE users SET is_active = true WHERE id = $1', [t.users.adm!.id]);
    await use(c).expect(200);
    await owner.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [t.tenantId]);
    expect((await use(c)).status).toBe(401);
  });

  it('has its own request budget per minute', async () => {
    const k = await mkKey(['accounts:read'], { rate_limit_per_min: 10 });
    for (let i = 0; i < 10; i += 1) await api.get('/api/v1/accounts').set(auth(k.key)).expect(200);
    const r = await api.get('/api/v1/accounts').set(auth(k.key));
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
    const other = await mkKey(['accounts:read']);
    await api.get('/api/v1/accounts').set(auth(other.key)).expect(200); // another key is unaffected
  });

  it('records who made it, what it did is attributed to its creator, and another workspace never sees it', async () => {
    const k = await mkKey(['accounts:read', 'accounts:write']);
    await api.post('/api/v1/accounts').set(auth(k.key)).send({ code: '7777', name: 'From the API', type: 'expense' }).expect(201);
    const a = await owner.query("SELECT actor_user_id FROM audit_log WHERE tenant_id = $1 AND action = 'account.created'", [t.tenantId]);
    expect(a.rows[0].actor_user_id).toBe(t.users.adm!.id);
    expect((await owner.query("SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'api_key.created'", [t.tenantId])).rowCount).toBe(1);
    const t2 = await seedTenant('int-other', { zed: ['TenantAdmin'] });
    expect((await api.get('/api/v1/api-keys').set(auth(await tokenFor(api, t2, 'zed')))).body).toEqual([]);
    expect((await api.delete(`/api/v1/api-keys/${k.id}`).set(auth(await tokenFor(api, t2, 'zed')))).status).toBe(404);
  });
});

describe('webhooks', () => {
  const addHook = async (events = ['invoice.posted']) => (await api.post('/api/v1/webhooks').set(auth(adm)).send({ url: hookUrl, events }).expect(201)).body as { id: string; secret: string };
  async function postInvoice() {
    const cust = (await api.post('/api/v1/customers').set(auth(adm)).send({ code: 'c1', name: 'Private Name Cafe' }).expect(201)).body.id;
    const d = (await api.post('/api/v1/invoices').set(auth(adm)).send({ party_id: cust, doc_date: '2026-11-01', lines: [{ description: 'x', account_id: acc['4000'], quantity: '1', unit_price: '100.00' }] }).expect(201)).body;
    return (await api.post(`/api/v1/invoices/${d.id}/post`).set(auth(adm)).expect(200)).body;
  }
  const deliveries = async () => (await owner.query('SELECT status, attempts, last_status_code FROM webhook_deliveries ORDER BY created_at')).rows;

  it('delivers a signed event with identifiers only, and records the outcome', async () => {
    const h = await addHook();
    expect(h.secret.startsWith('whsec_')).toBe(true);
    expect(JSON.stringify((await owner.query('SELECT secret_enc FROM webhook_endpoints')).rows)).not.toContain(h.secret);
    expect(JSON.stringify((await api.get('/api/v1/webhooks').set(auth(adm))).body)).not.toContain(h.secret);
    const inv = await postInvoice();
    expect((await deliveries())).toEqual([{ status: 'pending', attempts: 0, last_status_code: null }]);
    expect(await processDue()).toBe(1);
    expect(hold.requests).toHaveLength(1);
    const r = hold.requests[0]!;
    const ts = r.headers['x-erpatio-timestamp'] as string;
    expect(r.headers['x-erpatio-signature']).toBe(`v1=${createHmac('sha256', h.secret).update(`${ts}.${r.body}`).digest('hex')}`);
    expect(r.headers['x-erpatio-event']).toBe('invoice.posted');
    const body = JSON.parse(r.body);
    expect(body.data).toMatchObject({ entity_type: 'document', entity_id: inv.id });
    expect(r.body).not.toContain('Private Name');
    expect(await deliveries()).toEqual([{ status: 'delivered', attempts: 1, last_status_code: 204 }]);
    expect(await processDue()).toBe(0);
  });

  it('only sends what the endpoint subscribed to, and nothing for a change that rolled back', async () => {
    await addHook(['receipt.recorded']);
    await postInvoice();
    expect(await deliveries()).toEqual([]);
    await addHook(['invoice.posted']);
    await expect(withTenant(t.tenantId, async (c) => {
      await recordAudit(c, { tenantId: t.tenantId, action: 'invoice.posted', entityType: 'document', entityId: 'x' });
      throw new Error('the change failed after the event was written');
    })).rejects.toThrow();
    expect(await deliveries()).toEqual([]);
  });

  it('retries with backoff after a failure, then gives up, and a dead endpoint is switched off', async () => {
    const h = await addHook();
    hold.status = 500;
    await postInvoice();
    await processDue();
    let d = (await owner.query('SELECT status, attempts, last_error, next_attempt_at > now() AS later FROM webhook_deliveries')).rows[0];
    expect(d).toMatchObject({ status: 'pending', attempts: 1, last_error: 'HTTP 500', later: true });
    expect(await processDue()).toBe(0); // not due yet
    for (let i = 0; i < 5; i += 1) { await owner.query('UPDATE webhook_deliveries SET next_attempt_at = now()'); await processDue(); }
    d = (await owner.query('SELECT status, attempts FROM webhook_deliveries')).rows[0];
    expect(d).toMatchObject({ status: 'failed', attempts: 6 });
    hold.status = 204;
    // ten failures in a row switch the endpoint off until someone turns it back on
    for (let i = 0; i < 5; i += 1) {
      await api.post(`/api/v1/webhooks/${h.id}/test`).set(auth(adm)).expect(201);
      hold.status = 500;
      await processDue();
    }
    const ep = (await owner.query('SELECT is_active, consecutive_failures FROM webhook_endpoints')).rows[0];
    expect(ep.is_active).toBe(false);
    await api.patch(`/api/v1/webhooks/${h.id}`).set(auth(adm)).send({ is_active: true }).expect(200);
    expect((await owner.query('SELECT consecutive_failures FROM webhook_endpoints')).rows[0].consecutive_failures).toBe(0);
  });

  it('a test event is queued and delivered; deliveries are listed', async () => {
    const h = await addHook(['invoice.posted']);
    await api.post(`/api/v1/webhooks/${h.id}/test`).set(auth(adm)).expect(201);
    await processDue();
    expect(hold.requests[0]!.headers['x-erpatio-event']).toBe('ping');
    const list = (await api.get(`/api/v1/webhooks/${h.id}/deliveries`).set(auth(adm)).expect(200)).body;
    expect(list[0]).toMatchObject({ event: 'ping', status: 'delivered' });
  });

  it('refuses addresses that point inside the network, plain http, embedded passwords and unknown events', async () => {
    process.env.WEBHOOK_ALLOW_INSECURE = 'false';
    process.env.WEBHOOK_ALLOW_PRIVATE = 'false';
    resetEnvCache();
    expect(getEnv().WEBHOOK_ALLOW_PRIVATE).toBe(false);
    const bad = (url: string, events: string[] = ['invoice.posted']) => api.post('/api/v1/webhooks').set(auth(adm)).send({ url, events });
    for (const u of ['http://example.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://user:pw@example.com/x', 'ftp://example.com/x', 'not a url', 'https://app.internal/x'])
      expect((await bad(u)).status, u).toBe(422);
    expect((await bad('https://example.com/hook', ['nope.event'])).status).toBe(422);
    expect((await bad('https://example.com/hook')).status).toBe(201);
  });

  it('knows which addresses are private', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('needs the integrations permission, caps the number of endpoints, and hides other workspaces', async () => {
    expect((await api.post('/api/v1/webhooks').set(auth(fin)).send({ url: hookUrl, events: ['ping'] })).status).toBe(403);
    expect((await api.get('/api/v1/webhooks')).status).toBe(401);
    const h = await addHook();
    for (let i = 0; i < 9; i += 1) await addHook();
    expect((await api.post('/api/v1/webhooks').set(auth(adm)).send({ url: hookUrl, events: ['ping'] })).status).toBe(409);
    const t2 = await seedTenant('int-hooks-other', { zed: ['TenantAdmin'] });
    const zed = await tokenFor(api, t2, 'zed');
    expect((await api.get('/api/v1/webhooks').set(auth(zed))).body).toEqual([]);
    expect((await api.delete(`/api/v1/webhooks/${h.id}`).set(auth(zed))).status).toBe(404);
    await api.delete(`/api/v1/webhooks/${h.id}`).set(auth(adm)).expect(200);
    const k = await mkKey(['accounts:read']);
    expect((await api.get('/api/v1/webhooks').set(auth(k.key))).status).toBe(403);
  });
});

describe('plans, limits and usage', () => {
  const je = (tok = adm) => api.post('/api/v1/journal-entries').set(auth(tok)).send({ entry_date: '2026-11-01', description: 'x', lines: [{ account_id: acc['1010'], debit: '1', credit: '0' }, { account_id: acc['3000'], debit: '0', credit: '1' }] });
  const usage = async (tok = adm) => (await api.get('/api/v1/billing/usage').set(auth(tok)).expect(200)).body;

  it('counts every posting and shows plan, limits and history', async () => {
    let u = await usage();
    expect(u.plan.code).toBe('standard');
    expect(u.limits).toEqual({ users: 25, entries_per_month: 20000 });
    expect(u.usage).toMatchObject({ users: 3, entries_this_month: 0 });
    await je().expect(201);
    await je().expect(201);
    u = await usage(fin);
    expect(u.usage.entries_this_month).toBe(2);
    expect(u.history.at(-1).entries).toBe(2);
    expect((await api.get('/api/v1/billing/usage').set(auth(vic))).status).toBe(403);
  });

  it('refuses the posting that goes over the cap and leaves nothing behind', async () => {
    await owner.query("INSERT INTO plans (code, name, max_users, max_entries_per_month) VALUES ('tiny', 'Tiny', 3, 2)");
    await owner.query("UPDATE tenants SET plan_code = 'tiny' WHERE id = $1", [t.tenantId]);
    await je().expect(201);
    await je().expect(201);
    const r = await je();
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('plan_limit');
    expect((await owner.query('SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1', [t.tenantId])).rows[0].n).toBe(2);
    expect((await usage()).usage.entries_this_month).toBe(2);
    // invoices and payroll post through the same door, so they stop too
    const cust = (await api.post('/api/v1/customers').set(auth(adm)).send({ code: 'c1', name: 'Cafe' }).expect(201)).body.id;
    const d = (await api.post('/api/v1/invoices').set(auth(adm)).send({ party_id: cust, doc_date: '2026-11-01', lines: [{ description: 'x', account_id: acc['4000'], quantity: '1', unit_price: '10' }] }).expect(201)).body;
    expect((await api.post(`/api/v1/invoices/${d.id}/post`).set(auth(adm))).status).toBe(402);
    expect((await api.get(`/api/v1/invoices/${d.id}`).set(auth(adm))).body.status).toBe('draft');
  });

  it('refuses to add a person beyond the plan\'s users', async () => {
    await owner.query("INSERT INTO plans (code, name, max_users) VALUES ('small', 'Small', 3)");
    await owner.query("UPDATE tenants SET plan_code = 'small' WHERE id = $1", [t.tenantId]);
    const roles = (await api.get('/api/v1/roles').set(auth(adm)).expect(200)).body as { id: string; name: string }[];
    const r = await api.post('/api/v1/users').set(auth(adm)).send({ email: 'new@int-co.test', full_name: 'New Person', role_ids: [roles.find((x) => x.name === 'Viewer')!.id] });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('plan_limit');
  });

  it('only the platform operator changes a plan, and not into one the workspace already exceeds', async () => {
    const platform = await seedPlatform();
    const opal = await tokenFor(api, platform, 'opal');
    await owner.query("INSERT INTO plans (code, name, max_users) VALUES ('two', 'Two', 2)");
    const put = (tok: string, plan: string) => api.put(`/api/v1/platform/tenants/${t.tenantId}/plan`).set(auth(tok)).send({ plan_code: plan });
    expect((await put(adm, 'enterprise')).status).toBe(403);
    expect((await put(opal, 'nope')).status).toBe(422);
    expect((await put(opal, 'two')).status).toBe(409); // three active users already
    expect((await put(opal, 'enterprise')).status).toBe(200);
    expect((await usage()).plan.code).toBe('enterprise');
    expect((await usage()).limits).toEqual({ users: null, entries_per_month: null });
    expect((await owner.query("SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'platform.plan_changed'", [t.tenantId])).rowCount).toBe(1);
  });
});
