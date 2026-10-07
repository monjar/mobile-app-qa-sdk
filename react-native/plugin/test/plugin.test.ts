import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ExpoConfig } from 'expo/config';
import { AndroidConfig, compileModsAsync } from 'expo/config-plugins';
import { afterAll, describe, expect, it } from 'vitest';

import withSnitch from '../src';
import { INGEST_KEY, SERVER_URL } from './fixtures';

const projectRoot = mkdtempSync(path.join(tmpdir(), 'snitch-plugin-'));
afterAll(() => rmSync(projectRoot, { recursive: true, force: true }));

const baseConfig = (): ExpoConfig => ({
  name: 'Snitch Test',
  slug: 'snitch-test',
  ios: { bundleIdentifier: 'io.github.monjar.snitch.test', infoPlist: { CustomKey: 'kept' } },
  android: { package: 'io.github.monjar.snitch.test' },
});

/** Runs the plugin's mods the way `expo config --type introspect` does: in memory, no native project needed. */
async function introspect(config: ExpoConfig) {
  const result = await compileModsAsync(config, { projectRoot, introspect: true, platforms: ['ios', 'android'], assertMissingModProviders: false });
  const modResults = (result as { _internal?: { modResults?: Record<string, Record<string, unknown>> } })._internal?.modResults;
  return {
    infoPlist: modResults?.ios?.infoPlist as Record<string, unknown> | undefined,
    manifest: modResults?.android?.manifest as AndroidConfig.Manifest.AndroidManifest | undefined,
  };
}

describe('withSnitch', () => {
  it('writes the Info.plist dict and the manifest meta-data during prebuild', async () => {
    const config = withSnitch(baseConfig(), { serverUrl: SERVER_URL, ingestKey: INGEST_KEY, gesture: 'both' });
    const { infoPlist, manifest } = await introspect(config);

    expect(infoPlist?.Snitch).toEqual({ ServerURL: SERVER_URL, IngestKey: INGEST_KEY, Gesture: 'both' });
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest!);
    const meta = (app['meta-data'] ?? []).filter((e) => e.$['android:name'].startsWith('io.github.monjar.snitch.'));
    expect(meta.map((e) => [e.$['android:name'], e.$['android:value']])).toEqual([
      ['io.github.monjar.snitch.SERVER_URL', SERVER_URL],
      ['io.github.monjar.snitch.INGEST_KEY', INGEST_KEY],
      ['io.github.monjar.snitch.GESTURE', 'both'],
    ]);
  });

  it('runs once even when listed twice', () => {
    const once = withSnitch(baseConfig(), { serverUrl: SERVER_URL, ingestKey: INGEST_KEY });
    const twice = withSnitch(once, { serverUrl: 'https://other.example.com', ingestKey: INGEST_KEY });
    expect(twice._internal?.pluginHistory?.['react-native-snitch']).toMatchObject({ name: 'react-native-snitch' });
    expect(twice).toBe(once);
  });

  it('fails fast on malformed options when the config is read', () => {
    expect(() => withSnitch(baseConfig(), { serverUrl: 'snitch.example.com', ingestKey: INGEST_KEY })).toThrow(
      /serverUrl must be an absolute http\(s\) URL/,
    );
  });

  it('does not require serverUrl / ingestKey until prebuild, then explains how to provide them', async () => {
    const config = withSnitch(baseConfig(), {});
    await expect(introspect(config)).rejects.toThrow(/serverUrl is required: set it in the plugin options or the SNITCH_SERVER_URL/);
  });
});
