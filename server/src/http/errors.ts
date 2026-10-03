/**
 * One error envelope for every API response: {error:{code,message,details?}}
 * (contract/src/ingest.ts ApiError). Routes throw HttpError; app.onError turns
 * it, or anything unexpected, into the envelope.
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ErrorCode } from '@snitch/contract';

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export function errorBody(code: ErrorCode, message: string, details?: unknown) {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export function sendError(c: Context, err: HttpError): Response {
  if (err.headers) for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
  return c.json(errorBody(err.code, err.message, err.details), err.status);
}

export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, 'forbidden', msg);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, 'unauthorized', msg);
export const invalid = (msg: string, details?: unknown) => new HttpError(422, 'invalid_request', msg, details);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, 'conflict', msg, details);
