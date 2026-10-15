import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { BASE, sendReport, signIn } from './fixtures';

const CLI = join(import.meta.dirname, '..', '..', 'cli', 'dist', 'snitch.js');

test.describe.configure({ mode: 'serial' });

/** The real CLI bundle, as its own process, with its own config dir and no keyring. */
function snitch(args: string[], config: string) {
  const child = spawn('node', [CLI, ...args], { env: { ...process.env, SNITCH_CONFIG_DIR: config, SNITCH_CACHE_DIR: join(config, 'cache'), SNITCH_NO_KEYRING: '1' } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)));
  return { done, out: () => stdout, err: () => stderr };
}

test('makes, shows once and revokes an API token', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'API tokens' }).click();
  await expect(page.getByRole('heading', { name: 'API tokens' })).toBeVisible();
  await page.getByRole('button', { name: 'New token' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('e2e script');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('dialog')).toContainText('can’t show it again');
  const token = (await page.getByRole('dialog').locator('.secret-box').textContent())!.trim();
  expect(token).toMatch(/^snitch_at_/);
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();

  const api = (t: string) => page.request.get(`${BASE}/api/admin/token`, { headers: { authorization: `Bearer ${t}` } });
  expect((await api(token)).status()).toBe(200);
  const row = page.getByRole('row').filter({ hasText: 'e2e script' });
  await expect(row).toContainText('read');
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(row.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
  expect((await api(token)).status()).toBe(401);
});

test('snitch login is approved in the dashboard, then downloads a report with frames', async ({ page }) => {
  test.setTimeout(60_000);
  const { ticket } = sendReport('The CLI should see this one');
  const config = mkdtempSync(join(tmpdir(), 'snitch-cli-e2e-'));

  const login = snitch(['login', '--server', BASE, '--no-browser'], config);
  await expect.poll(() => /Your code: (\S+)/.exec(login.err())?.[1], { timeout: 10_000 }).toBeTruthy();
  const url = /Approve it at (\S+)/.exec(login.err())![1]!;
  expect(url).toMatch(new RegExp(`^${BASE}/device\\?code=[A-Z]{4}-[A-Z]{4}$`));

  // Opening the link signed out shows the sign-in page, then the approval page at the same address.
  await page.goto(url);
  await page.getByLabel('Email').fill('admin@e2e.test');
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in a device' })).toBeVisible();
  await expect(page.getByText('Only approve this if you just ran')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await page.getByLabel(/I started this sign-in myself/).check();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Approved. Go back to your terminal')).toBeVisible();

  expect(await login.done).toBe(0);
  expect(login.out()).toMatch(/^Signed in to http:\/\/127\.0\.0\.1:8099 as admin@e2e\.test/);

  const list = snitch(['tickets'], config);
  expect(await list.done).toBe(0);
  expect(list.out()).toContain(ticket);

  const dl = snitch(['ticket', ticket, '--download'], config);
  expect(await dl.done, dl.err()).toBe(0);
  const dir = join(config, 'cache', '127.0.0.1_8099', ticket);
  expect(dl.out()).toContain(`${ticket} saved to ${dir}`);
  expect(existsSync(join(dir, 'screenshot.jpg'))).toBe(true);
  expect(existsSync(join(dir, 'frames', '00.jpg'))).toBe(true);
  expect(readFileSync(join(dir, 'report.md'), 'utf8')).toContain('The CLI should see this one');

  // The token it made shows on the tokens page, marked as coming from snitch login.
  await page.goto('/tokens');
  await expect(page.getByRole('row').filter({ hasText: 'from snitch login' }).first()).toBeVisible();
});

test('a typed code works too, and a wrong one says so', async ({ page }) => {
  await signIn(page);
  await page.goto('/device');
  await page.getByLabel('Code shown in your terminal').fill('BCDF-GHJK');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('This code has expired or was already used')).toBeVisible();

  const started = await page.request.post(`${BASE}/api/admin/auth/device`, { data: { clientName: 'typed-code test', scopes: ['tickets:read'] } });
  const { userCode, deviceCode } = (await started.json()) as { userCode: string; deviceCode: string };
  await page.getByLabel('Code shown in your terminal').fill(userCode.replace('-', '').toLowerCase());
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('typed-code test')).toBeVisible();
  await page.getByRole('button', { name: 'Deny' }).click();
  await expect(page.getByText('Denied. Nothing was signed in.')).toBeVisible();
  const polled = await page.request.post(`${BASE}/api/admin/auth/device/token`, { data: { deviceCode } });
  expect(await polled.json()).toEqual({ status: 'denied' });
});
