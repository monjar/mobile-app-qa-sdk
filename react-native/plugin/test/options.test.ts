import { describe, expect, it } from 'vitest';

import { assertOptionsShape, normalizeServerUrl, optionWarnings, SnitchConfigError, validateOptions } from '../src/options';
import { INGEST_KEY, SERVER_URL } from './fixtures';

const NO_ENV = {};
const base = { serverUrl: SERVER_URL, ingestKey: INGEST_KEY };

/** The problems a SnitchConfigError carries, or [] when the input is valid. */
function problemsOf(input: unknown, env: Record<string, string | undefined> = NO_ENV): string[] {
  try {
    validateOptions(input, env);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(SnitchConfigError);
    return [...(error as SnitchConfigError).problems];
  }
}

describe('validateOptions', () => {
  it('accepts the minimal options and leaves every unset key out', () => {
    expect(validateOptions(base, NO_ENV)).toEqual({
      serverUrl: SERVER_URL,
      ingestKey: INGEST_KEY,
      android: { detectScreenshots: false },
    });
  });

  it('accepts every option', () => {
    const options = validateOptions(
      {
        ...base,
        enabled: false,
        enabledReleaseTypes: ['debug', 'testflight', 'debug'],
        gesture: 'both',
        screenshotPrompt: false,
        maskTextInputs: false,
        captureMode: 'system',
        videoMaxSeconds: 12,
        showTesterNotice: false,
        android: { releaseType: 'internal', detectScreenshots: true },
      },
      NO_ENV,
    );
    expect(options).toEqual({
      serverUrl: SERVER_URL,
      ingestKey: INGEST_KEY,
      enabled: false,
      enabledReleaseTypes: ['debug', 'testflight'],
      gesture: 'both',
      screenshotPrompt: false,
      maskTextInputs: false,
      captureMode: 'system',
      videoMaxSeconds: 12,
      showTesterNotice: false,
      android: { releaseType: 'internal', detectScreenshots: true },
    });
  });

  it('treats a missing options object like an empty one', () => {
    expect(problemsOf(undefined)).toEqual([
      'serverUrl is required: set it in the plugin options or the SNITCH_SERVER_URL environment variable.',
      'ingestKey is required: set it in the plugin options or the SNITCH_INGEST_KEY environment variable.',
    ]);
  });

  it('rejects a non-object', () => {
    expect(problemsOf('https://snitch.example.com')[0]).toMatch(/options must be an object/);
    expect(problemsOf([base])[0]).toMatch(/options must be an object/);
  });

  describe('serverUrl', () => {
    it.each([
      ['not a url', /absolute http\(s\) URL/],
      ['snitch.example.com', /absolute http\(s\) URL/],
      ['ftp://snitch.example.com', /must use http or https/],
      ['https://user:secret@snitch.example.com', /must not contain credentials/],
      ['https://snitch.example.com/?project=1', /without a query or fragment/],
      ['https://snitch.example.com/#x', /without a query or fragment/],
    ])('rejects %s', (serverUrl, message) => {
      const problems = problemsOf({ ...base, serverUrl });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(message);
    });

    it('does not echo credentials', () => {
      expect(problemsOf({ ...base, serverUrl: 'https://user:secret@snitch.example.com' })[0]).not.toContain('secret');
    });

    it('rejects a non-string', () => {
      expect(problemsOf({ ...base, serverUrl: 42 })).toEqual(['serverUrl must be a string (got 42).']);
    });

    it.each([
      ['https://snitch.example.com/', 'https://snitch.example.com'],
      ['  https://snitch.example.com  ', 'https://snitch.example.com'],
      ['https://example.com/snitch//', 'https://example.com/snitch'],
      ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
      ['HTTPS://Snitch.Example.com:8443/qa', 'https://snitch.example.com:8443/qa'],
    ])('normalises %s', (input, expected) => {
      expect(normalizeServerUrl(input)).toEqual({ url: expected });
      expect(validateOptions({ ...base, serverUrl: input }, NO_ENV).serverUrl).toBe(expected);
    });
  });

  describe('ingestKey', () => {
    it.each([
      'snitch_pk_0123456789abcdefghjkmnpqrs', // lowercase
      'snitch_pk_0123456789ABCDEFGHJKMNPQR', // 25 characters
      'snitch_pk_0123456789ABCDEFGHJKMNPQRST', // 27 characters
      'snitch_pk_0123456789ABCDEFGHIKMNPQRS', // I is not Crockford base32
      'snitch_pk_0123456789ABCDEFGHJKLNPQRS', // L
      'snitch_pk_0123456789ABCDEFGHJKMNOQRS', // O
      'snitch_pk_0123456789ABCDEFGHJKMNPQRU', // U
      'snitch_sk_0123456789ABCDEFGHJKMNPQRS',
      ' snitch_pk_0123456789ABCDEFGHJKMNPQRS',
    ])('rejects %j', (ingestKey) => {
      const problems = problemsOf({ ...base, ingestKey });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^ingestKey must be "snitch_pk_" followed by 26 Crockford base32 characters/);
    });

    it('rejects a non-string', () => {
      expect(problemsOf({ ...base, ingestKey: null })).toEqual(['ingestKey must be a string (got null).']);
    });
  });

  describe('enabledReleaseTypes', () => {
    it('rejects unknown release types and names the allowed ones', () => {
      expect(problemsOf({ ...base, enabledReleaseTypes: ['debug', 'beta', 'TestFlight'] })).toEqual([
        'enabledReleaseTypes contains "beta", "TestFlight"; allowed: "debug", "adhoc", "enterprise", "testflight", "appstore", "internal", "play".',
      ]);
    });

    it('rejects "unknown" with an explanation', () => {
      expect(problemsOf({ ...base, enabledReleaseTypes: ['unknown'] })[0]).toMatch(/"unknown" is never enabled/);
    });

    it('rejects an empty list and a non-array', () => {
      expect(problemsOf({ ...base, enabledReleaseTypes: [] })[0]).toMatch(/must not be empty; use "enabled": false/);
      expect(problemsOf({ ...base, enabledReleaseTypes: 'debug' })[0]).toMatch(/must be an array/);
    });
  });

  it('rejects an unknown gesture and capture mode', () => {
    expect(problemsOf({ ...base, gesture: 'threeFingerTap', captureMode: 'replaykit' })).toEqual([
      'gesture must be one of "threeFingerHold", "shake", "both", "none" (got "threeFingerTap").',
      'captureMode must be one of "snapshot", "system", "off" (got "replaykit").',
    ]);
  });

  describe('videoMaxSeconds', () => {
    it.each([1, 15, 30])('accepts %d', (videoMaxSeconds) => {
      expect(validateOptions({ ...base, videoMaxSeconds }, NO_ENV).videoMaxSeconds).toBe(videoMaxSeconds);
    });

    it.each([0, 31, -5, 2.5, '10', Number.NaN])('rejects %j', (videoMaxSeconds) => {
      const problems = problemsOf({ ...base, videoMaxSeconds });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^videoMaxSeconds must be a whole number from 1 to 30/);
    });
  });

  it('requires real booleans', () => {
    expect(problemsOf({ ...base, enabled: 'false', maskTextInputs: 1 })).toEqual([
      'enabled must be true or false (got "false").',
      'maskTextInputs must be true or false (got 1).',
    ]);
  });

  it('rejects unknown keys and suggests the right spelling', () => {
    expect(problemsOf({ ...base, ServerURL: SERVER_URL })[0]).toBe('unknown option "ServerURL". Did you mean "serverUrl"?');
    expect(problemsOf({ ...base, debug: true })[0]).toMatch(/^unknown option "debug"\. Known options: serverUrl, ingestKey/);
  });

  describe('android', () => {
    it('validates its keys', () => {
      expect(problemsOf({ ...base, android: { releaseType: 'beta', detectScreenshot: true } })).toEqual([
        'unknown option "android.detectScreenshot". Did you mean "detectScreenshots"?',
        'android.releaseType must be one of "debug", "adhoc", "enterprise", "testflight", "appstore", "internal", "play", "unknown" (got "beta").',
      ]);
    });

    it('must be an object', () => {
      expect(problemsOf({ ...base, android: true })[0]).toMatch(/^android must be an object/);
    });
  });

  it('reports every problem at once in the error message', () => {
    expect(() => validateOptions({ serverUrl: 'nope', ingestKey: 'nope', videoMaxSeconds: 99 }, NO_ENV)).toThrowError(
      /\[react-native-snitch\] Invalid config plugin options:\n {2}- serverUrl must be an absolute.*\n {2}- ingestKey must be.*\n {2}- videoMaxSeconds must be/,
    );
  });
});

