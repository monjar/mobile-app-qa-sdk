import { expect, test } from '@playwright/test';
import { signIn } from './fixtures';

test.describe.configure({ mode: 'serial' });

// The e2e server has no SMTP: invites come back to the admin as a link to pass on.
test('invites someone, who sets a password from the link and lands signed in', async ({ page, browser }) => {
  const run = Math.random().toString(36).slice(2, 7);
  const email = `invitee-${run}@e2e.test`;
  const name = `Ina ${run}`;
  await signIn(page);
  await page.goto('/team');
  await page.getByRole('button', { name: 'Add person' }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Name', { exact: true }).fill(name);
  await expect(page.getByLabel(/Email them an invite/)).toBeChecked();
  await page.getByRole('button', { name: 'Send invite' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('no SMTP configured');
  const link = (await dialog.locator('.secret-box').textContent())!.trim();
  expect(link).toMatch(/\/set-password\?token=/);
  await dialog.getByRole('button', { name: 'Done' }).click();
  const row = page.getByRole('row').filter({ hasText: email });
  await expect(row.locator('.pill', { hasText: 'Invited' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Resend invite' })).toBeVisible();

  const invitee = await browser.newPage();
  await invitee.goto(link);
  await expect(invitee.getByText('Welcome to Snitch')).toBeVisible();
  await expect(invitee.getByText(email)).toBeVisible();
  await invitee.getByLabel(/^Password/).fill('invitee password 1');
  await invitee.getByLabel('Confirm password').fill('invitee password 1');
  await invitee.getByRole('button', { name: 'Set password and sign in' }).click();
  await expect(invitee.getByRole('heading', { name: /All projects|Mochiro/ })).toBeVisible();

  // Used once.
  const again = await browser.newPage();
  await again.goto(link);
  await expect(again.getByText('This link has expired or was already used')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('row').filter({ hasText: email }).locator('.pill', { hasText: 'Invited' })).toHaveCount(0);
});

test('without SMTP, the sign-in page sends people to an admin', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Forgot your password? Ask an admin to send you a reset link.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Forgot password?' })).toHaveCount(0);
});
