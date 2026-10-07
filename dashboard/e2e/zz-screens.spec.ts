import { test } from '@playwright/test';
import { sendReport, signIn } from './fixtures';

// Not a test of behaviour: captures screenshots for visual review when SNITCH_SCREENSHOTS is set.
test.skip(!process.env.SNITCH_SCREENSHOTS, 'screenshots only on request');

test('screenshots', async ({ page, browser }) => {
  const r = sendReport('Tapping a reminder twice opens two sheets\nRepro: open Today, double-tap the 9am reminder.');
  for (const scheme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1360, height: 900 } });
    const p = await ctx.newPage();
    await signIn(p);
    await p.screenshot({ path: `${process.env.SNITCH_SCREENSHOTS}/inbox-${scheme}.png` });
    await p.goto(`/tickets/${r.reportId}`);
    await p.waitForTimeout(500);
    await p.screenshot({ path: `${process.env.SNITCH_SCREENSHOTS}/ticket-${scheme}.png`, fullPage: true });
    await p.goto(`/projects/${(await (await p.request.get('/api/admin/projects')).json())[0].id}/settings/builds`);
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${process.env.SNITCH_SCREENSHOTS}/builds-${scheme}.png`, fullPage: true });
    await ctx.close();
  }
  void page;
});
