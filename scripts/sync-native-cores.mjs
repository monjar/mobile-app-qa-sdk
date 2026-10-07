#!/usr/bin/env node
/**
 * Copies the native Snitch cores into the React Native package so CocoaPods
 * and Gradle compile the very same sources as the SwiftPM / Gradle libraries:
 *
 *   ios/Sources/Snitch/**                                     → react-native/ios/core/
 *   android/snitch/src/main/java/io/github/monjar/snitch/**    → react-native/android/src/main/java/io/github/monjar/snitch/
 *   android/snitch-system-capture/src/main/java/io/github/monjar/snitch/system/**
 *                                                             → react-native/android/src/main/java/io/github/monjar/snitch/system/
 *   LICENSE                                                   → react-native/LICENSE
 *
 * Each destination is deleted first (the Android one keeps the `rn/` bridge,
 * which lives in the package itself). The copies are gitignored and shipped
 * in the npm tarball.
 *
 * Runs from anywhere: the repo root (`node scripts/sync-native-cores.mjs`) or
 * the package (`npm run sync-native`, `prepare`, `prepack`); paths are
 * resolved from this file's location, not the working directory.
 *
 * Missing sources are an error, except:
 *   - SNITCH_SKIP_SYNC=1 skips the sync entirely;
 *   - when the repo's ios/Sources is absent but the copies already exist
 *     (the package was moved out of the monorepo), the copies are kept.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgRoot = path.join(repoRoot, 'react-native');

const ANDROID_PKG = 'io/github/monjar/snitch';
const ANDROID_DEST = `react-native/android/src/main/java/${ANDROID_PKG}`;
/** Sub-packages of the Android destination that belong to the RN package, not to the copied core. */
const ANDROID_KEEP = new Set(['rn']);

const COPIES = [
  {
    label: 'iOS core',
    from: 'ios/Sources/Snitch',
    to: 'react-native/ios/core',
  },
  {
    label: 'Android core',
    from: `android/snitch/src/main/java/${ANDROID_PKG}`,
    to: ANDROID_DEST,
    keep: ANDROID_KEEP,
  },
  {
    label: 'Android system capture',
    from: `android/snitch-system-capture/src/main/java/${ANDROID_PKG}/system`,
    to: `${ANDROID_DEST}/system`,
  },
];

/** Never copied: OS/editor litter. */
const IGNORED_NAMES = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep']);

const rel = (p) => path.relative(repoRoot, p) || '.';

function log(message) {
  console.log(`[snitch sync] ${message}`);
}

function fail(message) {
  console.error(`[snitch sync] ERROR: ${message}`);
  process.exit(1);
}

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else n += 1;
  }
  return n;
}

function isNonEmptyDir(dir) {
  return existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).length > 0;
}

/** Deletes `dir`'s contents except the top-level names in `keep`. */
function clearDir(dir, keep = new Set()) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (keep.has(name)) continue;
    rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

function main() {
  if (process.env.SNITCH_SKIP_SYNC === '1') {
    log('SNITCH_SKIP_SYNC=1, skipping.');
    return;
  }
  if (!existsSync(path.join(pkgRoot, 'package.json'))) {
    fail(`React Native package not found at ${pkgRoot}.`);
  }

  const sources = COPIES.map((c) => ({ ...c, fromAbs: path.join(repoRoot, c.from), toAbs: path.join(repoRoot, c.to) }));
  const missing = sources.filter((c) => !isNonEmptyDir(c.fromAbs));

  if (missing.length > 0) {
    const copiesPresent = sources.every((c) => isNonEmptyDir(c.toAbs));
    if (!existsSync(path.join(repoRoot, 'ios', 'Sources')) && copiesPresent) {
      log('Native sources are not next to this package; keeping the existing copies.');
      return;
    }
    fail(
      [
        'native sources missing:',
        ...missing.map((c) => `  - ${c.label}: ${rel(c.fromAbs)}`),
        'Run this from a full checkout of the Snitch monorepo, or set SNITCH_SKIP_SYNC=1',
        '(e.g. when the package already contains the copied cores).',
      ].join('\n'),
    );
  }

  for (const c of sources) {
    for (const name of c.keep ?? []) {
      if (existsSync(path.join(c.fromAbs, name))) {
        fail(`${rel(path.join(c.fromAbs, name))} collides with the React Native package's own ${name}/ sources.`);
      }
    }
  }
  const core = sources.find((c) => c.label === 'Android core');
  if (existsSync(path.join(core.fromAbs, 'system'))) {
    fail(`${rel(path.join(core.fromAbs, 'system'))} collides with the system-capture module copy.`);
  }

  for (const c of sources) {
    clearDir(c.toAbs, c.keep);
    mkdirSync(c.toAbs, { recursive: true });
    cpSync(c.fromAbs, c.toAbs, {
      recursive: true,
      filter: (src) => !IGNORED_NAMES.has(path.basename(src)),
    });
    log(`${c.label}: ${countFiles(c.fromAbs)} files  ${c.from} → ${c.to}`);
  }

  const license = path.join(repoRoot, 'LICENSE');
  const pkgLicense = path.join(pkgRoot, 'LICENSE');
  if (existsSync(license)) {
    const same = existsSync(pkgLicense) && readFileSync(license).equals(readFileSync(pkgLicense));
    if (!same) {
      copyFileSync(license, pkgLicense);
      log('LICENSE → react-native/LICENSE');
    }
  }
}

main();
