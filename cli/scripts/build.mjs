/**
 * Bundles the CLI into one ESM file, dist/snitch.js, with the workspace
 * contract, zod and the MCP SDK inlined so the published package has no
 * runtime dependencies. @napi-rs/keyring stays external: it's a native addon
 * and optional (the CLI falls back to a file when it's missing).
 */
import { build } from 'esbuild';
import { chmodSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/snitch.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  external: ['@napi-rs/keyring'],
  define: { __SNITCH_CLI_VERSION__: JSON.stringify(pkg.version) },
  // CJS dependencies bundled into ESM still call require().
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __snitchCreateRequire } from 'node:module'; const require = __snitchCreateRequire(import.meta.url);" },
  logLevel: 'info',
});
chmodSync('dist/snitch.js', 0o755);
