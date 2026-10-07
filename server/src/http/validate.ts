import type { Context } from 'hono';
import type { z } from 'zod';
import { HttpError, invalid } from './errors';

function issues(error: z.ZodError) {
  return error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Reads and validates a JSON body; 415 for a non-JSON content type, 422 with field issues for bad input. */
export async function jsonBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const type = c.req.header('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Expected application/json');
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw invalid('Body is not valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalid('Request body failed validation', issues(parsed.error));
  return parsed.data;
}

export function query<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw invalid('Query failed validation', issues(parsed.error));
  return parsed.data;
}
