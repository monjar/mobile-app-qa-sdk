/**
 * Two-way sync between a ticket and the GitHub issue it was escalated to.
 *
 * Outbound (jobs queued from the dashboard routes): a status change closes or
 * reopens the issue (syncStatus), a Snitch comment is posted to it
 * (syncComments). The status job reads the ticket when it runs, so retries and
 * quick back-and-forth changes converge on the latest status.
 *
 * Inbound (the signed webhook, routes/hooks.ts): the issue being closed or
 * reopened moves the ticket, a new issue comment becomes an `external_comment`
 * event, and a pull request that says it fixes the issue ("Fixes #12") is
 * recorded on the ticket when it's opened, merged or closed. Merging doesn't
 * move the ticket by itself: GitHub closes the issue, and that event does. Inbound changes never queue outbound jobs, and comments Snitch posts
 * carry a marker so they are not imported back: no loops.
 */
import { GithubConfig, type TicketStatus } from '@snitch/contract';
import { z } from 'zod';
import type { Deps } from '../deps';
import type { IntegrationRow } from '../repo/integrations';
import { isOpenStatus, type TicketRow } from '../repo/tickets';
import { classifyHttp, SendError } from './errors';
import { githubApiBase, githubHeaders, githubRepoPath } from './github';

/** Start of every hidden marker Snitch writes into GitHub (issue bodies, comments). */
export const SNITCH_MARKER_PREFIX = '<!-- snitch:';
const COMMENT_MAX = 10_000;

export function commentMarker(eventId: number): string {
  return `<!-- snitch:comment:${eventId} -->`;
}

/** What closing a ticket with this status means on GitHub. */
export function issueStateFor(status: TicketStatus): { state: 'open' } | { state: 'closed'; state_reason: 'completed' | 'not_planned' } {
  if (isOpenStatus(status)) return { state: 'open' };
  return { state: 'closed', state_reason: status === 'resolved' ? 'completed' : 'not_planned' };
}

interface SyncTarget {
  integration: IntegrationRow;
  cfg: GithubConfig;
  token: string;
  issueUrl: string;
  ticket: TicketRow;
}

/** Loads what a sync job needs, or null when the escalation, integration or setting went away meanwhile. */
function target(deps: Deps, escalationId: string, setting: 'syncStatus' | 'syncComments'): SyncTarget | null {
  const esc = deps.integrations.escalation(escalationId);
  if (!esc || esc.state !== 'sent' || !esc.external_id) return null;
  const integration = deps.integrations.get(esc.integration_id);
  const ticket = deps.tickets.get(esc.ticket_id);
  if (!integration || integration.kind !== 'github' || integration.enabled !== 1 || !ticket) return null;
  const cfg = GithubConfig.parse(JSON.parse(integration.config_json));
  if (!cfg[setting]) return null;
  const token = deps.integrations.secret(integration);
  if (!token) throw new SendError('GitHub integration has no token', false);
  return { integration, cfg, token, ticket, issueUrl: `${githubApiBase(cfg)}${githubRepoPath(cfg)}/issues/${encodeURIComponent(esc.external_id)}` };
}

async function call(deps: Deps, url: string, init: RequestInit, what: string): Promise<string> {
  let res: Response;
  try {
    res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new SendError(`GitHub request failed: ${(e as Error).message}`, true);
  }
  const text = await res.text();
  if (!res.ok) throw classifyHttp(res, what, text);
  return text;
}

/** The `github_status` job: make the issue's open/closed state match the ticket's current status. */
export async function syncStatus(deps: Deps, escalationId: string): Promise<void> {
  const t = target(deps, escalationId, 'syncStatus');
  if (!t) return;
  await call(deps, t.issueUrl, { method: 'PATCH', headers: githubHeaders(t.token), body: JSON.stringify(issueStateFor(t.ticket.status)) }, 'GitHub update issue');
}

/**
 * The `github_comment` job: post one Snitch comment to the issue. On a retry it
 * first looks for the marker, in case the previous attempt posted but never
 * learned it had.
 */
