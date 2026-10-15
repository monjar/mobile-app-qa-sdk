/* eslint-disable @typescript-eslint/no-explicit-any -- test bodies are asserted field by field */
import { describe, expect, it } from 'vitest';
import type { TicketDetail } from '@snitch/contract';
import { drain } from '../src/worker/worker';
import { adminFetch, FakeGithub, harness, jpeg, login, mp4, sendReport, type Harness, type Session } from './helpers';

const github = (config: Record<string, unknown> = {}) => ({
  kind: 'github',
  name: 'GitHub',
  config: { owner: 'monjar', repo: 'mochiro', labels: [], media: 'repo', ...config },
  secret: 'ghp_test',
});

async function setup(config: Record<string, unknown> = {}) {
  const h = await harness();
  const s = await login(h);
  const gh = new FakeGithub();
  h.onFetch(gh.handle);
  const r = await adminFetch(h, s, `/projects/${h.projectId}/integrations`, { method: 'POST', body: github(config) });
  expect(r.status).toBe(201);
  const integrationId = ((await r.json()) as any).id as string;
  return { h, s, gh, integrationId };
}

async function escalateNew(h: Harness, s: Session, integrationId: string, files = { screenshot: jpeg(3000), video: mp4(5000) }): Promise<string> {
  const id = await sendReport(h, files);
  await adminFetch(h, s, `/tickets/${id}/escalations`, { method: 'POST', body: { integrationId } });
  await drain(h.deps);
  return id;
}

const detail = async (h: Harness, s: Session, id: string) => (await (await adminFetch(h, s, `/tickets/${id}`)).json()) as TicketDetail;

describe('GitHub issues with the media committed to the repo', () => {
  it('commits the screenshot and video to snitch-media and shows them in the issue', async () => {
    const { h, s, gh, integrationId } = await setup();
    const screenshot = jpeg(3000);
    const video = mp4(5000);
    const id = await escalateNew(h, s, integrationId, { screenshot, video });

    expect(gh.fileAt('snitch-media', 'MOCH-1/screenshot.jpg')).toEqual(screenshot);
    expect(gh.fileAt('snitch-media', 'MOCH-1/video.mp4')).toEqual(video);
    const head = gh.refs.get('snitch-media')!;
    expect(gh.commits.get(head)).toMatchObject({ parents: [], message: 'MOCH-1: media from Snitch' });

    const body = gh.issues.get(1)!.body;
    expect(body).toContain(`<img src="https://github.com/monjar/mochiro/blob/${head}/MOCH-1/screenshot.jpg?raw=true" alt="Screenshot" width="320">`);
    expect(body).toContain(`[Screen recording (15 s)](https://github.com/monjar/mochiro/blob/${head}/MOCH-1/video.mp4?raw=true)`);
    expect(body).not.toContain('attached in Snitch');
    // No public share links in this mode.
    expect((await detail(h, s, id)).events.map((e) => e.kind)).not.toContain('share_link_created');
    expect((await detail(h, s, id)).escalations[0]).toMatchObject({ state: 'sent' });

    // The next report builds on the branch.
    await escalateNew(h, s, integrationId);
    const next = gh.refs.get('snitch-media')!;
    expect(gh.commits.get(next)!.parents).toEqual([head]);
    expect(gh.fileAt('snitch-media', 'MOCH-1/screenshot.jpg')).toEqual(screenshot);
    expect(gh.fileAt('snitch-media', 'MOCH-2/screenshot.jpg')).not.toBeNull();
  });

  it('without Contents: write, still opens the issue and notes why the media is missing', async () => {
    const { h, s, gh, integrationId } = await setup();
    gh.contentsWritable = false;
    const id = await escalateNew(h, s, integrationId);
    expect(gh.issues.get(1)!.body).toContain('📷 Screenshot attached in Snitch');
    const d = await detail(h, s, id);
    expect(d.escalations[0]).toMatchObject({ state: 'sent' });
    const note = d.events.find((e) => e.kind === 'media_upload_failed')!;
    expect(note.data).toMatchObject({ integration: 'GitHub', error: expect.stringContaining('HTTP 403') });
  });

  it('retries a transient failure without opening a second issue, and rebuilds on a branch that moved', async () => {
    const { h, s, gh, integrationId } = await setup();
    gh.failWrites = [502];
    const id = await escalateNew(h, s, integrationId);
    expect(gh.issues.size).toBe(0);
    h.clock.t += 10 * 60_000;
    await drain(h.deps);
    expect(gh.issues.size).toBe(1);
    expect(gh.issues.get(1)!.body).toContain('MOCH-1/screenshot.jpg?raw=true');
    expect((await detail(h, s, id)).escalations[0]).toMatchObject({ state: 'sent' });

    gh.failRefUpdates = [422];
    await escalateNew(h, s, integrationId);
    expect(gh.issues.size).toBe(2);
    expect(gh.fileAt('snitch-media', 'MOCH-2/video.mp4')).not.toBeNull();
  });

  it('can keep the media in another repository', async () => {
    const { h, s, gh, integrationId } = await setup({ mediaRepo: 'monjar/qa-media' });
    const media = new FakeGithub('monjar', 'qa-media');
    h.onFetch((url, init) => (url.includes('/repos/monjar/qa-media') ? media.handle(url, init) : gh.handle(url, init)));
    await escalateNew(h, s, integrationId);
    expect(gh.refs.size).toBe(0);
    expect(media.fileAt('snitch-media', 'MOCH-1/screenshot.jpg')).not.toBeNull();
    expect(gh.issues.get(1)!.body).toContain(`https://github.com/monjar/qa-media/blob/${media.refs.get('snitch-media')}/MOCH-1/screenshot.jpg?raw=true`);
  });

  it('older settings keep their share-link behaviour; none links to Snitch', async () => {
    const legacy = await setup({ media: undefined, includeShareLinks: true });
    await escalateNew(legacy.h, legacy.s, legacy.integrationId);
    expect(legacy.gh.issues.get(1)!.body).toContain('http://snitch.test/s/');
    expect(legacy.gh.refs.size).toBe(0);

    const none = await setup({ media: 'none' });
    await escalateNew(none.h, none.s, none.integrationId);
    expect(none.gh.issues.get(1)!.body).toContain('📷 Screenshot attached in Snitch');
    expect(none.gh.calls.some((c) => c.path.includes('/git/'))).toBe(false);
  });
});