describe('environment fallback', () => {
  const env = { SNITCH_SERVER_URL: 'https://env.example.com/', SNITCH_INGEST_KEY: INGEST_KEY };

  it('uses SNITCH_SERVER_URL and SNITCH_INGEST_KEY when the options leave them out', () => {
    expect(validateOptions({}, env)).toMatchObject({ serverUrl: 'https://env.example.com', ingestKey: INGEST_KEY });
    expect(validateOptions(undefined, env)).toMatchObject({ serverUrl: 'https://env.example.com', ingestKey: INGEST_KEY });
  });

  it('treats empty strings as unset, in the options and in the environment', () => {
    expect(validateOptions({ serverUrl: '', ingestKey: ' ' }, env)).toMatchObject({ serverUrl: 'https://env.example.com' });
    expect(problemsOf({}, { SNITCH_SERVER_URL: '', SNITCH_INGEST_KEY: '' })).toHaveLength(2);
  });

  it('prefers the options over the environment', () => {
    expect(validateOptions(base, env)).toMatchObject({ serverUrl: SERVER_URL, ingestKey: INGEST_KEY });
  });

  it('validates environment values and says where they came from', () => {
    expect(problemsOf({}, { SNITCH_SERVER_URL: 'nope', SNITCH_INGEST_KEY: 'snitch_pk_short' })).toEqual([
      expect.stringMatching(/^serverUrl must be an absolute http\(s\) URL.*\(from SNITCH_SERVER_URL\)$/),
      expect.stringMatching(/^ingestKey must be .*got "snitch_pk_short" from SNITCH_INGEST_KEY\)\.$/),
    ]);
  });

  it('reads process.env by default', () => {
    const saved = { url: process.env.SNITCH_SERVER_URL, key: process.env.SNITCH_INGEST_KEY };
    try {
      process.env.SNITCH_SERVER_URL = 'https://process.example.com';
      process.env.SNITCH_INGEST_KEY = INGEST_KEY;
      expect(validateOptions({}).serverUrl).toBe('https://process.example.com');
    } finally {
      if (saved.url === undefined) delete process.env.SNITCH_SERVER_URL;
      else process.env.SNITCH_SERVER_URL = saved.url;
      if (saved.key === undefined) delete process.env.SNITCH_INGEST_KEY;
      else process.env.SNITCH_INGEST_KEY = saved.key;
    }
  });
});

