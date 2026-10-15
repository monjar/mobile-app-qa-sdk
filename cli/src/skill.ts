/**
 * `snitch skill`: the agent skill template (skills/snitch-fix/SKILL.md) that
 * turns Snitch reports into fixes and pull requests, installed into a project
 * for Claude Code (.claude/skills/snitch-fix/SKILL.md) or printed for any other
 * agent. The build copies the template next to dist/snitch.js; from source it
 * is read from the repository.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_NAME = 'snitch-fix';
/** Where Claude Code looks for a project's skills. */
export const SKILL_PATH = join('.claude', 'skills', SKILL_NAME, 'SKILL.md');

const PLACEHOLDER_SERVER = 'https://your-snitch-server';
const PLACEHOLDER_PREFIX = 'APP';

export function templateText(): string {
  const candidates = [
    new URL(`./skills/${SKILL_NAME}/SKILL.md`, import.meta.url), // dist/snitch.js → dist/skills/…
    new URL(`../../skills/${SKILL_NAME}/SKILL.md`, import.meta.url), // cli/src/skill.ts → skills/…
  ].map((u) => fileURLToPath(u));
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('The skill template is missing from this installation of snitch-cli.');
  return readFileSync(found, 'utf8');
}

/** The template with this project's server and ticket prefix (or obvious placeholders when unknown). */
export function fillTemplate(text: string, values: { server?: string | null; prefix?: string | null }): string {
  return text.replaceAll('{{SERVER_URL}}', values.server || PLACEHOLDER_SERVER).replaceAll('{{TICKET_PREFIX}}', values.prefix || PLACEHOLDER_PREFIX);
}

/** Writes the skill into `projectDir`; refuses to overwrite an existing one unless `force`. */
export function installSkill(projectDir: string, text: string, force = false): string {
  const path = join(projectDir, SKILL_PATH);
  if (existsSync(path) && !force) throw new Error(`${path} already exists. Pass --force to replace it (your edits to it would be lost).`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}
