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

/** Just enough of React for useEffect: one component, re-rendered by calling the hook again. */
const hooks = vi.hoisted(() => {
  let previousDeps: readonly unknown[] | undefined;
  return {
    reset() {
      previousDeps = undefined;
    },
    useEffect(effect: () => void, deps?: readonly unknown[]) {
      const prev = previousDeps;
      const changed = !prev || !deps || deps.length !== prev.length || deps.some((d, i) => !Object.is(d, prev[i]));
      previousDeps = deps;
      if (changed) effect();
    },
  };
});

vi.mock('react', () => ({ useEffect: hooks.useEffect }));

async function loadModule() {
  vi.resetModules();
  hooks.reset();
  return import('../src/index');
}

async function loadSnitch() {
  return (await loadModule()).Snitch;
}

function fakeNative(overrides: Partial<Spec> = {}): Spec {
  return {
    start: vi.fn(),
    show: vi.fn(),
    setUser: vi.fn(),
    setMetadata: vi.fn(),
    log: vi.fn(),
    setScreen: vi.fn(),
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
      Snitch.setScreen('Home');
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

  it('forwards the timeline and crash options', async () => {
    nativeModule = fakeNative();
    const Snitch = await loadSnitch();
    Snitch.start({
      serverUrl: 'https://snitch.example.com',
      ingestKey: 'snitch_pk_0123456789ABCDEFGHJKMNPQRS',
      captureConsole: false,
      captureNetwork: true,
      trackScreens: false,
      crashPrompt: false,
      checkInWhenInactive: true,
    });
    expect(nativeModule.start).toHaveBeenCalledWith('https://snitch.example.com', 'snitch_pk_0123456789ABCDEFGHJKMNPQRS', {
      captureConsole: false,
      captureNetwork: true,
      trackScreens: false,
      crashPrompt: false,
      checkInWhenInactive: true,
    });
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

  it('passes screen names trimmed, and blank ones as null', async () => {
    nativeModule = fakeNative();
    const Snitch = await loadSnitch();
    Snitch.setScreen('Home');
    Snitch.setScreen('  Checkout ');
    Snitch.setScreen('');
    Snitch.setScreen('   ');
    Snitch.setScreen(null);
    Snitch.setScreen(undefined);
    expect(vi.mocked(nativeModule.setScreen).mock.calls).toEqual([['Home'], ['Checkout'], [null], [null], [null], [null]]);
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

describe('useSnitchScreen', () => {
  it('sets the screen on the first render and whenever the name changes', async () => {
    nativeModule = fakeNative();
    const { useSnitchScreen } = await loadModule();
    useSnitchScreen('/');
    useSnitchScreen('/');
    useSnitchScreen('/settings');
    useSnitchScreen('/settings');
    useSnitchScreen('/');
    expect(vi.mocked(nativeModule.setScreen).mock.calls).toEqual([['/'], ['/settings'], ['/']]);
  });

  it('skips names that are not known yet', async () => {
    nativeModule = fakeNative();
    const { useSnitchScreen } = await loadModule();
    useSnitchScreen(undefined);
    useSnitchScreen(null);
    useSnitchScreen(' ');
    useSnitchScreen('Home');
    expect(vi.mocked(nativeModule.setScreen).mock.calls).toEqual([['Home']]);
  });

  it('is a no-op with one warning without the native module', async () => {
    const { useSnitchScreen } = await loadModule();
    expect(() => {
      useSnitchScreen('/');
      useSnitchScreen('/next');
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('trackNavigationContainer', () => {
  /** A React Navigation container ref: 'state' listeners, the focused route, readiness. */
  function fakeContainer(route?: string, ready = true) {
    const listeners = new Set<() => void>();
    const state = { route, ready };
    const container = {
      addListener: vi.fn((_event: 'state', listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
      getCurrentRoute: vi.fn(() => (state.route ? { name: state.route, key: `${state.route}-1` } : undefined)),
      isReady: vi.fn(() => state.ready),
    };
    const navigate = (name: string) => {
      state.route = name;
      state.ready = true;
      for (const listener of listeners) listener();
    };
    return { container, navigate, listeners };
  }

  it('records the focused route now and after every state change, once per change', async () => {
    nativeModule = fakeNative();
    const { trackNavigationContainer } = await loadModule();
    const { container, navigate } = fakeContainer('Home');
    trackNavigationContainer(container);
    navigate('Home');
    navigate('Details');
    navigate('Details');
    navigate('Home');
    expect(container.addListener).toHaveBeenCalledWith('state', expect.any(Function));
    expect(vi.mocked(nativeModule.setScreen).mock.calls).toEqual([['Home'], ['Details'], ['Home']]);
  });

  it('waits until the container is ready before asking for the route', async () => {
    nativeModule = fakeNative();
    const { trackNavigationContainer } = await loadModule();
    const { container, navigate } = fakeContainer(undefined, false);
    trackNavigationContainer(container);
    expect(container.getCurrentRoute).not.toHaveBeenCalled();
    navigate('Home');
    expect(vi.mocked(nativeModule.setScreen).mock.calls).toEqual([['Home']]);
  });

  it('stops when the returned function is called', async () => {
    nativeModule = fakeNative();
    const { trackNavigationContainer } = await loadModule();
    const { container, navigate, listeners } = fakeContainer('Home');
    const stop = trackNavigationContainer(container);
    stop();
    navigate('Details');
    expect(listeners.size).toBe(0);
    expect(vi.mocked(nativeModule.setScreen).mock.calls).toEqual([['Home']]);
  });

  it('accepts a ref object whose current is the container', async () => {
    nativeModule = fakeNative();
    const { trackNavigationContainer } = await loadModule();
    const { container, navigate } = fakeContainer('Home');
    trackNavigationContainer({ current: container });
    navigate('Profile');
    expect(vi.mocked(nativeModule.setScreen).mock.calls).toEqual([['Home'], ['Profile']]);
  });

  it('warns and does nothing for a ref that is not attached yet', async () => {
    nativeModule = fakeNative();
    const { trackNavigationContainer } = await loadModule();
    const stop = trackNavigationContainer({ current: null });
    expect(() => stop()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/trackNavigationContainer: no navigation container yet/);
    expect(nativeModule.setScreen).not.toHaveBeenCalled();
  });

  it('never lets a navigation error escape', async () => {
    nativeModule = fakeNative();
    const { trackNavigationContainer } = await loadModule();
    const { container, navigate } = fakeContainer('Home');
    container.getCurrentRoute.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => {
      trackNavigationContainer(container);
      navigate('Details');
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