describe('assertOptionsShape', () => {
  it('allows serverUrl and ingestKey to be missing (they may come from the environment at prebuild)', () => {
    expect(() => assertOptionsShape(undefined)).not.toThrow();
    expect(() => assertOptionsShape({ gesture: 'shake' })).not.toThrow();
  });

  it('still rejects malformed values', () => {
    expect(() => assertOptionsShape({ serverUrl: 'nope' })).toThrow(SnitchConfigError);
    expect(() => assertOptionsShape({ ingestKey: 'nope' })).toThrow(SnitchConfigError);
    expect(() => assertOptionsShape({ gesture: 'tap' })).toThrow(SnitchConfigError);
  });
});

describe('optionWarnings', () => {
  const warn = (serverUrl: string) => optionWarnings(validateOptions({ serverUrl, ingestKey: INGEST_KEY }, {}));

  it('warns about cleartext http to a public host on both platforms', () => {
    const { ios, android } = warn('http://snitch.example.com');
    expect(ios).toEqual([expect.stringMatching(/App Transport Security/)]);
    expect(android).toEqual([expect.stringMatching(/cleartext/)]);
  });

  it.each(['https://snitch.example.com', 'http://127.0.0.1:8080', 'http://localhost:8080', 'http://192.168.1.20', 'http://mac.local'])(
    'stays quiet for %s',
    (url) => {
      expect(warn(url)).toEqual({ ios: [], android: [] });
    },
  );
});
