import { Router } from 'express';
import { z } from 'zod';
import { P, requirePermission } from '../../lib/permissions.js';
import { route } from '../../lib/route.js';
import * as svc from './service.js';
import { ENTITIES, MAX_ROWS } from './service.js';

const EntityParam = z.object({ entity: z.enum(ENTITIES) });
// Cells arrive as text from the file; anything else is refused before it gets near a query.
const Rows = z.object({
  rows: z.array(z.record(z.string().max(500), z.string().max(500).or(z.number().transform(String)).or(z.null().transform(() => '')))).min(1).max(MAX_ROWS),
});
const Commit = Rows.extend({ on_duplicate: z.enum(['skip', 'fail']).default('skip') });

export function dataRouter(prefix: string): Router {
  const r = Router();
  route(r, prefix, { method: 'post', path: '/imports/:entity/preview', tag: 'data', summary: 'Check rows without saving anything', guard: requirePermission(P.DATA_IMPORT), params: EntityParam, body: Rows,
    handler: ({ principal, params, body }) => svc.previewImport(principal, params.entity, body.rows) });
  route(r, prefix, { method: 'post', path: '/imports/:entity/commit', tag: 'data', summary: 'Import rows, all or nothing', status: 201, guard: requirePermission(P.DATA_IMPORT), params: EntityParam, body: Commit,
    handler: ({ principal, params, body, req }) => svc.commitImport(principal, params.entity, body.rows, body.on_duplicate, req.ip) });
  route(r, prefix, { method: 'get', path: '/export', tag: 'data', summary: 'Download the whole workspace as JSON (limited to one every five minutes)', guard: requirePermission(P.DATA_EXPORT),
    handler: async ({ principal, res, req }) => { await svc.exportWorkspace(principal, res, req.ip); } });
  return r;
}
