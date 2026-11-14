import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountIds, auth, entry, newApi, owner, resetData, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

let api: Api;
let t: Seeded;
let acc: Record<string, string>;
let amy: string; // Accountant: creates and submits
let bob: string; // another Accountant: no approval right
let fay: string; // FinanceManager: approves
let gus: string; // a second FinanceManager

beforeAll(() => { api = newApi(); });
beforeEach(async () => {
  await resetData();
  t = await seedTenant('drafts-co', { amy: ['Accountant'], bob: ['Accountant'], fay: ['FinanceManager'], gus: ['FinanceManager'] });
  amy = await tokenFor(api, t, 'amy');
  bob = await tokenFor(api, t, 'bob');
  fay = await tokenFor(api, t, 'fay');
  gus = await tokenFor(api, t, 'gus');
  acc = await accountIds(t.tenantId);
});
afterAll(shutdown);

const body = (amount = '100.00', date = '2026-11-02') => ({ ...entry(acc, amount, date), description: 'Draft entry' });
const mk = (tok = amy, b: object = body()) => api.post('/api/v1/journal-drafts').set(auth(tok)).send(b);
const act = (id: string, verb: string, tok = amy, payload: object = {}) => api.post(`/api/v1/journal-drafts/${id}/${verb}`).set(auth(tok)).send(payload);
const requireApproval = (on: boolean) => api.patch('/api/v1/settings').set(auth(fay)).send({ require_approval: on }).expect(200);

describe('drafts (FR-FIN-02)', () => {
  it('saves work in progress: empty, one-sided or unbalanced drafts are allowed', async () => {
    const empty = await mk(amy, { entry_date: '2026-11-02' });
    expect(empty.status).toBe(201);
    expect(empty.body.lines).toEqual([]);
    const lopsided = await mk(amy, { ...body(), lines: [{ account_id: acc['1010'], debit: '50.00', credit: '0' }] });
    expect(lopsided.status).toBe(201);
    expect(lopsided.body.total_debit).toBe('50.0000');
    expect(lopsided.body.total_credit).toBe('0.0000');
    const list = await api.get('/api/v1/journal-drafts').set(auth(amy));
    expect(list.body).toHaveLength(2);
  });

  it('only the creator edits or deletes a draft', async () => {
    const d = await mk();
    const edited = await api.patch(`/api/v1/journal-drafts/${d.body.id}`).set(auth(amy)).send({ ...body('250.00'), description: 'Changed' });
    expect(edited.status).toBe(200);
    expect(edited.body.description).toBe('Changed');
    expect(edited.body.total_debit).toBe('250.0000');
    expect((await api.patch(`/api/v1/journal-drafts/${d.body.id}`).set(auth(bob)).send(body())).status).toBe(403);
    expect((await api.delete(`/api/v1/journal-drafts/${d.body.id}`).set(auth(bob))).status).toBe(403);
    expect((await api.delete(`/api/v1/journal-drafts/${d.body.id}`).set(auth(amy))).status).toBe(204);
    expect((await api.get(`/api/v1/journal-drafts/${d.body.id}`).set(auth(amy))).status).toBe(404);
  });

  it('rejects an account that belongs to another tenant', async () => {
    const other = await seedTenant('elsewhere', { zed: ['Accountant'] });
    const foreign = await accountIds(other.tenantId);
    const r = await mk(amy, { ...body(), lines: [{ account_id: foreign['1010'], debit: '1', credit: '0' }] });
    expect(r.status).toBe(422);
  });
});

describe('posting a draft without approval', () => {
  it('writes a normal ledger entry, removes the draft, and records who posted', async () => {
    const d = await mk();
    const r = await act(d.body.id, 'post');
    expect(r.status).toBe(201);
    expect(r.body.entry_no).toBe(1);
    expect(r.body.lines).toHaveLength(2);
    expect((await api.get(`/api/v1/journal-drafts/${d.body.id}`).set(auth(amy))).status).toBe(404);
    const row = (await owner.query('SELECT created_by, posted_by, approved_by FROM journal_entries')).rows[0];
    expect(row).toEqual({ created_by: t.users.amy!.id, posted_by: t.users.amy!.id, approved_by: null });
  });

  it('refuses an unbalanced or empty draft and keeps it', async () => {
    const bad = await mk(amy, { ...body(), lines: [{ account_id: acc['1010'], debit: '50.00', credit: '0' }, { account_id: acc['4000'], debit: '0', credit: '40.00' }] });
    expect((await act(bad.body.id, 'post')).body.error.code).toBe('unbalanced_entry');
    const none = await mk(amy, { ...body(), description: '' });
    expect((await act(none.body.id, 'post')).status).toBe(422);
    expect((await owner.query('SELECT count(*)::int AS n FROM journal_drafts')).rows[0].n).toBe(2);
    expect((await owner.query('SELECT count(*)::int AS n FROM journal_entries')).rows[0].n).toBe(0);
  });

  it('a draft dated in a closed period cannot be posted, and stays a draft', async () => {
    const d = await mk(amy, body('10.00', '2026-03-09'));
    await owner.query("UPDATE fiscal_periods SET status = 'closed' WHERE year = 2026 AND month = 3");
    const r = await act(d.body.id, 'post');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('period_closed');
    expect((await api.get(`/api/v1/journal-drafts/${d.body.id}`).set(auth(amy))).status).toBe(200);
  });

  it('someone else cannot post your draft unless they can approve', async () => {
    const d = await mk();
    expect((await act(d.body.id, 'post', bob)).status).toBe(403);
    expect((await act(d.body.id, 'post', fay)).status).toBe(201);
  });

  it('submitting is meaningless when approval is off', async () => {
    const d = await mk();
    expect((await act(d.body.id, 'submit')).body.error.code).toBe('approval_not_required');
  });
});

