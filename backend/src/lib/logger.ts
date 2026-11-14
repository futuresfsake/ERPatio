import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';
import { getEnv } from '../config/env.js';

export interface RequestContext {
  requestId: string;
  tenantId?: string;
}
export const als = new AsyncLocalStorage<RequestContext>();

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const BEARER = /bearer\s+[A-Za-z0-9._~+/=-]+/gi;

/** PII masking for log output (FR-PRV-03, BRU-PRV-2). */
export function mask(text: string): string {
  return text.replace(EMAIL, '[email]').replace(BEARER, 'Bearer [redacted]').replace(JWT, '[jwt]');
}

function maskDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return mask(value);
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v, depth + 1)]));
}

export function createLogger(stream?: pino.DestinationStream, level?: string): pino.Logger {
  const opts: pino.LoggerOptions = {
    level: level ?? (getEnv().NODE_ENV === 'test' ? 'silent' : getEnv().LOG_LEVEL),
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'password', '*.password', 'token', '*.token', 'authorization', 'refresh_token', '*.refresh_token'], censor: '[redacted]' },
    mixin: () => ({ request_id: als.getStore()?.requestId, tenant_id: als.getStore()?.tenantId }),
    formatters: { log: (o) => maskDeep(o) as Record<string, unknown> },
    hooks: {
      logMethod(args, method) {
        for (let i = 0; i < args.length; i++) if (typeof args[i] === 'string') args[i] = mask(args[i] as string);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (method as any).apply(this, args);
      },
    },
  };
  return stream ? pino(opts, stream) : pino(opts);
}

let shared: pino.Logger | undefined;
export const logger = (): pino.Logger => (shared ??= createLogger());
