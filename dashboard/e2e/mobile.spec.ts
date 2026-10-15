import { expect, test, type Page } from '@playwright/test';
import { sendReport, signIn } from './fixtures';

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const RUN = Math.random().toString(36).slice(2, 7);
const A = `Mobile check one ${RUN}`;
const B = `Mobile check two ${RUN}`;
let first: { reportId: string; ticket: string };

test.beforeAll(() => {
  first = sendReport(A);
  sendReport(B, { media: false });
});

/** Nothing on the page may be wider than the phone: neither the document nor the scrolling main pane. */
async function fitsTheScreen(page: Page, where: string) {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector('.main');
    return {
      doc: document.documentElement.scrollWidth - window.innerWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
    };
  });
  expect(overflow, `${where} is wider than the screen`).toEqual({ doc: 0, main: 0 });
}

test('a phone gets a top bar and a drawer instead of the sidebar', async ({ page }) => {
  await page.goto('/');
  await fitsTheScreen(page, 'sign-in');
  await page.getByLabel('Email').fill('admin@e2e.test');
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();

  const menu = page.getByRole('button', { name: 'Menu' });
  await expect(menu).toBeVisible();
  const sidebar = page.locator('aside.sidebar');
  await expect(sidebar).not.toBeInViewport();
  await fitsTheScreen(page, 'inbox');

  await menu.click();
  await expect(sidebar).toBeInViewport();
  await sidebar.getByRole('link', { name: 'Team' }).click();
  await expect(page).toHaveURL(/\/team$/);
  await expect(sidebar).not.toBeInViewport();
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
  await fitsTheScreen(page, 'team');

  await menu.click();
  await page.locator('.nav-backdrop').click({ position: { x: 370, y: 400 } });
  await expect(sidebar).not.toBeInViewport();
});

test('selects tickets with a tap and changes them together', async ({ page }) => {
  await signIn(page);
  await page.getByPlaceholder(/Search title/).fill(RUN);
  await expect(page.locator('.ticket-row')).toHaveCount(2);
  await fitsTheScreen(page, 'inbox with results');

  await page.getByRole('checkbox', { name: `Select ${first.ticket}` }).tap();
  await expect(page.locator('.bulk-bar')).toContainText('1 selected');
  await page.getByRole('checkbox', { name: 'Select all' }).tap();
  await expect(page.locator('.bulk-bar')).toContainText('2 selected');
  await fitsTheScreen(page, 'inbox with a selection');

  await page.getByLabel('Set status of selected').selectOption('triaged');
  await expect(page.getByRole('status')).toContainText('Updated 2 tickets');
  await expect(page.locator('.bulk-bar')).toContainText('Select');
  await page.getByRole('tab', { name: /Triaged/ }).tap();
  await expect(page.locator('.ticket-row')).toHaveCount(2);
});

test('ticket, settings, devices and jobs pages fit a phone', async ({ page }) => {
  await signIn(page);
  await page.goto(`/tickets/${first.reportId}`);
  await expect(page.getByLabel('Title')).toHaveValue(A);
  await fitsTheScreen(page, 'ticket');

  const projectId = await page.evaluate(async () => {
    const res = await fetch('/api/admin/projects', { credentials: 'same-origin' });
    return ((await res.json()) as { id: string }[])[0]!.id;
  });
  for (const path of [`/projects/${projectId}/settings`, `/projects/${projectId}/settings/integrations`, `/projects/${projectId}/devices`, '/jobs']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await fitsTheScreen(page, path);
  }
});
