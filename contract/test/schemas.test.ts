import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  DEFAULT_SDK_CONFIG,
  ReportCreate,
  ReportCreated,
  SdkConfig,
  isRetryable,
  mergeSdkConfig,
} from '../src';

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8'));

describe('fixtures match the schemas', () => {
  it('iOS report', () => expect(ReportCreate.safeParse(fixture('report.create.ios.json')).success).toBe(true));
  it('Android report', () => expect(ReportCreate.safeParse(fixture('report.create.android.json')).success).toBe(true));
  it('created response', () => expect(ReportCreated.safeParse(fixture('report.created.json')).success).toBe(true));
  it('error envelope', () => expect(ApiError.safeParse(fixture('error.json')).success).toBe(true));
  it('sdk config fixture is the default config', () => {
    expect(SdkConfig.parse(fixture('sdk-config.json'))).toEqual(DEFAULT_SDK_CONFIG);
  });
});

describe('ReportCreate rules', () => {
  const base = fixture('report.create.ios.json') as Record<string, unknown> & { attachments: Record<string, unknown>[] };

  it('rejects duplicate attachment names', () => {
    const r = { ...base, attachments: [base.attachments[0], base.attachments[0]] };
    expect(ReportCreate.safeParse(r).success).toBe(false);
  });

  it('rejects an attachment above its content-type cap', () => {
    const big = { ...base.attachments[0], sizeBytes: 9 * 1024 * 1024 };
    expect(ReportCreate.safeParse({ ...base, attachments: [big] }).success).toBe(false);
  });

  it('rejects unknown content types', () => {
    const exe = { ...base.attachments[0], contentType: 'application/octet-stream' };
    expect(ReportCreate.safeParse({ ...base, attachments: [exe] }).success).toBe(false);
  });

  it('rejects unknown stats keys', () => {
    expect(ReportCreate.safeParse({ ...base, stats: { nope: 1 } }).success).toBe(false);
  });

  it('rejects more than 50 custom keys', () => {
    const custom = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v']));
    expect(ReportCreate.safeParse({ ...base, custom }).success).toBe(false);
  });

  it('accepts a report with no attachments and an empty description', () => {
    expect(ReportCreate.safeParse({ ...base, description: '', attachments: [] }).success).toBe(true);
  });
});

describe('mergeSdkConfig', () => {
  it('merges nested video settings key by key, later overrides winning', () => {
    const out = mergeSdkConfig(DEFAULT_SDK_CONFIG, { video: { idleFps: 2 } }, { video: { captureMode: 'off' }, enabled: false });
    expect(out.video).toEqual({ ...DEFAULT_SDK_CONFIG.video, idleFps: 2, captureMode: 'off' });
    expect(out.enabled).toBe(false);
    expect(DEFAULT_SDK_CONFIG.video.idleFps).toBe(1);
  });

  it('ignores explicitly undefined keys', () => {
    const out = mergeSdkConfig(DEFAULT_SDK_CONFIG, { enabled: undefined, video: { maxSeconds: undefined } });
    expect(out).toEqual(DEFAULT_SDK_CONFIG);
  });
});

describe('isRetryable', () => {
  it.each([
    [0, undefined, true],
    [429, 'rate_limited', true],
    [503, undefined, true],
    [409, 'attachments_missing', true],
    [401, 'unauthorized', false],
    [403, 'release_type_not_allowed', false],
    [413, 'payload_too_large', false],
    [422, 'invalid_request', false],
  ] as const)('%i %s → %s', (status, code, expected) => {
    expect(isRetryable(status, code)).toBe(expected);
  });
});
