import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { checkIn, signIn } from './fixtures';

test.describe.configure({ mode: 'serial' });

const RUN = Math.random().toString(36).slice(2, 7);

test('lists installs that checked in, with their signals', async ({ page }) => {
  // What SDK 0.3 sends with every config fetch (docs/sdk-spec.md §11.1).
  await checkIn({
    platform: 'ios',
    releaseType: 'adhoc',
    appVersion: '0.6.0',
    build: '15',
    os: '26.0.1',
    installId: randomUUID(),
    appId: 'com.mochiro.app',
    sdkVersion: '0.3.0',
    wrapper: 'react-native',
    model: `iPhone16,2-${RUN}`,
    signals: 'sim=0;profile=adhoc;devices=12;receipt=none;at=none',
    active: '1',
  });
  await checkIn({
    platform: 'android',
    releaseType: 'internal',
    appVersion: '0.6.0',
    build: '7',
    os: '15',
    installId: randomUUID(),
    appId: 'com.mochiro.app',
    sdkVersion: '0.3.0',
    model: `Pixel 8-${RUN}`,
    signals: 'debuggable=0;installer=dev.firebase.appdistribution;override=none',
    active: '1',
  });

  await signIn(page);
  await page.getByRole('link', { name: 'Mochiro devices' }).click();
  await expect(page.getByRole('heading', { name: 'Mochiro devices' })).toBeVisible();
  const installs = page.locator('table.devices tbody tr');
  const ios = installs.filter({ hasText: `iPhone16,2-${RUN}` });
  await expect(ios).toContainText('Ad hoc');
  await expect(ios).toContainText('0.6.0 (15)');
  await expect(ios).toContainText('react-native');
  await expect(ios.locator('.chip').filter({ hasText: 'profile=adhoc' })).toBeVisible();
  const builds = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Builds' }) });
  await expect(builds.getByText('0.6.0 (7)')).toBeVisible();

  await page.getByLabel('Platform').selectOption('android');
  await expect(installs.filter({ hasText: `iPhone16,2-${RUN}` })).toHaveCount(0);
  const android = installs.filter({ hasText: `Pixel 8-${RUN}` });
  await android.getByRole('button', { name: 'Copy as test vector' }).click();
  const dialog = page.getByRole('dialog', { name: 'Release-type test vector' });
  const vector = JSON.parse((await dialog.locator('pre').textContent())!);
  expect(vector).toEqual({
    name: `Pixel 8-${RUN} Android 15 build 7`,
    signals: { debuggable: false, installer: 'dev.firebase.appdistribution', override: null },
    expect: 'internal',
  });
  await expect(dialog.getByText('android', { exact: true })).toBeVisible();
});

test('offers Sign in with GitHub only when the server has it', async ({ page }) => {
  await page.goto('/tickets/abc?view=1');
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in with GitHub' })).toHaveCount(0);

  // The e2e server has no OAuth app, so pretend it does: the button links back to where the user was going.
  await page.route('**/api/admin/auth/providers', (r) => r.fulfill({ json: { password: true, github: true } }));
  await page.reload();
  await expect(page.getByRole('link', { name: 'Sign in with GitHub' })).toHaveAttribute('href', '/api/admin/auth/github/start?next=%2Ftickets%2Fabc%3Fview%3D1');

  await page.goto('/login?error=github_org');
  await expect(page.getByRole('alert')).toHaveText(/isn't an active member of the organization/);
  await expect(page.getByRole('link', { name: 'Sign in with GitHub' })).toHaveAttribute('href', '/api/admin/auth/github/start?next=%2F');
});

test('saves notification settings and shows server status', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Mochiro settings' }).click();
  await page.getByRole('button', { name: 'General' }).click();
  // The e2e server has no SMTP.
  await expect(page.getByText(/so these emails only go to the server log/)).toBeVisible();
  const reporters = page.getByRole('checkbox', { name: /Email testers when their ticket is resolved/ });
  await reporters.check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(reporters).toBeChecked();

  await page.getByRole('button', { name: 'Builds & capture' }).click();
  await expect(page.getByRole('checkbox', { name: 'Network requests' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Network requests' }).uncheck();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText(/Saved/);
  const config = await (await page.request.get(`/api/v1/sdk/config?platform=ios&releaseType=debug`, { headers: { 'x-snitch-key': 'snitch_pk_E2E00000000000000000000000' } })).json();
  expect(config.timeline).toEqual({ console: true, network: false, screens: true });
  expect(config.crashPrompt).toBe(true);

  await page.getByRole('link', { name: /Jobs/ }).click();
  const server = page.getByRole('region', { name: 'Server' });
  await expect(server.getByText('Off (set SNITCH_BACKUP_INTERVAL_HOURS)')).toBeVisible();
});

test('connects GitHub with two-way sync and sets up its webhook', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Mochiro settings' }).click();
  await page.getByRole('button', { name: 'Integrations' }).click();
  await page.getByRole('button', { name: 'GitHub', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(`Issues ${RUN}`);
  await page.getByLabel('Owner', { exact: true }).fill('monjar');
  await page.getByLabel('Repository', { exact: true }).fill('mochiro-mobile');
  await page.getByLabel(/^Access token/).fill('github_pat_e2e');
  await page.getByRole('checkbox', { name: /^Status/ }).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('monjar/mochiro-mobile · syncs status')).toBeVisible();

  const hook = page.locator('section').filter({ has: page.getByRole('heading', { name: `Webhook for Issues ${RUN}` }) });
  await expect(hook.locator('.snippet pre')).toHaveText(/^http:\/\/127\.0\.0\.1:8099\//);
  await expect(hook.getByText('Not set up')).toBeVisible();
  await hook.getByRole('button', { name: 'Generate secret' }).click();
  const secret = page.getByRole('dialog', { name: 'Webhook secret' });
  await expect(secret.locator('.secret-box')).not.toBeEmpty();
  await secret.getByRole('button', { name: 'Done' }).click();
  await expect(hook.getByText('Secret set')).toBeVisible();
  // Regenerating asks first, because it breaks the webhook already on GitHub.
  await hook.getByRole('button', { name: 'Regenerate secret' }).click();
  await expect(page.getByRole('dialog', { name: 'Regenerate the webhook secret?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Edit keeps the token and turns comment sync on too.
  await page.getByRole('button', { name: `Edit Issues ${RUN}` }).click();
  await expect(page.getByRole('checkbox', { name: /^Status/ })).toBeChecked();
  await page.getByRole('checkbox', { name: /^Comments/ }).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('monjar/mochiro-mobile · syncs status and comments')).toBeVisible();
});
