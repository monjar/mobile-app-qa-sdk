/**
 * `snitch skill`: the agent skill (skills/snitch-fix: SKILL.md and its
 * references/) that turns Snitch reports into fixes and pull requests,
 * installed into a project for Claude Code (.claude/skills/snitch-fix/) or
 * printed as one file for any other agent. What can be detected is filled in:
 * the server and ticket prefix, the default branch, the checks to run, the kind
 * of app. The build copies the skill next to dist/snitch.js; from source it is
 * read from the repository.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_NAME = 'snitch-fix';
/** Where Claude Code looks for a project's skills. */
export const SKILL_DIR = join('.claude', 'skills', SKILL_NAME);
export const SKILL_PATH = join(SKILL_DIR, 'SKILL.md');

export interface SkillFile {
  /** Relative to the skill's folder, with forward slashes: `SKILL.md`, `references/ios-simulator.md`. */
  path: string;
  text: string;
}

export interface SkillValues {
  server?: string | null;
  prefix?: string | null;
  defaultBranch?: string | null;
  checks?: string | null;
  appKind?: string | null;
}

const PLACEHOLDERS: Record<keyof SkillValues, [string, string]> = {
  server: ['{{SERVER_URL}}', 'https://your-snitch-server'],
  prefix: ['{{TICKET_PREFIX}}', 'APP'],
  defaultBranch: ['{{DEFAULT_BRANCH}}', 'main'],
  checks: ['{{CHECKS}}', 'e.g. `npm run typecheck && npm run lint && npm test`'],
  appKind: ['{{APP_KIND}}', 'e.g. React Native (Expo) for iOS and Android'],
};

function templateDir(): string {
  const candidates = [
    new URL(`./skills/${SKILL_NAME}/`, import.meta.url), // dist/snitch.js → dist/skills/…
    new URL(`../../skills/${SKILL_NAME}/`, import.meta.url), // cli/src/skill.ts → skills/…
  ].map((u) => fileURLToPath(u));
  const found = candidates.find((p) => existsSync(join(p, 'SKILL.md')));
  if (!found) throw new Error('The skill template is missing from this installation of snitch-cli.');
  return found;
}

/** Every file of the skill, SKILL.md first. */
export function templateFiles(): SkillFile[] {
  const root = templateDir();
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  return walk(root)
    .map((p) => ({ path: relative(root, p).split(sep).join('/'), text: readFileSync(p, 'utf8') }))
    .sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)));
}

/** SKILL.md alone, as the template has it. */
export function templateText(): string {
  return templateFiles()[0]!.text;
}

/** The template with this project's values (or obvious placeholders when unknown). */
export function fillTemplate(text: string, values: SkillValues): string {
  let out = text;
  for (const [k, [mark, fallback]] of Object.entries(PLACEHOLDERS) as [keyof SkillValues, [string, string]][]) out = out.replaceAll(mark, values[k] || fallback);
  return out;
}

/** All the skill's files in one document, for agents that read a single instructions file. */
export function joinSkill(files: SkillFile[]): string {
  const [main, ...rest] = files;
  return [main!.text.trimEnd(), ...rest.map((f) => `\n---\n\n<!-- ${f.path} -->\n\n${f.text.trimEnd()}`)].join('\n') + '\n';
}

/** Writes the skill into `projectDir`; refuses to overwrite an installed one unless `force`. Returns the paths written. */
export function installSkill(projectDir: string, files: SkillFile[], force = false): string[] {
  const main = join(projectDir, SKILL_PATH);
  if (existsSync(main) && !force) throw new Error(`${main} already exists. Pass --force to replace it (your edits to it would be lost).`);
  return files.map((f) => {
    const path = join(projectDir, SKILL_DIR, ...f.path.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.text);
    return path;
  });
}

// ── What the project tells us ───────────────────────────────────────────────

function git(dir: string, ...args: string[]): string | null {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The default branch, the checks a pull request should pass, and what kind of app this is, when they're clear. */
export function detectProject(dir: string): Pick<SkillValues, 'defaultBranch' | 'checks' | 'appKind'> {
  const head = git(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  // origin's HEAD, as a clone sets it; else main or master; else (no remote yet) the branch checked out.
  const defaultBranch = head
    ? head.replace(/^origin\//, '')
    : (['main', 'master'].find((b) => git(dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`)) ?? git(dir, 'symbolic-ref', '--short', 'HEAD'));

  const pkg = readJson(join(dir, 'package.json'));
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  const pm = existsSync(join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(dir, 'yarn.lock')) ? 'yarn' : existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb')) ? 'bun' : 'npm';
  const runs = Object.keys(scripts).filter((s) => /^(typecheck|type-check|tsc|lint|test)(:.+)?$/.test(s) && !/watch|fix|ci|e2e/.test(s));
  // typecheck, then lint, then tests, as a person would run them.
  const order = (s: string) => (/^(typecheck|type-check|tsc)/.test(s) ? 0 : s.startsWith('lint') ? 1 : 2);
  const checks = runs.length ? `\`${runs.sort((a, b) => order(a) - order(b) || a.localeCompare(b)).map((s) => (s === 'test' && pm !== 'bun' ? `${pm} test` : `${pm} run ${s}`)).join(' && ')}\`` : null;

  const deps = { ...((pkg?.dependencies ?? {}) as object), ...((pkg?.devDependencies ?? {}) as object) } as Record<string, string>;
  const has = (p: string) => existsSync(join(dir, p));
  const platforms = [has('ios') || readdirSync(dir).some((f) => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace')) ? 'iOS' : null, has('android') ? 'Android' : null].filter(Boolean);
  const kind = deps.expo ? 'React Native (Expo)' : deps['react-native'] ? 'React Native' : has('pubspec.yaml') ? 'Flutter' : has('Package.swift') && !has('android') ? 'Swift' : null;
  const expoBoth = deps.expo && !platforms.length; // Expo with prebuild: the native folders aren't committed.
  const where = expoBoth ? 'iOS and Android' : platforms.join(' and ');
  const appKind = kind ? `${kind}${where ? ` for ${where}` : ''}` : where ? `${where} app` : null;
  return { defaultBranch, checks, appKind };
}
