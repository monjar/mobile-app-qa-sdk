/**
 * Admin CLI, for setups without the dashboard handy (first boot, CI, scripts).
 * In Docker: `docker exec <container> snitch <command>`.
 *
 *   snitch user:create --email a@b.c --password … [--name …] [--role admin|member]
 *   snitch user:reset-password --email a@b.c --password …
 *   snitch project:create --name Mochiro --slug mochiro --prefix MOCH [--ingest-key snitch_pk_…]
 *   snitch key:create --project mochiro [--label …]
 *   snitch backup --out /data/backup.db
 */
import { parseArgs } from 'node:util';
import { INGEST_KEY_PATTERN, PASSWORD_MIN_LENGTH, PROJECT_SLUG, TICKET_PREFIX } from '@snitch/contract';
import { loadConfig } from './config';
import { buildDeps } from './bootstrap';
import { VERSION } from './version';

const USAGE = `snitch ${VERSION}

Commands:
  user:create           --email <email> --password <pw> [--name <name>] [--role admin|member]
  user:reset-password   --email <email> --password <pw>
  project:create        --name <name> --slug <slug> --prefix <PREFIX> [--ingest-key <snitch_pk_…>]
  key:create            --project <slug> [--label <label>]
  backup                --out <path>
`;

function fail(msg: string): never {
  process.stderr.write(`snitch: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      email: { type: 'string' },
      password: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string' },
      slug: { type: 'string' },
      prefix: { type: 'string' },
      'ingest-key': { type: 'string' },
      project: { type: 'string' },
      label: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  });
  const deps = buildDeps(loadConfig());
  const need = (k: keyof typeof values): string => {
    const v = values[k];
    if (typeof v !== 'string' || !v) fail(`--${k} is required`);
    return v;
  };

  switch (command) {
    case 'user:create': {
      const email = need('email');
      const password = need('password');
      if (password.length < PASSWORD_MIN_LENGTH) fail(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
      const role = (values.role ?? 'admin') as 'admin' | 'member';
      if (role !== 'admin' && role !== 'member') fail('--role must be admin or member');
      if (deps.users.getByEmail(email)) fail(`user ${email} already exists`);
      const user = await deps.users.create({ email, password, role, name: values.name ?? null });
      deps.audit.add(null, 'user.created', user.id, { email, role, via: 'cli' });
      process.stdout.write(`Created ${role} ${email}\n`);
      break;
    }
    case 'user:reset-password': {
      const email = need('email');
      const password = need('password');
      if (password.length < PASSWORD_MIN_LENGTH) fail(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
      const user = deps.users.getByEmail(email) ?? fail(`no user ${email}`);
      await deps.users.update(user.id, { password, disabled: false });
      deps.sessions.deleteForUser(user.id);
      deps.audit.add(null, 'user.updated', user.id, { passwordReset: true, via: 'cli' });
      process.stdout.write(`Password reset for ${email}\n`);
      break;
    }
    case 'project:create': {
      const name = need('name');
      const slug = need('slug');
      const prefix = need('prefix');
      if (!PROJECT_SLUG.test(slug)) fail('--slug must be lowercase letters, digits and dashes');
      if (!TICKET_PREFIX.test(prefix)) fail('--prefix must be 1-10 uppercase letters/digits starting with a letter');
      const key = values['ingest-key'];
      if (key !== undefined && !INGEST_KEY_PATTERN.test(key)) fail('--ingest-key must look like snitch_pk_ followed by 26 base32 characters');
      if (deps.projects.getBySlug(slug)) fail(`project ${slug} already exists`);
      const project = deps.projects.create({ name, slug, ticketPrefix: prefix });
      const created = deps.projects.createKey(project.id, 'default', key);
      deps.audit.add(null, 'project.created', project.id, { slug, via: 'cli' });
      process.stdout.write(`Created project ${name} (${slug})\nIngest key: ${created.plaintext}\n`);
      break;
    }
    case 'key:create': {
      const project = deps.projects.getBySlug(need('project')) ?? fail('no such project');
      const created = deps.projects.createKey(project.id, values.label ?? null);
      deps.audit.add(null, 'key.created', created.key.id, { project: project.slug, via: 'cli' });
      process.stdout.write(`${created.plaintext}\n`);
      break;
    }
    case 'backup': {
      const out = need('out');
      deps.db.prepare('VACUUM INTO ?').run(out);
      process.stdout.write(`Database copied to ${out}. Blobs live in ${deps.blobs.kind === 'fs' ? `${deps.config.dataDir}/blobs` : 'your S3 bucket'}.\n`);
      break;
    }
    default:
      fail(`unknown command ${command}\n\n${USAGE}`);
  }
  deps.db.close();
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
