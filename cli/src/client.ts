/**
 * A small client for the parts of the Snitch admin API an API token can use
 * (server/src/http/apiAuth.ts), plus device sign-in.
 */
import type {
  ApiTokenScope,
  DeviceCodeIssued,
  DeviceTokenResult,
  ProjectView,
  TicketDetail,
  TicketList,
  TicketListQuery,
  TicketPatch,
  WhoAmI,
} from '@snitch/contract';
import { VERSION } from './version';

export class SnitchError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const KEY = /^[A-Z][A-Z0-9]{0,9}-\d+$/;

/**
 * What a ticket reference means: a ticket id, a key like APP-12, or a dashboard
 * link (…/tickets/<id>).
 */
export function parseTicketRef(ref: string): { id: string } | { key: string } {
  const r = ref.trim();
  const fromUrl = /\/tickets\/([0-9A-HJKMNP-TV-Z]{26})(?:[/?#]|$)/i.exec(r)?.[1];
  if (fromUrl) return { id: fromUrl.toUpperCase() };
  if (ULID.test(r.toUpperCase()) && !KEY.test(r.toUpperCase())) return { id: r.toUpperCase() };
  if (KEY.test(r.toUpperCase())) return { key: r.toUpperCase() };
  throw new SnitchError(0, 'invalid_request', `Not a ticket key, id or link: ${ref}`);
}

export class SnitchClient {
  constructor(
    readonly server: string,
    private readonly token: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async send(method: string, path: string, body?: unknown, auth = true): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': `snitch-cli/${VERSION}` };
    if (auth && this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.server}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new SnitchError(0, 'network', `Couldn't reach ${this.server}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text();
      let err: { code?: string; message?: string } = {};
      try {
        err = (JSON.parse(text) as { error?: typeof err }).error ?? {};
      } catch {
        // Not our envelope (a proxy error page): use the status.
      }
      const message = err.message ?? `${method} ${path} failed (${res.status})`;
      if (res.status === 401 && auth) throw new SnitchError(401, 'unauthorized', `${message}. Sign in again with \`snitch login --server ${this.server}\`.`);
      throw new SnitchError(res.status, err.code ?? 'http', message);
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    return (await (await this.send(method, path, body, auth)).json()) as T;
  }

  whoami(): Promise<WhoAmI> {
    return this.json('GET', '/api/admin/token');
  }

  /** Revokes the token this client uses. */
  async revokeSelf(): Promise<void> {
    await this.send('DELETE', '/api/admin/token');
  }

  projects(): Promise<ProjectView[]> {
    return this.json('GET', '/api/admin/projects');
  }

  tickets(q: TicketListQuery = {}): Promise<TicketList> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v));
    const qs = params.toString();
    return this.json('GET', `/api/admin/tickets${qs ? `?${qs}` : ''}`);
  }

  /** A ticket by id, key (APP-12) or dashboard link. */
  async ticket(ref: string): Promise<TicketDetail> {
    const parsed = parseTicketRef(ref);
    if ('id' in parsed) return this.json('GET', `/api/admin/tickets/${parsed.id}`);
    const list = await this.tickets({ q: parsed.key, status: 'all', limit: 5 });
    const hit = list.items.find((t) => t.key === parsed.key);
    if (!hit) throw new SnitchError(404, 'not_found', `No ticket ${parsed.key} on ${this.server}`);
    return this.json('GET', `/api/admin/tickets/${hit.id}`);
  }

  /** An attachment's bytes; `url` is the relative URL from TicketDetail.attachments. */
  async attachment(url: string): Promise<Buffer> {
    return Buffer.from(await (await this.send('GET', url)).arrayBuffer());
  }

  update(id: string, patch: TicketPatch): Promise<unknown> {
    return this.json('PATCH', `/api/admin/tickets/${id}`, patch);
  }

  comment(id: string, body: string): Promise<unknown> {
    return this.json('POST', `/api/admin/tickets/${id}/comments`, { body });
  }

  async startDevice(req: { clientName: string; scopes: ApiTokenScope[]; expiresInDays?: number | null }): Promise<DeviceCodeIssued> {
    try {
      return await this.json('POST', '/api/admin/auth/device', req, false);
    } catch (e) {
      if (e instanceof SnitchError && e.status === 404) {
        throw new SnitchError(404, 'not_found', `${this.server} doesn't offer CLI sign-in. It needs Snitch server 0.5 or later.`);
      }
      throw e;
    }
  }

  pollDevice(deviceCode: string): Promise<DeviceTokenResult> {
    return this.json('POST', '/api/admin/auth/device/token', { deviceCode }, false);
  }
}
