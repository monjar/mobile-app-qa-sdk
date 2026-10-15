import { test, type Page } from '@playwright/test';
import { TIMELINE_END, TIMELINE_FIXTURE, makeVideo, sendReport, sendReportWith, signIn } from './fixtures';

// Not a test of behaviour: captures screenshots for visual review when SNITCH_SCREENSHOTS is set.
test.skip(!process.env.SNITCH_SCREENSHOTS, 'screenshots only on request');

/** The page scrolls inside .main, so a tall viewport stands in for fullPage. */
async function shoot(p: Page, path: string) {
  await p.locator('.main').evaluate((el) => (el.scrollTop = 0));
  const height = await p.locator('.main').evaluate((el) => el.scrollHeight);
  await p.setViewportSize({ width: 1360, height: Math.max(900, Math.min(height, 2400)) });
  await p.waitForTimeout(200);
  await p.screenshot({ path });
  await p.setViewportSize({ width: 1360, height: 900 });
}

test('screenshots', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const r = sendReport('Tapping a reminder twice opens two sheets\nRepro: open Today, double-tap the 9am reminder.');
  const withTimeline = await sendReportWith({
    description: 'Facts never load after waking the app\nThe spinner keeps going, then the face freezes.',
    screen: 'index',
    reportedAt: TIMELINE_END,
    attachments: [
      { name: 'video', contentType: 'video/mp4', body: makeVideo(15), durationMs: 15_000 },
      { name: 'timeline', contentType: 'application/x-ndjson', body: TIMELINE_FIXTURE },
    ],
  });
  // Similar to the one above, so its page shows the similar-tickets panel next to the crash report.
  const crash = await sendReportWith({
    description: 'Facts never load, then the app closed',
    screen: 'index',
    trigger: 'crash',
    attachments: [{ name: 'crash', contentType: 'text/plain', body: Buffer.from(JSON.stringify({ crashDiagnostic: { exceptionType: 1, signal: 6, callStack: ['main', 'abort'] } })) }],
  });
  const dir = process.env.SNITCH_SCREENSHOTS;
  let seeded = false;
  for (const scheme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1360, height: 900 } });
    const p = await ctx.newPage();
    await signIn(p);
    const project = (await (await p.request.get('/api/admin/projects')).json())[0].id;
    if (!seeded) {
      seeded = true;
      const headers = { 'x-csrf-token': (await (await p.request.get('/api/admin/auth/me')).json()).csrfToken };
      await p.request.patch(`/api/admin/tickets/${r.reportId}`, { headers, data: { status: 'resolved', fixedIn: '0.6.1 (18)' } });
      const config = { owner: 'monjar', repo: 'mochiro-mobile', labels: ['bug-report'], assignees: [], includeShareLinks: false, shareTtlDays: 30, syncStatus: true, syncComments: false };
      await p.request.post(`/api/admin/projects/${project}/integrations`, { headers, data: { kind: 'github', name: 'GitHub issues', secret: 'github_pat_screens', config } });
      await p.reload();
    }
    await shoot(p, `${dir}/inbox-${scheme}.png`);
    await p.goto(`/tickets/${r.reportId}`);
    await p.waitForTimeout(500);
    await shoot(p, `${dir}/ticket-${scheme}.png`);
    await p.goto(`/tickets/${withTimeline.reportId}`);
    await p.getByRole('button', { name: /^Play from 0:13\.9/ }).click();
    await p.waitForTimeout(300);
    await shoot(p, `${dir}/timeline-${scheme}.png`);
    await p.goto(`/tickets/${crash.reportId}`);
    await p.waitForTimeout(300);
    await shoot(p, `${dir}/crash-${scheme}.png`);
    await p.goto(`/projects/${project}/settings/builds`);
    await p.waitForTimeout(300);
    await shoot(p, `${dir}/builds-${scheme}.png`);
    await p.goto(`/projects/${project}/settings/integrations`);
    await p.waitForTimeout(300);
    await shoot(p, `${dir}/integrations-${scheme}.png`);
    await p.goto(`/projects/${project}/devices`);
    await p.waitForTimeout(300);
    await shoot(p, `${dir}/devices-${scheme}.png`);
    await p.goto('/jobs');
    await p.waitForTimeout(300);
    await shoot(p, `${dir}/jobs-${scheme}.png`);
    const csrf = { 'x-csrf-token': (await (await p.request.get('/api/admin/auth/me')).json()).csrfToken };
    await p.request.post('/api/admin/tokens', { headers: csrf, data: { name: `CI (${scheme})`, scopes: ['tickets:read'], expiresInDays: 30 } });
    await p.goto('/tokens');
    await p.waitForTimeout(300);
    await shoot(p, `${dir}/tokens-${scheme}.png`);
    const device = (await (await p.request.post('/api/admin/auth/device', { data: { clientName: 'snitch CLI on build-01' } })).json()) as { userCode: string };
    await p.goto(`/device?code=${device.userCode}`);
    await p.waitForTimeout(300);
    await shoot(p, `${dir}/device-${scheme}.png`);
    await ctx.close();
  }
  void page;
});
