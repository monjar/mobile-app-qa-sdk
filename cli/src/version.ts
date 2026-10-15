declare const __SNITCH_CLI_VERSION__: string | undefined;

/** Set by scripts/build.mjs; "dev" when run from source (tests, tsx). */
export const VERSION: string = typeof __SNITCH_CLI_VERSION__ === 'string' ? __SNITCH_CLI_VERSION__ : 'dev';
