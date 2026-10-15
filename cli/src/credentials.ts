/**
 * Tokens and the default server.
 *
 * A token goes to the OS credential store when one is available (macOS
 * Keychain, Windows Credential Manager, Linux Secret Service through
 * @napi-rs/keyring, an optional dependency). Without one (a headless Linux box,
 * a container, or SNITCH_NO_KEYRING=1) it goes to credentials.json in the
 * config directory, readable only by you. SNITCH_TOKEN beats both, for CI.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './paths';

const SERVICE = 'snitch-cli';

export type StoreKind = 'keyring' | 'file';

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}
type EntryClass = new (service: string, account: string) => KeyringEntry;

let keyringClass: EntryClass | null | undefined;

async function keyring(env: NodeJS.ProcessEnv): Promise<EntryClass | null> {
  if (env.SNITCH_NO_KEYRING === '1') return null;
  if (keyringClass !== undefined) return keyringClass;
  try {
    const mod = (await import('@napi-rs/keyring')) as unknown as { Entry: EntryClass };
    keyringClass = mod.Entry;
  } catch {
    keyringClass = null;
  }
  return keyringClass;
}

/** `https://snitch.example.com/` → `https://snitch.example.com`; throws on anything that isn't http(s). */
export function normalizeServer(input: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) && !/^https?:\/\//i.test(input)) throw new Error(`Not a server address: ${input}`);
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error(`Not a server address: ${input}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Not a server address: ${input}`);
  return url.origin;
}

export class Credentials {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private get dir() {
    return configDir(this.env);
  }

  private readJson<T>(name: string, fallback: T): T {
    const p = join(this.dir, name);
    if (!existsSync(p)) return fallback;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  /**
   * Writes a new file and renames it into place, so the content is never in a file with looser permissions
   * (writeFileSync's mode only applies when it creates the file) and a crash can't leave half a file.
   */
  private writeJson(name: string, value: unknown, secret: boolean): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const p = join(this.dir, name);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: secret ? 0o600 : 0o644, flag: 'wx' });
    renameSync(tmp, p);
  }

  /** --server, then SNITCH_URL, then the server you last signed in to. */
  server(flag?: string): string | null {
    const s = flag ?? this.env.SNITCH_URL ?? this.readJson<{ server?: string }>('config.json', {}).server;
    return s ? normalizeServer(s) : null;
  }

  setDefaultServer(server: string): void {
    this.writeJson('config.json', { ...this.readJson<Record<string, unknown>>('config.json', {}), server }, false);
  }

  async token(server: string): Promise<{ token: string; from: StoreKind | 'env' } | null> {
    if (this.env.SNITCH_TOKEN) return { token: this.env.SNITCH_TOKEN.trim(), from: 'env' };
    const Entry = await keyring(this.env);
    if (Entry) {
      try {
        const t = new Entry(SERVICE, server).getPassword();
        if (t) return { token: t, from: 'keyring' };
      } catch {
        // No usable store (e.g. Secret Service isn't running): fall through to the file.
      }
    }
    const t = this.readJson<Record<string, string>>('credentials.json', {})[server];
    return t ? { token: t, from: 'file' } : null;
  }

  async save(server: string, token: string): Promise<StoreKind> {
    const Entry = await keyring(this.env);
    if (Entry) {
      try {
        new Entry(SERVICE, server).setPassword(token);
        this.removeFromFile(server);
        return 'keyring';
      } catch {
        // Fall back to the file below.
      }
    }
    this.writeJson('credentials.json', { ...this.readJson<Record<string, string>>('credentials.json', {}), [server]: token }, true);
    return 'file';
  }

  async remove(server: string): Promise<void> {
    const Entry = await keyring(this.env);
    if (Entry) {
      try {
        new Entry(SERVICE, server).deletePassword();
      } catch {
        // Nothing stored there.
      }
    }
    this.removeFromFile(server);
  }

  private removeFromFile(server: string): void {
    const all = this.readJson<Record<string, string>>('credentials.json', {});
    if (!(server in all)) return;
    delete all[server];
    this.writeJson('credentials.json', all, true);
  }
}
