/**
 * Creates a GitHub issue for a ticket with a fine-grained PAT (Issues: write).
 *
 * GitHub has no API for issue attachments, so media is either linked through
 * Snitch share links (opt-in) or left in the dashboard. A hidden marker in the
 * body lets a retry find the issue a previous, half-finished attempt created.
 */
import { GithubConfig } from '@snitch/contract';
import type { Deps } from '../deps';
import type { IntegrationRow } from '../repo/integrations';
import type { TicketRow } from '../repo/tickets';
import { buildTicketContext } from './context';
import { classifyHttp, SendError } from './errors';
import { GITHUB_MARKER, githubIssue } from './render';
import { VERSION } from '../version';

export interface SendResult {
  externalId: string | null;
  externalUrl: string | null;
}

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': `snitch-server/${VERSION}`,
    'content-type': 'application/json',
  };
}

export async function sendGithub(deps: Deps, integration: IntegrationRow, ticket: TicketRow, userId: string | null): Promise<SendResult> {
  const cfg = GithubConfig.parse(JSON.parse(integration.config_json));
  const token = deps.integrations.secret(integration);
  if (!token) throw new SendError('GitHub integration has no token', false);
  const api = (cfg.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const repoPath = `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;

  const existing = await findExisting(deps, api, cfg.owner, cfg.repo, token, ticket.id);
  if (existing) return existing;

  const ctx = buildTicketContext(deps, ticket, { enabled: cfg.includeShareLinks, ttlDays: cfg.shareTtlDays, userId, integration });
  const { title, body } = githubIssue(ctx.render);
  const labels = [...new Set([...cfg.labels, `type:${ticket.type}`])];
  let res: Response;
  try {
    res = await deps.fetch(`${api}${repoPath}/issues`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ title, body, labels, ...(cfg.assignees.length ? { assignees: cfg.assignees } : {}) }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new SendError(`GitHub request failed: ${(e as Error).message}`, true);
  }
  const text = await res.text();
  if (!res.ok) {
    // 422 with labels/assignees the token can't set: retry once without them rather than failing the escalation.
    if (res.status === 422 && /label|assignee/i.test(text)) {
      const retry = await deps.fetch(`${api}${repoPath}/issues`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({ title, body }),
        signal: AbortSignal.timeout(20_000),
      });
      const retryText = await retry.text();
      if (!retry.ok) throw classifyHttp(retry, 'GitHub create issue', retryText);
      return parseIssue(retryText);
    }
    throw classifyHttp(res, 'GitHub create issue', text);
  }
  return parseIssue(text);
}

function parseIssue(text: string): SendResult {
  const issue = JSON.parse(text) as { number?: number; html_url?: string };
  return { externalId: issue.number !== undefined ? String(issue.number) : null, externalUrl: issue.html_url ?? null };
}

/** Best effort: search for an issue carrying this ticket's marker. Search lags, so a miss is not proof. */
async function findExisting(deps: Deps, api: string, owner: string, repo: string, token: string, ticketId: string): Promise<SendResult | null> {
  try {
    const q = encodeURIComponent(`repo:${owner}/${repo} "snitch:ticket=${ticketId}" in:body is:issue`);
    const res = await deps.fetch(`${api}/search/issues?q=${q}&per_page=1`, { headers: headers(token), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { items?: { number: number; html_url: string; body?: string }[] };
    const hit = data.items?.find((i) => i.body?.includes(GITHUB_MARKER(ticketId)));
    return hit ? { externalId: String(hit.number), externalUrl: hit.html_url } : null;
  } catch {
    return null;
  }
}

/** Checks the token can see the repo; used by the dashboard's "Send test". */
export async function testGithub(deps: Deps, integration: IntegrationRow): Promise<string> {
  const cfg = GithubConfig.parse(JSON.parse(integration.config_json));
  const token = deps.integrations.secret(integration);
  if (!token) throw new SendError('No token configured', false);
  const api = (cfg.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const res = await deps.fetch(`${api}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`, {
    headers: headers(token),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw classifyHttp(res, 'GitHub repository check', text);
  const repo = JSON.parse(text) as { full_name?: string; has_issues?: boolean };
  if (repo.has_issues === false) throw new SendError(`${repo.full_name} has issues disabled`, false);
  return `Token can reach ${repo.full_name ?? `${cfg.owner}/${cfg.repo}`}`;
}
