import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const DEV_SECRET = 'dev-only-secret-change-me-dev-only-secret';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(8000),
    LOG_LEVEL: z.string().default('info'),
    DATABASE_URL: z.string().min(1),
    DATABASE_URL_DIRECT: z.string().optional(),
    DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
    JWT_SECRET: z.string().default(DEV_SECRET),
    JWT_SECRET_PREVIOUS: z.string().optional(),
    JWT_ISSUER: z.string().default('erpatio'),
    JWT_AUDIENCE: z.string().default('erpatio-api'),
    ACCESS_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
    REFRESH_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    COOKIE_SECURE: bool.default(false),
    DOCS_ENABLED: bool.default(true),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    LOCKOUT_THRESHOLD: z.coerce.number().int().default(5),
    LOCKOUT_MINUTES: z.coerce.number().int().default(15),
    AUTH_RATE_PER_MINUTE: z.coerce.number().int().default(10),
    DEMO_MAX_ENTRIES: z.coerce.number().int().default(100),
    TRUST_PROXY: z.coerce.number().int().default(0),
    STATIC_DIR: z.string().optional(),
    MASTER_KEY: z.string().optional(),
    MASTER_KEY_PREVIOUS: z.string().optional(),
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().default('ERPatio <no-reply@localhost>'),
    APP_URL: z.string().default('http://localhost:5173'),
    SIGNUP_ENABLED: bool.default(false),
    // Webhooks go to https and public addresses only. These two relax that for local development and tests, never in production.
    WEBHOOK_ALLOW_INSECURE: bool.default(false),
    WEBHOOK_ALLOW_PRIVATE: bool.default(false),
    HIBP_ENABLED: bool.default(true),
  })
  .superRefine((v, ctx) => {
    if (v.NODE_ENV === 'production' && (v.WEBHOOK_ALLOW_INSECURE || v.WEBHOOK_ALLOW_PRIVATE))
      ctx.addIssue({ code: 'custom', message: 'WEBHOOK_ALLOW_INSECURE and WEBHOOK_ALLOW_PRIVATE must be off in production' });
    if (v.NODE_ENV !== 'production') return;
    if (v.JWT_SECRET.length < 32 || v.JWT_SECRET === DEV_SECRET)
      ctx.addIssue({ code: 'custom', message: 'JWT_SECRET must be unique, random, 32+ characters' });
    if (!v.COOKIE_SECURE) ctx.addIssue({ code: 'custom', message: 'COOKIE_SECURE must be true in production' });
    if (v.CORS_ORIGINS.includes('*')) ctx.addIssue({ code: 'custom', message: 'Wildcard CORS is not allowed' });
    if (!v.MASTER_KEY || Buffer.from(v.MASTER_KEY, 'base64').length !== 32)
      ctx.addIssue({ code: 'custom', message: 'MASTER_KEY must be 32 random bytes, base64 encoded' });
    if (v.SIGNUP_ENABLED && !v.SMTP_URL)
      ctx.addIssue({ code: 'custom', message: 'SIGNUP_ENABLED needs SMTP_URL, or verification e-mails go nowhere' });
  });

export type Env = z.infer<typeof schema> & { corsOrigins: string[] };

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`).join('; ');
      throw new Error(`Invalid environment: ${msg}`);
    }
    cached = {
      ...parsed.data,
      corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    };
  }
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}
