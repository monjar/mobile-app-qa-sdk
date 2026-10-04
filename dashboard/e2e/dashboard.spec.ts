import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { sendReport, signIn } from './fixtures';

test.describe.configure({ mode: 'serial' });

let first: { reportId: string; ticket: string };

test.beforeAll(() => {
  first = sendReport('Face froze after petting\nSecond line of detail');
  sendReport('Snooze reminders from the list', { type: 'idea', media: false });
});

test('signs in and shows the inbox', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText('Face froze after petting')).toBeVisible();
  await expect(page.getByText('Snooze reminders from the list')).toBeVisible();
  // Filters narrow the list.
  await page.getByLabel('Type', { exact: true }).selectOption('idea');
  await expect(page.getByText('Face froze after petting')).toHaveCount(0);
  await page.getByLabel('Type', { exact: true }).selectOption('');
  await page.getByPlaceholder(/Search title/).fill(first.ticket);
  await expect(page.locator('.ticket-row')).toHaveCount(1);
});

test('opens a ticket with media served over ranges, triages and comments', async ({ page }) => {
  await signIn(page);
  const ranged: number[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/content') && r.request().headers()['range']) ranged.push(r.status());
  });
  await page.goto(`/tickets/${first.reportId}`);
  await expect(page.getByLabel('Title')).toHaveValue('Face froze after petting');
  const img = page.getByAltText('Screenshot');
  await expect(img).toBeVisible();
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  // The video element exists; this Chromium build can't decode H.264, but it still asks for byte ranges.
  await expect(page.locator('video')).toHaveCount(1);
  const head = await page.request.get(await page.locator('video').getAttribute('src').then((s) => s!), { headers: { range: 'bytes=0-1' } });
  expect(head.status()).toBe(206);

  await page.getByLabel('Status').selectOption('triaged');
  await expect(page.locator('.pill.triaged').first()).toBeVisible();
  await page.getByPlaceholder('Add an internal note…').fill('Reproduced on an iPhone 15');
  await page.getByRole('button', { name: 'Comment' }).click();
  await expect(page.getByText('Reproduced on an iPhone 15')).toBeVisible();
  await expect(page.getByText(/Status New → Triaged/)).toBeVisible();
});

test('connects a webhook, escalates, and the receiver gets the ticket', async ({ page }) => {
  const received: unknown[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(8199, '127.0.0.1', r));
  try {
    await signIn(page);
    await page.goto('/');
    await page.getByRole('link', { name: 'Mochiro settings' }).click();
    await page.getByRole('button', { name: 'Integrations' }).click();
    await page.getByRole('button', { name: 'Webhook' }).click();
    await page.getByLabel('Format').selectOption('generic');
    await page.getByLabel('URL').fill('http://127.0.0.1:8199/hook');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('generic · 127.0.0.1:8199')).toBeVisible();

    await page.goto(`/tickets/${first.reportId}`);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.integration-row .pill.sent')).toBeVisible({ timeout: 15_000 });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ event: 'ticket.escalated', ticket: { key: first.ticket } });
  } finally {
    server.close();
  }
});

test('share links open publicly until revoked', async ({ page }) => {
  await signIn(page);
  await page.goto(`/tickets/${first.reportId}`);
  await page.getByRole('button', { name: 'New link' }).first().click();
  const url = (await page.locator('.secret-box').textContent())!;
  await page.getByRole('button', { name: 'Done' }).click();
  const anon = await page.request.get(url, { headers: { cookie: '' } });
  expect(anon.status()).toBe(200);
  await page.getByRole('button', { name: 'Revoke' }).first().click();
  await expect(page.getByText('Link revoked')).toBeVisible();
  expect((await page.request.get(url)).status()).toBe(404);
});

test('creates a project and shows its key once', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('App name').fill('Space Game');
  await expect(page.getByLabel('Ticket prefix')).toHaveValue('SPAC');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('.secret-box')).toHaveText(/^snitch_pk_[0-9A-Z]{26}$/);
  await page.getByRole('button', { name: 'Show install steps' }).click();
  await expect(page.getByText('Add Snitch to your app')).toBeVisible();
  await expect(page.getByText('npx expo install react-native-snitch')).toBeVisible();
});

// Real Chrome (CI sets PW_CHANNEL=chrome) can decode H.264, so prove the clip actually plays.
test('plays the recorded clip', async ({ page }) => {
  test.skip(process.env.PW_CHANNEL !== 'chrome', 'needs a browser with H.264');
  await signIn(page);
  await page.goto(`/tickets/${first.reportId}`);
  const duration = await page.locator('video').evaluate(
    (v: HTMLVideoElement) =>
      new Promise<number>((resolve, reject) => {
        if (v.readyState >= 1) return resolve(v.duration);
        v.addEventListener('loadedmetadata', () => resolve(v.duration));
        v.addEventListener('error', () => reject(new Error(`video error ${v.error?.code}`)));
      }),
  );
  expect(duration).toBeGreaterThan(2.5);
  expect(duration).toBeLessThan(3.5);
});
