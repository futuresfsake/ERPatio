import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ApiError } from '../lib/errors.js';
import { als, logger } from '../lib/logger.js';

interface PgError extends Error {
  code?: string;
  constraint?: string;
}

/** Translate database rule violations into clean client errors (no SQL leaks, FR-SEC-12). */
export function fromDbError(err: PgError): ApiError | null {
  const msg = err.message ?? '';
  switch (err.code) {
    case '23514':
      if (msg.includes('is closed')) return new ApiError(422, 'period_closed', 'That fiscal period is closed. Pick a date in an open period.');
      if (msg.includes('no fiscal period covers')) return new ApiError(422, 'no_period', 'No fiscal period covers that date. Ask an administrator to create the fiscal year.');
      if (msg.includes('unbalanced') || msg.includes('at least two lines'))
        return new ApiError(422, 'unbalanced_entry', 'Total debits must equal total credits.');
      return new ApiError(422, 'integrity_error', 'The change violates a data integrity rule.');
    case '23505':
      if (err.constraint === 'ux_journal_entries_reversal') return new ApiError(409, 'already_reversed', 'This entry has already been reversed.');
      return new ApiError(409, 'conflict', 'That value already exists.');
    case '23503':
      return new ApiError(422, 'integrity_error', 'A referenced record does not exist.');
    case '22P02':
    case '22007':
    case '22003':
      return new ApiError(422, 'validation_error', 'The request is invalid.');
    case '42501':
      return new ApiError(409, 'immutable', 'Posted records cannot be changed; post a reversing entry instead.');
    case '57014':
      return new ApiError(503, 'timeout', 'The request took too long. Try again.');
    default:
      return null;
  }
}

export const notFoundHandler: RequestHandler = (_req, _res, next) =>
  next(new ApiError(404, 'not_found', 'Resource not found.'));

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const requestId = als.getStore()?.requestId;
  const known: ApiError | null =
    err instanceof ApiError
      ? err
      : err?.type === 'entity.parse.failed'
        ? new ApiError(400, 'invalid_json', 'The request body is not valid JSON.')
        : err?.type === 'entity.too.large'
          ? new ApiError(413, 'payload_too_large', 'The request body is too large.')
          : fromDbError(err);
  let api = known;

  if (!api) {
    logger().error({ err: { name: err?.name, message: err?.message, stack: err?.stack }, path: req.path }, 'unhandled_error');
    api = new ApiError(500, 'internal_error', 'Something went wrong.');
  }
  res.set(api.headers).status(api.status).json({
    error: { code: api.code, message: api.message, request_id: requestId, ...(api.details ? { details: api.details } : {}) },
  });
};