describe('approval workflow (FR-FIN-05)', () => {
  beforeEach(async () => { await requireApproval(true); });

  it('direct posting is blocked: entries must go through a draft', async () => {
    const r = await api.post('/api/v1/journal-entries').set(auth(amy)).send(body());
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('approval_required');
  });

  it('only a manager can change the policy', async () => {
    expect((await api.patch('/api/v1/settings').set(auth(amy)).send({ require_approval: false })).status).toBe(403);
    expect((await api.get('/api/v1/settings').set(auth(amy))).body).toEqual({ require_approval: true });
  });

  it('draft -> submitted -> approved and posted, with creator and approver recorded', async () => {
    const d = await mk(amy);
    expect((await act(d.body.id, 'post', amy)).body.error.code).toBe('not_submitted');
    const sub = await act(d.body.id, 'submit', amy);
    expect(sub.body.status).toBe('submitted');
    expect((await api.patch(`/api/v1/journal-drafts/${d.body.id}`).set(auth(amy)).send(body())).body.error.code).toBe('not_editable');
    expect((await api.delete(`/api/v1/journal-drafts/${d.body.id}`).set(auth(amy))).status).toBe(409);
    expect((await act(d.body.id, 'post', bob)).status).toBe(403); // no approval right
    const done = await act(d.body.id, 'post', fay);
    expect(done.status).toBe(201);
    const row = (await owner.query('SELECT created_by, posted_by, approved_by FROM journal_entries')).rows[0];
    expect(row).toEqual({ created_by: t.users.amy!.id, posted_by: t.users.fay!.id, approved_by: t.users.fay!.id });
  });

  it('nobody approves their own entry, even a manager', async () => {
    const d = await mk(fay);
    await act(d.body.id, 'submit', fay);
    const self = await act(d.body.id, 'post', fay);
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('self_approval');
    expect((await act(d.body.id, 'post', gus)).status).toBe(201);
  });

  it('sending back returns the draft to its author with the reason', async () => {
    const d = await mk(amy);
    await act(d.body.id, 'submit', amy);
    expect((await act(d.body.id, 'reject', amy, { note: 'Wrong account' })).status).toBe(403);
    expect((await act(d.body.id, 'reject', fay, {})).status).toBe(422);
    const back = await act(d.body.id, 'reject', fay, { note: 'Wrong account' });
    expect(back.body).toMatchObject({ status: 'draft', rejection_note: 'Wrong account' });
    expect((await api.patch(`/api/v1/journal-drafts/${d.body.id}`).set(auth(amy)).send(body('120.00'))).status).toBe(200);
    expect((await act(d.body.id, 'submit', amy)).body.rejection_note).toBeNull();
  });

  it('an unbalanced draft cannot be submitted', async () => {
    const d = await mk(amy, { ...body(), lines: [{ account_id: acc['1010'], debit: '5', credit: '0' }] });
    expect((await act(d.body.id, 'submit', amy)).status).toBe(422);
  });

  it('reversals are not held for approval', async () => {
    await requireApproval(false);
    const posted = await api.post('/api/v1/journal-entries').set(auth(amy)).send(body());
    await requireApproval(true);
    expect((await api.post(`/api/v1/journal-entries/${posted.body.id}/reverse`).set(auth(amy)).send({})).status).toBe(201);
  });

  it('every step is in the audit log', async () => {
    const d = await mk(amy);
    await act(d.body.id, 'submit', amy);
    await act(d.body.id, 'post', fay);
    const actions = (await owner.query("SELECT action FROM audit_log WHERE action LIKE 'draft.%' OR action LIKE 'settings.%' OR action = 'journal.posted' ORDER BY id")).rows.map((r) => r.action);
    expect(actions).toEqual(['settings.updated', 'draft.created', 'draft.submitted', 'journal.posted', 'draft.posted']);
  });
});

describe('the demo workspace', () => {
  it('caps the number of drafts a visitor can leave behind', async () => {
    const demo = await seedTenant('demo-drafts', { dee: ['DemoUser'] }, true);
    const tok = await tokenFor(api, demo, 'dee');
    const a = await accountIds(demo.tenantId);
    const mkDemo = () => api.post('/api/v1/journal-drafts').set(auth(tok)).send({ ...entry(a), description: 'x' });
    for (let i = 0; i < 30; i++) expect((await mkDemo()).status).toBe(201);
    const over = await mkDemo();
    expect(over.status).toBe(403);
    expect(over.body.error.code).toBe('demo_limit');
  });
});
