#!/usr/bin/env node
/**
 * Checks what `npm pack` would put in the react-native-snitch tarball: every
 * file the native builds, the JS entry points and the config plugin need is
 * there, and nothing that shouldn't ship (tests, node_modules, example apps,
 * build output of the native toolchains) is.
 *
 * Run after `npm run build` (and the native sync) in react-native/:
 *   node ../scripts/check-pack.mjs        (from react-native/)
 *   node scripts/check-pack.mjs           (from the repo root)
 *
 * Note: `npm pack` runs the package's `prepare` script even in --dry-run mode,
 * so this also re-syncs the native cores and rebuilds lib/ and plugin/build/.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Files the tarball must contain. */
const REQUIRED = [
  // iOS: Swift core (copied by sync-native-cores), TurboModule, autostart, pod
  'ios/core/Snitch.swift',
  'ios/core/Bridge/SnitchBridge.swift',
  'ios/core/Resources/PrivacyInfo.xcprivacy',
  'ios/RNSnitch.h',
  'ios/RNSnitch.mm',
  'ios/SNAutoStart.m',
  'react-native-snitch.podspec',
  // Android: Kotlin core (copied), TurboModule, Gradle build, manifest
  'android/src/main/java/io/github/monjar/snitch/Snitch.kt',
  'android/src/main/java/io/github/monjar/snitch/rn/SnitchModule.kt',
  'android/src/main/java/io/github/monjar/snitch/rn/SnitchPackage.kt',
  'android/build.gradle',
  'android/proguard-rules.pro',
  'android/src/main/AndroidManifest.xml',
  'react-native.config.js',
  // JS: codegen spec source, compiled API, Expo config plugin
  'src/NativeSnitch.ts',
  'src/index.ts',
  'lib/index.js',
  'lib/index.d.ts',
  'lib/NativeSnitch.js',
  'app.plugin.js',
  'plugin/build/index.js',
  'plugin/build/index.d.ts',
  'package.json',
  'README.md',
  'LICENSE',
];

/** Directories that must contain at least one file. */
const REQUIRED_DIRS = [
  'ios/core/',
  'android/src/main/java/io/github/monjar/snitch/system/',
];

/** Paths that must not ship, with the reason shown on failure. */
const FORBIDDEN = [
  [/(^|\/)node_modules\//, 'node_modules'],
  [/(^|\/)(test|tests|__tests__|__mocks__)\//, 'test directory'],
  [/\.(test|spec)\.[cm]?[jt]sx?$/, 'test file'],
  [/(^|\/)examples?\//, 'example app'],
  [/^plugin\/src\//, 'plugin sources (plugin/build ships instead)'],
  [/^android\/(build|\.gradle|\.cxx)\//, 'Gradle output'],
  [/^android\/local\.properties$/, 'local.properties'],
  [/^ios\/build\//, 'Xcode output'],
  [/\.tsbuildinfo$/, 'TypeScript build info'],
  [/(^|\/)vitest\.config\.[cm]?[jt]s$/, 'test config'],
  [/(^|\/)tsconfig(\.[\w-]+)?\.json$/, 'tsconfig'],
  [/(^|\/)\.DS_Store$/, '.DS_Store'],
  [/\.tgz$/, 'tarball'],
];

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'react-native');

const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: pkgDir,
  encoding: 'utf8',
  shell: process.platform === 'win32',
  maxBuffer: 64 * 1024 * 1024,
});
if (result.status !== 0) {
  process.stderr.write(result.stderr ?? '');
  process.stdout.write(result.stdout ?? '');
  console.error(`check-pack: npm pack --dry-run failed (exit ${result.status}).`);
  process.exit(1);
}

// Lifecycle scripts (prepare) print to stdout too; the JSON report starts at a line that is just "[".
const stdout = result.stdout ?? '';
const start = stdout.search(/^\[\s*$/m);
let report;
try {
  report = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
} catch (error) {
  console.error('check-pack: could not parse `npm pack --json` output:', error.message);
  process.stdout.write(stdout);
  process.exit(1);
}

const entry = report[0];
const files = new Set(entry.files.map((f) => f.path.replace(/\\/g, '/')));

const missing = REQUIRED.filter((f) => !files.has(f));
const emptyDirs = REQUIRED_DIRS.filter((dir) => ![...files].some((f) => f.startsWith(dir)));
const forbidden = [...files].flatMap((f) => FORBIDDEN.filter(([re]) => re.test(f)).map(([, why]) => `${f} (${why})`));

console.log(`check-pack: ${entry.name}@${entry.version} → ${entry.filename}`);
console.log(`  ${entry.entryCount} files, ${(entry.size / 1024).toFixed(1)} kB packed, ${(entry.unpackedSize / 1024).toFixed(1)} kB unpacked`);

let ok = true;
if (missing.length > 0) {
  ok = false;
  console.error(`\nMissing from the tarball (${missing.length}):`);
  for (const f of missing) console.error(`  - ${f}`);
}
if (emptyDirs.length > 0) {
  ok = false;
  console.error('\nEmpty or missing directories:');
  for (const d of emptyDirs) console.error(`  - ${d}`);
}
if (forbidden.length > 0) {
  ok = false;
  console.error('\nMust not ship:');
  for (const f of forbidden) console.error(`  - ${f}`);
}
if (!ok) {
  console.error('\ncheck-pack: FAILED');
  process.exit(1);
}
console.log('check-pack: OK');
