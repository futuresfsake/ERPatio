/**
 * Moving data in and out (FR-DAT). Import is all or nothing: every row is checked first, and one bad row writes nothing.
 * Export streams the workspace's business data as one JSON document; secrets (password hashes, tokens, key material) and
 * encrypted personal fields are never included. An employee's identifiers have their own audited export.
 */
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { withTenant } from '../../db/pool.js';
import { encryptField } from '../../lib/crypto.js';
import { ApiError } from '../../lib/errors.js';
import type { Principal } from '../../lib/security.js';
import { recordAudit } from '../audit/audit.js';

export const ENTITIES = ['customers', 'suppliers', 'items', 'accounts'] as const;
export type Entity = (typeof ENTITIES)[number];
export const MAX_ROWS = 5000;

const text = (max: number) => z.string().trim().max(max);
const opt = (max: number) => text(max).optional().transform((v) => (v ? v : undefined));
const party = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9.-]{1,20}$/, 'Code is letters, digits, dot or dash, up to 20'),
  name: text(200).min(1, 'Name is required'),
  email: opt(254).refine((v) => v === undefined || z.email().safeParse(v).success, 'Email is not valid'),
  phone: opt(40), tin: opt(40),
  terms_days: z.string().trim().optional().transform((v) => (v ? Number(v) : 30)).refine((n) => Number.isInteger(n) && n >= 0 && n <= 365, 'Terms are 0 to 365 days'),
});
const SCHEMA: Record<Entity, z.ZodType<Record<string, unknown>>> = {
  customers: party, suppliers: party,
  items: z.object({
    sku: z.string().trim().regex(/^[A-Za-z0-9._-]{1,40}$/, 'SKU is letters, digits, dot, dash or underscore, up to 40'),
    name: text(200).min(1, 'Name is required'),
    uom: text(20).optional().transform((v) => v || 'pc'),
    reorder_level: z.string().trim().optional().transform((v) => v || '0').refine((v) => /^\d{1,15}(\.\d{1,4})?$/.test(v), 'Reorder level is a number'),
  }),
  accounts: z.object({
    code: z.string().trim().regex(/^[A-Za-z0-9.-]{1,20}$/, 'Code is letters, digits, dot or dash, up to 20'),
    name: text(200).min(1, 'Name is required'),
    type: z.string().trim().toLowerCase().pipe(z.enum(['asset', 'liability', 'equity', 'revenue', 'expense'])),
  }),
};
const KEY: Record<Entity, string> = { customers: 'code', suppliers: 'code', items: 'sku', accounts: 'code' };

export interface RowError { row: number; message: string }

/** Row numbers are 1-based against the data rows the user sent. */
function check(entity: Entity, rows: Record<string, string>[]) {
  if (rows.length === 0) throw new ApiError(422, 'validation_error', 'There are no rows to import.');
  if (rows.length > MAX_ROWS) throw new ApiError(422, 'too_many_rows', `Import at most ${MAX_ROWS} rows at a time.`);
  const errors: RowError[] = [];
  const good: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  rows.forEach((raw, i) => {
    const r = SCHEMA[entity].safeParse(raw);
    if (!r.success) { for (const issue of r.error.issues) errors.push({ row: i + 1, message: `${issue.path.join('.') || 'row'}: ${issue.message}` }); return; }
    const key = String(r.data[KEY[entity]]).toUpperCase();
    if (seen.has(key)) { errors.push({ row: i + 1, message: `${KEY[entity]}: ${key} appears more than once in the file` }); return; }
    seen.add(key);
    good.push(r.data);
  });
  return { good, errors };
}

async function existing(c: PoolClient, tenantId: string, entity: Entity, keys: string[]): Promise<Set<string>> {
  const q = entity === 'items' ? 'SELECT upper(sku) AS k FROM items WHERE tenant_id = $1 AND upper(sku) = ANY($2::text[])'
    : entity === 'accounts' ? 'SELECT upper(code) AS k FROM accounts WHERE tenant_id = $1 AND upper(code) = ANY($2::text[])'
    : "SELECT upper(code) AS k FROM parties WHERE tenant_id = $1 AND kind = $3 AND upper(code) = ANY($2::text[])";
  const args = entity === 'customers' || entity === 'suppliers' ? [tenantId, keys, entity === 'customers' ? 'customer' : 'supplier'] : [tenantId, keys];
  return new Set((await c.query<{ k: string }>(q, args)).rows.map((r) => r.k));
}

export const previewImport = (p: Principal, entity: Entity, rows: Record<string, string>[]) =>
  withTenant(p.tenantId, async (c) => {
    const { good, errors } = check(entity, rows);
    const dup = await existing(c, p.tenantId, entity, good.map((g) => String(g[KEY[entity]]).toUpperCase()));
    return { entity, rows: rows.length, valid: good.length, already_exist: dup.size, errors };
  });