export async function syncComment(deps: Deps, escalationId: string, eventId: number, retry: boolean): Promise<void> {
  const t = target(deps, escalationId, 'syncComments');
  const event = deps.tickets.event(eventId);
  if (!t || !event || event.kind !== 'comment' || event.ticket_id !== t.ticket.id) return;
  const marker = commentMarker(eventId);
  if (retry) {
    const since = new Date(deps.now() - 7 * 86_400_000).toISOString();
    const list = await call(deps, `${t.issueUrl}/comments?per_page=100&since=${encodeURIComponent(since)}`, { headers: githubHeaders(t.token) }, 'GitHub list comments');
    const comments = JSON.parse(list) as { body?: string }[];
    if (comments.some((c) => c.body?.includes(marker))) return;
  }
  const author = event.actor_user_id ? deps.users.get(event.actor_user_id) : null;
  const name = author ? (author.name ?? author.email) : 'Someone';
  const body = `**${name}** commented in Snitch:\n\n${String(event.data.body ?? '')}\n\n${marker}`;
  await call(deps, `${t.issueUrl}/comments`, { method: 'POST', headers: githubHeaders(t.token), body: JSON.stringify({ body }) }, 'GitHub create comment');
}

// ── Inbound ────────────────────────────────────────────────────────────────

/** The fields of GitHub's `issues` / `issue_comment` payloads Snitch reads. Everything else is ignored. */
const IssueEvent = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number().int(),
    html_url: z.string(),
    state: z.string(),
    state_reason: z.string().nullish(),
  }),
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
  sender: z.object({ login: z.string() }).nullish(),
  comment: z
    .object({
      id: z.number().int(),
      body: z.string().nullish(),
      html_url: z.string(),
      user: z.object({ login: z.string() }).nullish(),
    })
    .nullish(),
});

/** The fields of GitHub's `pull_request` payload Snitch reads. */
const PullRequestEvent = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number().int(),
    html_url: z.string(),
    title: z.string(),
    body: z.string().nullish(),
    state: z.string().nullish(),
    merged: z.boolean().nullish(),
    user: z.object({ login: z.string() }).nullish(),
  }),
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
});

/**
 * Issue numbers in `owner/repo` that a pull request body says it closes, using GitHub's closing keywords:
 * "Fixes #12", "closes: owner/repo#12", "resolved https://github.com/owner/repo/issues/12". Like GitHub,
 * it reads the body only (not the title, so a revert titled `Revert "… (fixes #12)"` doesn't count), skips
 * HTML comments (PR templates) and code, and wants the keyword and the reference on the same line.
 */
