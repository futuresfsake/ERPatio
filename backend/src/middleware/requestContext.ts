import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { als, logger } from '../lib/logger.js';

const VALID_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Request id, async-local context for logs, and one access-log line per request. */
export const requestContext: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  const requestId = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-ID', requestId);
  const started = process.hrtime.bigint();
  als.run({ requestId }, () => {
    res.on('finish', () => {
      logger().info(
        { method: req.method, path: req.path, status: res.statusCode, ms: Number((process.hrtime.bigint() - started) / 1_000_000n) },
        'request',
      );
    });
    next();
  });
};
