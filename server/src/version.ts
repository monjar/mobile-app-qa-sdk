declare const __SNITCH_VERSION__: string | undefined;

/** Injected by the esbuild bundle; falls back for tsx/vitest runs. */
export const VERSION: string = typeof __SNITCH_VERSION__ === 'string' ? __SNITCH_VERSION__ : '0.0.0-dev';
