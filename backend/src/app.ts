import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { getEnv } from './config/env.js';
import { getPool } from './db/pool.js';
import { ApiError } from './lib/errors.js';
import { assertAllRoutesGuarded, publicRoute } from './lib/permissions.js';
import { buildOpenApi, route } from './lib/route.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestContext } from './middleware/requestContext.js';
import { authRouter } from './modules/auth/routes.js';
import { draftsRouter } from './modules/drafts/routes.js';
import { ledgerRouter } from './modules/ledger/routes.js';
import { periodsRouter } from './modules/periods/routes.js';
import { reportsRouter } from './modules/reports/routes.js';

export const API = '/api/v1';

export function createApp(): Express {
  const env = getEnv();
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestContext);
  const prod = env.NODE_ENV === 'production';
  app.use(
    helmet({
      strictTransportSecurity: prod ? undefined : false,
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          // Fonts are self-hosted, so nothing third-party is ever allowed. Inline styles are needed for React style props.
          'font-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'upgrade-insecure-requests': prod ? [] : null,
        },
      },
    }),
  );
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With', 'X-Request-ID'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(API, (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Per-IP limiter on the unauthenticated endpoints (FR-SEC-04). Process-local: see ADR-007.
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: env.AUTH_RATE_PER_MINUTE,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new ApiError(429, 'rate_limited', 'Too many attempts. Try again shortly.', { 'Retry-After': '60' })),
  });
  app.use(`${API}/auth/login`, limiter);
  app.use(`${API}/auth/refresh`, limiter);

  // Operational probes.
  const ops = express.Router();
  route(ops, '', {
    method: 'get', path: '/health', tag: 'ops', summary: 'Liveness', guard: publicRoute('load-balancer probe'),
    handler: async () => ({ status: 'ok' }),
  });
  route(ops, '', {
    method: 'get', path: '/ready', tag: 'ops', summary: 'Readiness (database reachable)', guard: publicRoute('load-balancer probe'),
    handler: async () => {
      try {
        await getPool().query('SELECT 1');
      } catch {
        throw new ApiError(503, 'not_ready', 'Database unavailable.');
      }
      return { status: 'ready' };
    },
  });
  app.use(ops);

  app.use(`${API}/auth`, authRouter(`${API}/auth`));
  app.use(API, ledgerRouter(API));
  app.use(API, draftsRouter(API));
  app.use(API, periodsRouter(API));
  app.use(API, reportsRouter(API));

  if (env.DOCS_ENABLED) {
    const docs = express.Router();
    route(docs, API, {
      method: 'get', path: '/openapi.json', tag: 'ops', summary: 'OpenAPI document',
      guard: publicRoute('API documentation; enabled by DOCS_ENABLED'),
      handler: async () => buildOpenApi(),
    });
    app.use(API, docs);
  }
  app.use(API, notFoundHandler); // unknown /api/v1/* paths get a JSON 404, never the SPA

  if (env.STATIC_DIR) {
    const dir = path.resolve(env.STATIC_DIR);
    app.use(express.static(dir, { index: false, maxAge: '1h', setHeaders: (res, file) => {
      if (file.endsWith('index.html')) res.set('Cache-Control', 'no-cache');
    } }));
    // Not declared through route(): sendFile completes asynchronously and must own the response.
    const spa = express.Router();
    spa.get('/{*splat}', publicRoute('static front end'), (_req, res, next) => {
      res.set('Cache-Control', 'no-cache').sendFile(path.join(dir, 'index.html'), (err) => err && next(err));
    });
    app.use(spa);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  assertAllRoutesGuarded(app); // default deny: refuse to start with an undeclared route (US-124)
  return app;
}