export function closingRefs(body: string, owner: string, repo: string): number[] {
  const same = (o?: string, r?: string) => !o || (o.toLowerCase() === owner.toLowerCase() && r!.toLowerCase() === repo.toLowerCase());
  const text = body
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  const found = new Set<number>();
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?[ \t]+(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b|\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?[ \t]+https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\b/gi;
  for (const m of text.matchAll(re)) {
    if (m[3] && same(m[1], m[2])) found.add(Number(m[3]));
    if (m[6] && same(m[4], m[5])) found.add(Number(m[6]));
  }
  return [...found];
}

function prState(action: string, pr: { state?: string | null; merged?: boolean | null }): 'opened' | 'merged' | 'closed' | null {
  const current = () => (pr.merged === true ? 'merged' : pr.state === 'closed' ? 'closed' : 'opened');
  // An edit can add "Fixes #12" to a pull request that's already merged: record what it is now.
  if (action === 'edited') return current();
  if (action === 'opened' || action === 'reopened' || action === 'ready_for_review') return 'opened';
  if (action === 'closed') return pr.merged === true ? 'merged' : 'closed';
  return null;
}

/** Records a pull request on every linked ticket whose issue it says it fixes. */
function handlePullRequest(deps: Deps, integration: IntegrationRow, cfg: GithubConfig, raw: unknown): HookResult {
  const parsed = PullRequestEvent.safeParse(raw);
  if (!parsed.success) return ignored('payload has no pull request');
  const { action, pull_request: pr, repository } = parsed.data;
  if (repository.owner.login.toLowerCase() !== cfg.owner.toLowerCase() || repository.name.toLowerCase() !== cfg.repo.toLowerCase()) {
    return ignored(`repository ${repository.owner.login}/${repository.name} is not ${cfg.owner}/${cfg.repo}`);
  }
  const state = prState(action, pr);
  if (!state) return ignored(`action ${action} is not used`);
  const issues = closingRefs(pr.body ?? '', cfg.owner, cfg.repo);
  if (!issues.length) return ignored(`pull request #${pr.number} doesn't say it fixes an issue`);
  const recorded: string[] = [];
  for (const n of issues) {
    const esc = deps.integrations.escalationByExternalId(integration.id, String(n));
    const ticket = esc ? deps.tickets.get(esc.ticket_id) : null;
    if (!ticket) continue;
    const data = { integrationId: integration.id, number: pr.number, title: pr.title.slice(0, 200), url: pr.html_url, state, ...(pr.user ? { author: pr.user.login } : {}) };
    // One event per pull request and state: redeliveries and repeated edits change nothing.
    if (deps.tickets.addExternalEvent(ticket.id, { type: 'integration' }, 'external_pull_request', data, `pr:${pr.number}:${state}`) !== null) {
      deps.tickets.touch(ticket.id);
      recorded.push(`#${n}`);
    }
  }
  return recorded.length ? { handled: true, detail: `pull request #${pr.number} ${state}, recorded on ${recorded.join(', ')}` } : ignored(`no new linked tickets for pull request #${pr.number}`);
}

export interface HookResult {
  handled: boolean;
  detail: string;
}

const ignored = (detail: string): HookResult => ({ handled: false, detail });

/** Applies one verified GitHub event to the ticket its issue belongs to. */
export function handleGithubEvent(deps: Deps, integration: IntegrationRow, event: string, raw: unknown): HookResult {
  if (event === 'pull_request') return handlePullRequest(deps, integration, GithubConfig.parse(JSON.parse(integration.config_json)), raw);
  if (event !== 'issues' && event !== 'issue_comment') return ignored(`event ${event} is not used`);
  const parsed = IssueEvent.safeParse(raw);
  if (!parsed.success) return ignored('payload has no issue');
  const p = parsed.data;
  const cfg = GithubConfig.parse(JSON.parse(integration.config_json));
  if (p.repository.owner.login.toLowerCase() !== cfg.owner.toLowerCase() || p.repository.name.toLowerCase() !== cfg.repo.toLowerCase()) {
    return ignored(`repository ${p.repository.owner.login}/${p.repository.name} is not ${cfg.owner}/${cfg.repo}`);
  }
  const esc = deps.integrations.escalationByExternalId(integration.id, String(p.issue.number));
  const ticket = esc ? deps.tickets.get(esc.ticket_id) : null;
  if (!ticket) return ignored(`issue #${p.issue.number} is not linked to a ticket`);
  const actor = { type: 'integration' as const };

  if (event === 'issues') {
    if (p.action !== 'closed' && p.action !== 'reopened') return ignored(`action ${p.action} is not used`);
    if (!cfg.syncStatus) return ignored('status sync is off');
    const closing = p.action === 'closed';
    // "Already there" means the same side of open/closed: the echo of a change Snitch made
    // (a duplicate closed as not_planned must not turn into won't fix) changes nothing.
    if (closing !== isOpenStatus(ticket.status)) return ignored(`ticket is already ${closing ? 'closed' : 'open'}`);
    const to: TicketStatus = closing ? (p.issue.state_reason === 'not_planned' ? 'wont_fix' : 'resolved') : 'triaged';
    deps.tickets.addEvent(ticket.id, actor, 'external_status_changed', {
      integrationId: integration.id,
      state: closing ? 'closed' : 'open',
      ...(p.issue.state_reason ? { stateReason: p.issue.state_reason } : {}),
      url: p.issue.html_url,
      ...(p.sender ? { author: p.sender.login } : {}),
    });
    deps.tickets.setStatus(ticket.id, to, actor);
    return { handled: true, detail: `ticket is now ${to}` };
  }

  if (p.action !== 'created' || !p.comment) return ignored(`action ${p.action} is not used`);
  if (!cfg.syncComments) return ignored('comment sync is off');
  const body = p.comment.body ?? '';
  if (body.includes(SNITCH_MARKER_PREFIX)) return ignored('comment came from Snitch');
  const externalId = String(p.comment.id);
  const id = deps.tickets.addExternalEvent(
    ticket.id,
    actor,
    'external_comment',
    {
      integrationId: integration.id,
      body: body.length > COMMENT_MAX ? `${body.slice(0, COMMENT_MAX - 1)}…` : body,
      author: p.comment.user?.login ?? p.sender?.login ?? null,
      url: p.comment.html_url,
      externalId,
    },
    externalId,
  );
  if (id === null) return ignored('comment already recorded');
  deps.tickets.touch(ticket.id);
  return { handled: true, detail: 'comment added' };
}