export const commitImport = (p: Principal, entity: Entity, rows: Record<string, string>[], onDuplicate: 'skip' | 'fail', ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const { good, errors } = check(entity, rows);
    if (errors.length) throw new ApiError(422, 'import_errors', 'Some rows have problems, so nothing was imported.', {}, errors.slice(0, 100).map((e) => ({ field: `row ${e.row}`, reason: e.message })));
    const dup = await existing(c, p.tenantId, entity, good.map((g) => String(g[KEY[entity]]).toUpperCase()));
    if (dup.size && onDuplicate === 'fail') throw new ApiError(409, 'already_exists', `${dup.size} of these already exist, so nothing was imported.`);
    let added = 0;
    for (const g of good) {
      const key = String(g[KEY[entity]]).toUpperCase();
      if (dup.has(key)) continue;
      if (entity === 'accounts') await c.query('INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, upper($2), $3, $4)', [p.tenantId, g.code, g.name, g.type]);
      else if (entity === 'items') {
        const id = (await c.query<{ id: string }>('INSERT INTO items (tenant_id, sku, name, uom) VALUES ($1, upper($2), $3, $4) RETURNING id', [p.tenantId, g.sku, g.name, g.uom])).rows[0]!.id;
        await c.query('INSERT INTO item_stock (tenant_id, item_id) VALUES ($1, $2)', [p.tenantId, id]);
        if (g.reorder_level !== '0') await c.query('UPDATE items SET reorder_level = $3 WHERE tenant_id = $1 AND id = $2', [p.tenantId, id, g.reorder_level]);
      } else {
        const tin = g.tin ? await encryptField(c, p.tenantId, String(g.tin)) : null;
        await c.query('INSERT INTO parties (tenant_id, kind, code, name, email, phone, tin_enc, terms_days) VALUES ($1, $2, upper($3), $4, $5, $6, $7, $8)',
          [p.tenantId, entity === 'customers' ? 'customer' : 'supplier', g.code, g.name, g.email ?? null, g.phone ?? null, tin, g.terms_days]);
      }
      added += 1;
    }
    await recordAudit(c, { tenantId: p.tenantId, action: 'data.imported', actorUserId: p.userId, ip, detail: { entity, received: rows.length, added, skipped: good.length - added } });
    return { entity, received: rows.length, added, skipped: good.length - added };
  });

// ------------------------------------------------------------------ export
/** Fixed list, never taken from input. Order is only for readability of the file. */
const EXPORT_TABLES = [
  'accounts', 'fiscal_periods', 'journal_entries', 'journal_lines', 'parties', 'tax_codes', 'documents', 'document_lines', 'payments', 'payment_allocations', 'payment_voids', 'credit_applications',
  'bank_statement_lines', 'bank_matches', 'items', 'item_stock', 'stock_movements', 'purchase_orders', 'purchase_order_lines', 'sales_orders', 'sales_order_lines', 'boms', 'bom_lines',
  'work_orders', 'work_order_components', 'employees', 'shifts', 'attendance', 'statutory_rules', 'tax_brackets', 'payroll_runs', 'payslips', 'payroll_adjustments', 'roles', 'role_permissions',
  'user_roles', 'users', 'tenant_modules', 'audit_log',
] as const;
const SECRET_KEY = /(_enc$|hash$|secret|recovery|token|password|mfa_)/i;

export async function exportWorkspace(p: Principal, res: Response, ip?: string): Promise<void> {
  await withTenant(p.tenantId, async (c) => {
    await c.query("SET LOCAL statement_timeout = '120s'");
    const recent = await c.query("SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'data.exported' AND occurred_at > now() - interval '5 minutes'", [p.tenantId]);
    if (recent.rowCount) throw new ApiError(429, 'export_too_soon', 'A full export was made a moment ago. Try again in a few minutes.');
    const t = (await c.query<{ slug: string; name: string }>('SELECT slug, name FROM tenants WHERE id = $1', [p.tenantId])).rows[0]!;
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="erpatio-${t.slug}-${new Date().toISOString().slice(0, 10)}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    res.write(`{"exported_at":${JSON.stringify(new Date().toISOString())},"workspace":${JSON.stringify({ slug: t.slug, name: t.name })},"note":"Secrets and encrypted personal fields are not included.","tables":{`);
    let first = true;
    for (const name of EXPORT_TABLES) {
      const cursor = `export_${name}`;
      // Table names come from the fixed list above, never from input.
      await c.query('DECLARE ' + cursor + ' NO SCROLL CURSOR FOR SELECT to_jsonb(t) AS j FROM ' + name + ' t WHERE t.tenant_id = $1', [p.tenantId]);
      res.write(`${first ? '' : ','}${JSON.stringify(name)}:[`);
      first = false;
      let firstRow = true;
      for (;;) {
        const { rows } = await c.query<{ j: Record<string, unknown> }>('FETCH 500 FROM ' + cursor);
        if (rows.length === 0) break;
        for (const r of rows) {
          for (const k of Object.keys(r.j)) if (SECRET_KEY.test(k)) delete r.j[k];
          res.write(`${firstRow ? '' : ','}${JSON.stringify(r.j)}`);
          firstRow = false;
        }
      }
      await c.query('CLOSE ' + cursor);
      res.write(']');
    }
    res.write('}}');
    await recordAudit(c, { tenantId: p.tenantId, action: 'data.exported', actorUserId: p.userId, ip });
  });
  res.end();
}
