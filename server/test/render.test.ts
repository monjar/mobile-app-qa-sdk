/* eslint-disable @typescript-eslint/no-explicit-any -- test bodies are asserted field by field */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTimeline } from '@snitch/contract';
import { drain } from '../src/worker/worker';
import { email, githubIssue, type RenderInput } from '../src/integrations/render';
import { oneLine, summarizeTimeline } from '../src/integrations/timeline';
import type { TicketRow } from '../src/repo/tickets';
import { adminFetch, FakeGithub, harness, login, postReport, putAttachment, report, sdkHeaders, sha256, type Harness } from './helpers';

const fixtureText = readFileSync(join(__dirname, '..', '..', 'contract', 'fixtures', 'timeline.ndjson'), 'utf8');

function input(patch: Partial<RenderInput> = {}): RenderInput {
  const ticket = { id: 'T1', title: 'Froze', description: 'It froze', reporter_email: null } as TicketRow;
  return {
    key: 'MOCH-1',
    ticket,
    meta: { app: { id: 'app', version: '1.0', build: '1', releaseType: 'debug' }, device: { platform: 'ios', osVersion: '18', model: 'iPhone' }, sdk: { name: 'snitch-ios', version: '0.3.0' }, custom: {}, stats: {} },
    typeLabel: 'Bug',
    projectName: 'Mochiro',
    dashboardUrl: 'http://snitch.test/tickets/T1',
    links: {},
    hasScreenshot: false,
    videoSeconds: null,
    ...patch,
  };
}

describe('before the report', () => {
  it('picks the screen, error logs and failed requests from a timeline', () => {
    const summary = summarizeTimeline(parseTimeline(fixtureText), null, 0);
    expect(summary.screen).toBe('index');
    expect(summary.lines).toEqual([
      '-6.1 s   GET https://api.mochiro.app/v1/facts → failed: The request timed out. (30001 ms)',
      "-1.1 s   error [js] TypeError: undefined is not an object (evaluating 'turn.reply')",
    ]);
    // The report's own screen wins over the timeline's last one.
    expect(summarizeTimeline(parseTimeline(fixtureText), 'Settings', 0).screen).toBe('Settings');
  });

  it('keeps the ten most recent lines, one line each', () => {
    const events = Array.from({ length: 15 }, (_, i) => JSON.stringify({ k: 'net', t: 1000 + i, method: 'GET', url: `https://x/${i}`, status: 500 }));
    events.push(JSON.stringify({ k: 'log', t: 2000, level: 'error', src: 'native', tag: 'net', msg: `line one\n   line two ${'x'.repeat(300)}` }));
    events.push(JSON.stringify({ k: 'net', t: 2001, method: 'GET', url: 'https://x/ok', status: 204 }));
    const s = summarizeTimeline(parseTimeline(events.join('\n')), null, 3000);
    expect(s.screen).toBeNull();
    expect(s.lines).toHaveLength(10);
    expect(s.lines[0]).toContain('https://x/6 → 500');
    const last = s.lines.at(-1)!;
    expect(last).toMatch(/^-1\.0 s {3}error \[net\] line one line two x+…$/);
    expect(last).toHaveLength(160);
    expect(oneLine('a\nb')).toBe('a b');
  });

  it('adds a section to GitHub issues and emails only when there is a timeline', () => {
    const without = githubIssue(input());
    expect(without.body).not.toContain('Before the report');
    const withIt = githubIssue(input({ beforeReport: { screen: 'Home', lines: ['-1.0 s   error [js] ```oops```'] } }));
    const section = '**Before the report**\n\n````text\nScreen   Home\n-1.0 s   error [js] ```oops```\n````\n\n';
    expect(withIt.body).toContain(section);
    // The rest of the issue is unchanged.
    expect(withIt.body.replace(section, '')).toBe(without.body);

    const quiet = githubIssue(input({ beforeReport: { screen: null, lines: [] } }));
    expect(quiet.body).toContain('```text\nNo errors or failed requests in the timeline.\n```');

    const mail = email(input({ beforeReport: { screen: '<Home>', lines: ['-2.0 s   GET https://x → 500'] } }), '[Snitch]', null);
    expect(mail.text).toContain('Before the report:\n  Screen   <Home>\n  -2.0 s   GET https://x → 500\n');
    expect(mail.html).toContain('Screen   &lt;Home&gt;');
    expect(email(input(), '[Snitch]', null).html).not.toContain('Before the report');
  });

  it('tells GitHub readers (and agents) how to fetch the whole report', () => {
    const { body } = githubIssue(input());
    expect(body).toContain('<code>npx snitch-cli ticket MOCH-1 --download</code>');
    // The marker stays last, where findExisting and older readers expect it.
    expect(body.trimEnd().split('\n').at(-1)).toMatch(/^<!-- snitch:ticket=/);
  });
});

/** Sends a report whose only attachment is the timeline fixture. */
async function sendWithTimeline(h: Harness): Promise<string> {
  const body = Buffer.from(fixtureText);
  const res = await postReport(h, report({}, { screen: 'index', attachments: [{ name: 'timeline', contentType: 'application/x-ndjson', sizeBytes: body.length, sha256: sha256(body) }] }));
  const { reportId } = (await res.json()) as { reportId: string };
  expect((await putAttachment(h, reportId, 'timeline', body, 'application/x-ndjson')).status).toBe(201);
  expect((await h.app.request(`/api/v1/reports/${reportId}/complete`, { method: 'POST', headers: sdkHeaders() })).status).toBe(200);
  return reportId;
}

describe('escalations with a timeline', () => {
  it('put the summary in the GitHub issue and the email', async () => {
    const h = await harness();
    const s = await login(h);
    const gh = new FakeGithub();
    h.onFetch(gh.handle);
    const ghId = (await (await adminFetch(h, s, `/projects/${h.projectId}/integrations`, { method: 'POST', body: { kind: 'github', name: 'GitHub', config: { owner: 'monjar', repo: 'mochiro' }, secret: 'ghp_test' } })).json() as any).id;
    const mailId = (await (await adminFetch(h, s, `/projects/${h.projectId}/integrations`, { method: 'POST', body: { kind: 'email', name: 'Mail', config: { to: ['qa@example.com'] } } })).json() as any).id;
    await adminFetch(h, s, `/projects/${h.projectId}/routing`, { method: 'PUT', body: { rules: [{ reportType: '*', integrationId: ghId, mode: 'auto' }, { reportType: '*', integrationId: mailId, mode: 'auto' }] } });
    await sendWithTimeline(h);
    await drain(h.deps);
    const issue = gh.issues.get(1)!;
    expect(issue.body).toContain('**Before the report**');
    expect(issue.body).toContain('Screen   index');
    expect(issue.body).toContain("TypeError: undefined is not an object (evaluating 'turn.reply')");
    expect(issue.body).not.toContain('theme restored');
    expect(h.mailer.sent[0]!.text).toContain('GET https://api.mochiro.app/v1/facts → failed: The request timed out.');
  });
});
