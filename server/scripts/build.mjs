/**
 * Bundles the server and the CLI into single ESM files under dist/. Only
 * better-sqlite3 (a native addon) stays external; everything else, including
 * the workspace contract package, is inlined.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  external: ['better-sqlite3'],
  define: { __SNITCH_VERSION__: JSON.stringify(pkg.version) },
  // CJS dependencies bundled into ESM still call require().
  banner: { js: "import { createRequire as __snitchCreateRequire } from 'node:module'; const require = __snitchCreateRequire(import.meta.url);" },
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' });
await build({
  ...common,
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  banner: { js: '#!/usr/bin/env node\n' + common.banner.js },
});
