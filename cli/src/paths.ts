/**
 * Where the CLI keeps things, per OS:
 *
 *   config (server, file-stored tokens)   $SNITCH_CONFIG_DIR, else
 *     macOS/Linux  $XDG_CONFIG_HOME/snitch or ~/.config/snitch
 *     Windows      %APPDATA%\snitch
 *   cache (downloaded reports)            $SNITCH_CACHE_DIR, else
 *     macOS        ~/Library/Caches/snitch
 *     Linux        $XDG_CACHE_HOME/snitch or ~/.cache/snitch
 *     Windows      %LOCALAPPDATA%\snitch\Cache
 *
 * Reports hold testers' screens and logs, so they go to a cache directory by
 * default rather than the current folder, where they could end up committed.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export function configDir(env = process.env, platform = process.platform): string {
  if (env.SNITCH_CONFIG_DIR) return env.SNITCH_CONFIG_DIR;
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'snitch');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'snitch');
}

export function cacheDir(env = process.env, platform = process.platform): string {
  if (env.SNITCH_CACHE_DIR) return env.SNITCH_CACHE_DIR;
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'snitch', 'Cache');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'snitch');
  return join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'snitch');
}

/** A folder name for a server: its host, with the port when there is one. */
export function serverFolder(server: string): string {
  return new URL(server).host.replace(/[^A-Za-z0-9.-]/g, '_');
}
