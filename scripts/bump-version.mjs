#!/usr/bin/env node
/**
 * Keeps one version everywhere. VERSION at the repo root is the source of truth.
 *
 *   node scripts/bump-version.mjs 0.2.0     write 0.2.0 to VERSION and every package
 *   node scripts/bump-version.mjs --check   fail if anything disagrees with VERSION
 *   node scripts/bump-version.mjs --check v0.2.0   …and with this tag
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

/** [file, regex with one capture group around the version] */
const SPOTS = [
  ['package.json', /"version": "([^"]+)"/],
  ['contract/package.json', /"version": "([^"]+)"/],
  ['server/package.json', /"version": "([^"]+)"/],
  ['dashboard/package.json', /"version": "([^"]+)"/],
  ['react-native/package.json', /"version": "([^"]+)"/],
  ['ios/Sources/Snitch/Core/Support.swift', /enum SnitchVersion \{\s*static let current = "([^"]+)"/],
  ['android/snitch/src/main/java/io/github/monjar/snitch/SnitchVersion.kt', /SDK_VERSION\s*=\s*"([^"]+)"/],
];

const args = process.argv.slice(2);
const check = args[0] === '--check';
const target = check ? read('VERSION').trim() : args[0];
if (!target || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(target)) {
  console.error('usage: bump-version.mjs <x.y.z> | --check [tag]');
  process.exit(1);
}

let bad = 0;
const tag = check ? args[1] : undefined;
if (tag && tag.replace(/^v/, '') !== target) {
  console.error(`tag ${tag} does not match VERSION ${target}`);
  bad++;
}
if (!check) writeFileSync(join(root, 'VERSION'), target + '\n');
for (const [file, re] of SPOTS) {
  if (!existsSync(join(root, file))) {
    console.warn(`skip ${file} (missing)`);
    continue;
  }
  const text = read(file);
  const m = re.exec(text);
  if (!m) {
    console.error(`${file}: version marker not found (${re})`);
    bad++;
    continue;
  }
  if (check) {
    if (m[1] !== target) {
      console.error(`${file}: ${m[1]} ≠ ${target}`);
      bad++;
    }
  } else {
    writeFileSync(join(root, file), text.replace(re, (whole, v) => whole.replace(v, target)));
    console.log(`${file}: ${m[1]} → ${target}`);
  }
}
if (bad) process.exit(1);
if (check) console.log(`all versions are ${target}`);
