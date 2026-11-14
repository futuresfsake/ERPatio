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
import { adminRouter } from './modules/admin/routes.js';
import { draftsRouter } from './modules/drafts/routes.js';
import { ledgerRouter } from './modules/ledger/routes.js';
import { subledgerRouter } from './modules/subledger/routes.js';
import { stockRouter } from './modules/stock/routes.js';
import { bankRouter } from './modules/bank/routes.js';
import { productionRouter } from './modules/production/routes.js';
import { hcmRouter } from './modules/hcm/routes.js';
import { biRouter } from './modules/bi/routes.js';
import { dataRouter } from './modules/data/routes.js';
import { integrationsRouter } from './modules/apikeys/routes.js';
import { periodsRouter } from './modules/periods/routes.js';
import { platformRouter } from './modules/platform/routes.js';
import { privacyRouter } from './modules/privacy/routes.js';
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
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With', 'X-Request-ID'],
      maxAge: 600,
    }),
  );
  // Imports carry up to a few thousand rows, so they get a larger body limit; every other route keeps the small one.
  app.use(`${API}/imports`, express.json({ limit: '4mb' }));
  app.use((req, res, next) => (req.path.startsWith(`${API}/imports/`) ? next() : express.json({ limit: '100kb' })(req, res, next)));
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
  for (const p of ['login', 'login/mfa', 'refresh', 'signup', 'verify-email', 'resend-verification', 'forgot-password', 'reset-password'])
    app.use(`${API}/auth/${p}`, limiter);

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
  app.use(API, subledgerRouter(API));
  app.use(API, stockRouter(API));
  app.use(API, bankRouter(API));
  app.use(API, productionRouter(API));
  app.use(API, hcmRouter(API));
  app.use(API, biRouter(API));
  app.use(API, dataRouter(API));
  app.use(API, integrationsRouter(API));
  app.use(API, draftsRouter(API));
  app.use(API, periodsRouter(API));
  app.use(API, reportsRouter(API));
  app.use(API, privacyRouter(API));
  app.use(API, adminRouter(API));
  app.use(API, platformRouter(API));

  const pub = express.Router();
  route(pub, API, {
    method: 'get', path: '/public-config', tag: 'ops', summary: 'What the sign-in page may offer',
    guard: publicRoute('feature flags the sign-in page needs before anyone is signed in'),
    handler: async () => ({ signup_enabled: getEnv().SIGNUP_ENABLED }),
  });
  app.use(API, pub);

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
