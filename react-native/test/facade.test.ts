import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Spec } from '../src/NativeSnitch';

/** What TurboModuleRegistry.get('Snitch') returns in the current test. */
let nativeModule: Spec | null = null;
const registryGet = vi.fn((_name: string) => nativeModule);

vi.mock('react-native', () => ({
  TurboModuleRegistry: {
    get: (name: string) => registryGet(name),
    getEnforcing: () => {
      throw new Error('react-native-snitch must not use getEnforcing');
    },
  },
}));

async function loadSnitch() {
  vi.resetModules();
  return (await import('../src/index')).Snitch;
}

function fakeNative(overrides: Partial<Spec> = {}): Spec {
  return {
    start: vi.fn(),
    show: vi.fn(),
    setUser: vi.fn(),
    setMetadata: vi.fn(),
    log: vi.fn(),
    setEnabled: vi.fn(),
    isEnabled: vi.fn(() => true),
    getReleaseType: vi.fn(() => 'testflight'),
    getConstants: vi.fn(() => ({})),
    ...overrides,
  } as unknown as Spec;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  registryGet.mockClear();
});

afterEach(() => {
  nativeModule = null;
});

describe('without the native module (Expo Go, old architecture, not rebuilt)', () => {
  it('looks the module up with TurboModuleRegistry.get("Snitch")', async () => {
    await loadSnitch();
    expect(registryGet).toHaveBeenCalledWith('Snitch');
  });

  it('turns every call into a no-op with safe return values', async () => {
    const Snitch = await loadSnitch();
    expect(() => {
      Snitch.start({ serverUrl: 'https://snitch.example.com', ingestKey: 'snitch_pk_0123456789ABCDEFGHJKMNPQRS' });
      Snitch.show();
      Snitch.show('bug');
      Snitch.setUser({ id: '42', email: 'a@b.c' });
      Snitch.setUser(null);
      Snitch.setMetadata('build', '7');
      Snitch.log('hello');
      Snitch.setEnabled(false);
    }).not.toThrow();
    expect(Snitch.isEnabled()).toBe(false);
    expect(Snitch.releaseType()).toBe('unknown');
  });

  it('warns exactly once', async () => {
    const Snitch = await loadSnitch();
    Snitch.show();
    Snitch.log('a');
    Snitch.isEnabled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/native module "Snitch" is not available/);
  });

  it('stays silent when nothing is called', async () => {
    await loadSnitch();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('with the native module', () => {
  it('forwards start with only the options that were set', async () => {
    nativeModule = fakeNative();
    const Snitch = await loadSnitch();
    Snitch.start({
      serverUrl: 'https://snitch.example.com',
      ingestKey: 'snitch_pk_0123456789ABCDEFGHJKMNPQRS',
      gesture: 'shake',
      enabledReleaseTypes: ['debug', 'testflight'],
      videoMaxSeconds: undefined,
    });
    expect(nativeModule.start).toHaveBeenCalledWith('https://snitch.example.com', 'snitch_pk_0123456789ABCDEFGHJKMNPQRS', {
      gesture: 'shake',
      enabledReleaseTypes: ['debug', 'testflight'],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores start without serverUrl / ingestKey', async () => {
    nativeModule = fakeNative();
    const Snitch = await loadSnitch();
    Snitch.start({} as never);
    expect(nativeModule.start).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('maps the rest of the API onto the spec', async () => {
    nativeModule = fakeNative();
    const Snitch = await loadSnitch();
    Snitch.show();
    Snitch.show('idea');
    Snitch.setUser({ id: 'u1', name: 'Ada' });
    Snitch.setUser(null);
    Snitch.setMetadata('plan', 'pro');
    Snitch.setMetadata('plan', undefined);
    Snitch.setMetadata('count', 3);
    Snitch.log('boot');
    Snitch.log('oops', 'error');
    Snitch.setEnabled(false);

    expect(nativeModule.show).toHaveBeenNthCalledWith(1, null);
    expect(nativeModule.show).toHaveBeenNthCalledWith(2, 'idea');
    expect(nativeModule.setUser).toHaveBeenNthCalledWith(1, 'u1', null, 'Ada');
    expect(nativeModule.setUser).toHaveBeenNthCalledWith(2, null, null, null);
    expect(nativeModule.setMetadata).toHaveBeenNthCalledWith(1, 'plan', 'pro');
    expect(nativeModule.setMetadata).toHaveBeenNthCalledWith(2, 'plan', null);
    expect(nativeModule.setMetadata).toHaveBeenNthCalledWith(3, 'count', '3');
    expect(nativeModule.log).toHaveBeenNthCalledWith(1, 'boot', 'info');
    expect(nativeModule.log).toHaveBeenNthCalledWith(2, 'oops', 'error');
    expect(nativeModule.setEnabled).toHaveBeenCalledWith(false);
    expect(Snitch.isEnabled()).toBe(true);
    expect(Snitch.releaseType()).toBe('testflight');
  });

  it('reports an unrecognised release type as "unknown"', async () => {
    nativeModule = fakeNative({ getReleaseType: vi.fn(() => 'beta') });
    const Snitch = await loadSnitch();
    expect(Snitch.releaseType()).toBe('unknown');
  });

  it('never lets a native failure escape', async () => {
    nativeModule = fakeNative({
      show: vi.fn(() => {
        throw new Error('boom');
      }),
      isEnabled: vi.fn(() => {
        throw new Error('boom');
      }),
    });
    const Snitch = await loadSnitch();
    expect(() => Snitch.show()).not.toThrow();
    expect(Snitch.isEnabled()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
