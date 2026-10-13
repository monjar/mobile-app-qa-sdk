import { expect, test, type Page } from '@playwright/test';
import { TIMELINE_END, TIMELINE_FIXTURE, makeVideo, sendReportWith, signIn } from './fixtures';

test.describe.configure({ mode: 'serial' });

const RUN = Math.random().toString(36).slice(2, 7);
let timeline: { reportId: string; ticket: string };
let crash: { reportId: string; ticket: string };

test.beforeAll(async () => {
  timeline = await sendReportWith({
    description: `Facts never load ${RUN}`,
    screen: `index-${RUN}`,
    reportedAt: TIMELINE_END,
    attachments: [
      { name: 'video', contentType: 'video/mp4', body: makeVideo(15), durationMs: 15_000 },
      { name: 'timeline', contentType: 'application/x-ndjson', body: TIMELINE_FIXTURE },
    ],
  });
  crash = await sendReportWith({
    description: `The app closed on launch ${RUN}`,
    trigger: 'crash',
    screen: `launch-${RUN}`,
    attachments: [{ name: 'crash', contentType: 'text/plain', body: Buffer.from(JSON.stringify({ crashDiagnostic: { exceptionType: 1, signal: 6, callStack: ['main', 'abort'] } })) }],
  });
});

const rows = (page: Page) => page.locator('.tl-list > li');

test('shows the timeline, filters it and seeks the video from it', async ({ page }) => {
  await signIn(page);
  await page.goto(`/tickets/${timeline.reportId}`);
  const panel = page.getByRole('region', { name: 'Timeline' });
  // Ten events; the unknown kind and the line that isn't JSON are skipped and counted.
  await expect(panel.getByText('10 events · 2 errors')).toBeVisible();
  await expect(panel.getByText(/2 lines weren't readable/)).toBeVisible();
  await expect(rows(page)).toHaveCount(10);
  await expect(panel.getByText('TypeError: undefined is not an object')).toBeVisible();
  await expect(panel.getByText('https://api.mochiro.app/v1/facts')).toBeVisible();
  await expect(panel.getByText('The request timed out.', { exact: true })).toBeVisible();
  await expect(page.locator('.meta-table').getByText(`index-${RUN}`)).toBeVisible();

  // Events before the 15 s clip are dimmed; the five inside it are not.
  await expect(page.locator('.tl-list > li.outside')).toHaveCount(5);

  await panel.getByRole('button', { name: /^Errors only/ }).click();
  await expect(rows(page)).toHaveCount(2);
  await panel.getByRole('button', { name: /^Errors only/ }).click();
  await panel.getByRole('button', { name: /^Logs/ }).click();
  await expect(rows(page)).toHaveCount(7);
  await expect(panel.getByText('7 of 10 events · 2 errors')).toBeVisible();
  await panel.getByRole('button', { name: /^Logs/ }).click();
  await panel.getByLabel('Search the timeline').fill('facts');
  await expect(rows(page)).toHaveCount(1);
  await panel.getByLabel('Search the timeline').fill('');
  await expect(rows(page)).toHaveCount(10);

  // The player's controls are there; this Chromium can't decode H.264, so only positions are checked.
  for (const name of ['0.25×', '0.5×', '1×', '2×', 'Previous frame', 'Next frame']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  const video = page.locator('video');
  const currentTime = () => video.evaluate((v: HTMLVideoElement) => v.currentTime);

  // The error log is 13.88 s into the clip: clicking it seeks there and makes it the current row.
  await panel.getByRole('button', { name: /^Play from 0:13\.9/ }).click();
  expect(await currentTime()).toBeCloseTo(13.88, 2);
  await expect(page.locator('.tl-list > li[aria-current="true"]')).toContainText('TypeError');
  // Clicking an event outside the clip does nothing to the video.
  await rows(page).filter({ hasText: 'App launched' }).click();
  expect(await currentTime()).toBeCloseTo(13.88, 2);

  // Keyboard: → steps one 100 ms frame on the frame grid, ⇧← jumps a second back.
  await page.getByRole('group', { name: 'Recording' }).focus();
  await page.keyboard.press('ArrowRight');
  expect(await currentTime()).toBeCloseTo(13.9, 5);
  await page.keyboard.press('Shift+ArrowLeft');
  expect(await currentTime()).toBeCloseTo(12.9, 5);
  // 12.9 s is 1791381300020 on the wall clock: the latest event at or before it is the background event.
  await expect(page.locator('.tl-list > li[aria-current="true"]')).toContainText('Went to the background');
  await page.getByRole('button', { name: 'Previous frame' }).click();
  expect(await currentTime()).toBeCloseTo(12.8, 5);
  await page.getByRole('button', { name: '0.5×' }).click();
  expect(await video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(0.5);
});

test('shows a crash report and marks a crash follow-up', async ({ page }) => {
  await signIn(page);
  await page.goto(`/tickets/${crash.reportId}`);
  await expect(page.getByText('Reported after a crash')).toBeVisible();
  // Open by default for crash follow-ups, and pretty-printed because it parses as JSON.
  const toggle = page.getByRole('button', { name: 'Crash report' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('pre').filter({ hasText: '"exceptionType": 1' })).toBeVisible();
  await toggle.click();
  await expect(page.locator('pre').filter({ hasText: '"exceptionType": 1' })).toHaveCount(0);
});

test('resolves with the build it is fixed in', async ({ page }) => {
  await signIn(page);
  await page.goto(`/tickets/${crash.reportId}`);
  await page.getByLabel('Status').selectOption('resolved');
  await page.getByLabel('Fixed in build (optional)').fill('0.6.1 (18)');
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByLabel('Status')).toHaveValue('resolved');
  await expect(page.getByRole('button', { name: 'Fixed in 0.6.1 (18)' })).toBeVisible();
  await page.goto('/');
  await page.getByRole('tab', { name: /^Resolved/ }).click();
  await expect(page.locator('.ticket-row').filter({ hasText: crash.ticket }).getByText('Fixed in 0.6.1 (18)')).toBeVisible();
});

test('suggests a near-identical report and marks it a duplicate', async ({ page }) => {
  const description = `Checkout button spins forever after applying a coupon ${RUN}`;
  const original = await sendReportWith({ description, screen: `checkout-${RUN}` });
  const repeat = await sendReportWith({ description, screen: `checkout-${RUN}` });
  await signIn(page);
  await page.goto(`/tickets/${repeat.reportId}`);
  const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Similar tickets' }) });
  const match = panel.locator('.similar').filter({ hasText: original.ticket });
  await expect(match).toContainText('100%');
  await expect(match).toContainText('same screen');
  await match.getByRole('button', { name: 'Mark as duplicate of this' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mark as duplicate' }).click();
  await expect(page.getByLabel('Status')).toHaveValue('duplicate');
  await expect(page.getByRole('link', { name: `Duplicate of ${original.ticket}` })).toBeVisible();
  await expect(page.locator('.timeline').getByText(`Marked as a duplicate of ${original.ticket}`)).toBeVisible();
});
