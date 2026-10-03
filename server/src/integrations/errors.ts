/** A failure worth retrying (network, 5xx, 429) vs one that won't fix itself (bad token, missing repo). */
export class SendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.min(6 * 3600_000, Math.max(1000, s * 1000));
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(1000, d - Date.now()) : undefined;
}

export function classifyHttp(res: Response, what: string, body: string): SendError {
  const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
  return new SendError(`${what} failed: HTTP ${res.status} ${body.slice(0, 300)}`.trim(), retryable, retryAfterMs(res));
}
