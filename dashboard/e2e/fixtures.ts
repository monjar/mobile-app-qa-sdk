import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

export const INGEST_KEY = 'snitch_pk_E2E00000000000000000000000';
export const BASE = 'http://127.0.0.1:8099';
const root = join(import.meta.dirname, '..', '..');

export function sendReport(description: string, opts: { type?: string; media?: boolean } = {}): { reportId: string; ticket: string } {
  const out = execFileSync(
    'node',
    [join(root, 'scripts/fake-sdk.mjs'), '--server', BASE, '--key', INGEST_KEY, '--description', description, '--type', opts.type ?? 'bug', ...(opts.media === false ? [] : ['--generate-media', '3'])],
    { encoding: 'utf8' },
  );
  return JSON.parse(out.trim().split('\n').pop()!);
}

export async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill('admin@e2e.test');
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: /Inbox/ })).toBeVisible();
}
