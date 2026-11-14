/**
 * Creates the operator's own workspace and its first platform administrator (US-022).
 *   PLATFORM_ADMIN_EMAIL=you@example.com PLATFORM_ADMIN_PASSWORD='a long passphrase' npm run platform:admin
 * Two-factor sign-in is mandatory for this role: the first sign-in goes straight to 2FA setup.
 */
import 'dotenv/config';
import { getEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { P } from '../src/lib/permissions.js';
import { createUser, provisionTenant } from '../src/modules/tenants/provision.js';
import { PLATFORM_SLUG } from '../src/modules/platform/service.js';

const email = process.env.PLATFORM_ADMIN_EMAIL;
const password = process.env.PLATFORM_ADMIN_PASSWORD;
if (!email || !password || password.length < 12) throw new Error('Set PLATFORM_ADMIN_EMAIL and a PLATFORM_ADMIN_PASSWORD of at least 12 characters.');

const env = getEnv();
const pool = createPool(env.DATABASE_URL_DIRECT ?? env.DATABASE_URL, 1);
const c = await pool.connect();
try {
  await c.query('BEGIN');
  if ((await c.query('SELECT 1 FROM tenants WHERE slug = $1', [PLATFORM_SLUG])).rowCount) throw new Error('The platform workspace already exists.');
  const tid = await provisionTenant(c, { slug: PLATFORM_SLUG, name: 'ERPatio platform', modules: [], mfaRequiredRoles: ['PlatformAdmin'] });
  const rid = (await c.query<{ id: string }>("INSERT INTO roles (tenant_id, name, description, is_system) VALUES ($1, 'PlatformAdmin', 'Operates the platform', true) RETURNING id", [tid])).rows[0]!.id;
  await c.query('INSERT INTO role_permissions (role_id, permission, tenant_id) VALUES ($1, $2, $3)', [rid, P.PLATFORM_MANAGE, tid]);
  await createUser(c, { tenantId: tid, email, fullName: 'Platform administrator', password, roles: ['PlatformAdmin'] });
  await c.query('COMMIT');
  console.log(`platform workspace '${PLATFORM_SLUG}' ready; sign in as ${email}`);
} catch (e) {
  await c.query('ROLLBACK');
  throw e;
} finally {
  c.release();
  await pool.end();
}
