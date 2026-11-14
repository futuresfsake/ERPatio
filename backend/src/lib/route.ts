/**
 * The only supported way to declare an API route. A guard is a required argument, so a route cannot
 * be added without choosing public / authenticated / a specific permission (FR-AUT-07). Metadata is
 * also used to generate the OpenAPI document (DoD: OpenAPI docs updated).
 */
import type { Request, RequestHandler, Response, Router } from 'express';
import { z, type ZodType } from 'zod';
import { ApiError } from './errors.js';
import { GUARD, type GuardInfo } from './permissions.js';
import type { Principal } from './security.js';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type GuardHandler = RequestHandler & { [GUARD]: GuardInfo };

export interface Ctx<B, Q, P> {
  req: Request;
  res: Response;
  principal: Principal;
  body: B;
  query: Q;
  params: P;
}

export interface RouteSpec<B, Q, P> {
  method: Method;
  path: string;
  guard: GuardHandler;
  summary: string;
  tag: string;
  body?: ZodType<B>;
  query?: ZodType<Q>;
  params?: ZodType<P>;
  status?: number;
  handler: (ctx: Ctx<B, Q, P>) => Promise<unknown>;
}

export interface DocEntry {
  method: Method;
  path: string;
  summary: string;
  tag: string;
  guard: GuardInfo;
  body?: ZodType;
  query?: ZodType;
  status: number;
}
export const apiDocs: DocEntry[] = [];

function parse<T>(schema: ZodType<T> | undefined, value: unknown): T {
  if (!schema) return undefined as T;
  const r = schema.safeParse(value);
  if (!r.success) {
    // Field paths and reasons only; never echo submitted values (they may be PII).
    const details = r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message }));
    throw new ApiError(422, 'validation_error', 'The request is invalid.', {}, details);
  }
  return r.data;
}

export function route<B = undefined, Q = undefined, P = undefined>(
  router: Router,
  prefix: string,
  spec: RouteSpec<B, Q, P>,
): void {
  const status = spec.status ?? 200;
  const run: RequestHandler = async (req, res) => {
    const result = await spec.handler({
      req,
      res,
      principal: req.principal as Principal,
      body: parse(spec.body, req.body),
      query: parse(spec.query, req.query),
      params: parse(spec.params, req.params),
    });
    if (res.headersSent) return;
    if (result === undefined) res.status(204).end();
    else res.status(status).json(result);
  };
  router[spec.method](spec.path, spec.guard, run);
  const doc: DocEntry = {
    method: spec.method,
    path: prefix + spec.path.replace(/:([A-Za-z]+)/g, '{$1}'),
    summary: spec.summary,
    tag: spec.tag,
    guard: spec.guard[GUARD],
    body: spec.body,
    query: spec.query,
    status,
  };
  // createApp() may run more than once (tests); keep one entry per operation.
  const i = apiDocs.findIndex((d) => d.method === doc.method && d.path === doc.path);
  if (i >= 0) apiDocs[i] = doc;
  else apiDocs.push(doc);
}

export function buildOpenApi(): object {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const d of apiDocs) {
    const op: Record<string, unknown> = {
      summary: d.summary,
      tags: [d.tag],
      responses: { [d.status]: { description: 'OK' }, '4XX': { description: 'Error ({error:{code,message,request_id}})' } },
      'x-guard': d.guard.kind === 'permission' ? d.guard.permission : d.guard.kind,
    };
    if (d.guard.kind !== 'public') op['security'] = [{ bearerAuth: [] }];
    if (d.body) op['requestBody'] = { content: { 'application/json': { schema: z.toJSONSchema(d.body, { io: 'input' }) } } };
    (paths[d.path] ??= {})[d.method] = op;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'ERPatio API', version: '0.1.0' },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    paths,
  };
}
