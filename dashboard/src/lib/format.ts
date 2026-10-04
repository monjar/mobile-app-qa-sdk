import type { ReleaseType, TicketStatus } from '@snitch/contract';

export const STATUS_LABEL: Record<TicketStatus, string> = {
  new: 'New',
  triaged: 'Triaged',
  in_progress: 'In progress',
  resolved: 'Resolved',
  wont_fix: "Won't fix",
  duplicate: 'Duplicate',
};

export const RELEASE_LABEL: Record<ReleaseType, string> = {
  debug: 'Debug',
  adhoc: 'Ad hoc',
  enterprise: 'Enterprise',
  testflight: 'TestFlight',
  appstore: 'App Store',
  internal: 'Internal',
  play: 'Store',
  unknown: 'Unknown',
};

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function relativeTime(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return 'just now';
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  if (abs < 7 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), 'day');
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: abs > 300 * 86_400_000 ? 'numeric' : undefined });
}

export function dateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function initials(nameOrEmail: string): string {
  const base = nameOrEmail.split('@')[0] ?? nameOrEmail;
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function osName(platform: 'ios' | 'android'): string {
  return platform === 'ios' ? 'iOS' : 'Android';
}
