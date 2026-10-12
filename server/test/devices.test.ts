/* eslint-disable @typescript-eslint/no-explicit-any -- test bodies are asserted field by field */
import { describe, expect, it } from 'vitest';
import type { DeviceList } from '@snitch/contract';
import { drain } from '../src/worker/worker';
import { adminFetch, harness, login, sdkHeaders, sendReport, type Harness } from './helpers';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';

async function checkin(h: Harness, q: Record<string, string>) {
  const res = await h.app.request(`/api/v1/sdk/config?${new URLSearchParams(q)}`, { headers: sdkHeaders() });
  expect(res.status).toBe(200);
}

describe('devices', () => {
  it('lists installs newest first and aggregates them per build', async () => {
    const h = await harness();
    const s = await login(h);
    await checkin(h, { platform: 'ios', releaseType: 'testflight', appVersion: '1.4.0', build: '210', installId: A, model: 'iPhone16,2' });
    h.clock.t += 1000;
    await checkin(h, { platform: 'ios', releaseType: 'adhoc', appVersion: '1.4.0', build: '210', installId: B });
    h.clock.t += 1000;
    await checkin(h, { platform: 'ios', releaseType: 'unknown', appVersion: '1.4.0', build: '210', installId: C, active: '0' });
    h.clock.t += 1000;
    await checkin(h, { platform: 'android', releaseType: 'internal', appVersion: '1.4.0', build: '88', installId: D });
    // Two reports from install A, one from a device that never checked in, same build.
    await sendReport(h, {}, { installId: A, app: { id: 'app.mochiro', version: '1.4.0', build: '210', releaseType: 'testflight' } });
    await sendReport(h, {}, { installId: A, app: { id: 'app.mochiro', version: '1.4.0', build: '210', releaseType: 'testflight' } });
    await sendReport(h, {}, { app: { id: 'app.mochiro', version: '1.4.0', build: '210', releaseType: 'testflight' } });

    const res = await adminFetch(h, s, `/projects/${h.projectId}/devices`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as DeviceList;
    expect(list.items.map((d) => d.installId)).toEqual([D, C, B, A]);
    expect(list.items.find((d) => d.installId === A)).toMatchObject({ reports: 2, checkins: 1, active: true, configEnabled: true, model: 'iPhone16,2' });
    expect(list.items.find((d) => d.installId === C)).toMatchObject({ active: false, configEnabled: false, reports: 0 });
    expect(list.builds).toEqual([
      { platform: 'android', appVersion: '1.4.0', build: '88', installs: 1, releaseTypes: { internal: 1 }, inactive: 0, reports: 0, lastSeenAt: h.clock.t },
      {
        platform: 'ios',
        appVersion: '1.4.0',
        build: '210',
        installs: 3,
        releaseTypes: { testflight: 1, adhoc: 1, unknown: 1 },
        inactive: 1,
        reports: 3,
        lastSeenAt: h.clock.t - 1000,
      },
    ]);
  });

  it('filters by platform, release type, age and limit', async () => {
    const h = await harness();
    await checkin(h, { platform: 'ios', releaseType: 'testflight', appVersion: '1', build: '1', installId: A });
    h.clock.t += 40 * 86_400_000;
    const s = await login(h);
    await checkin(h, { platform: 'ios', releaseType: 'debug', appVersion: '2', build: '2', installId: B });
    await checkin(h, { platform: 'android', releaseType: 'debug', appVersion: '2', build: '2', installId: C });
    const get = async (q: string) => (await (await adminFetch(h, s, `/projects/${h.projectId}/devices${q}`)).json()) as DeviceList;
    expect((await get('')).items.map((d) => d.installId).sort()).toEqual([B, C]);
    expect((await get('?sinceDays=60')).items).toHaveLength(3);
    expect((await get('?sinceDays=60')).builds.find((b) => b.build === '1')).toMatchObject({ installs: 1 });
    expect((await get('?platform=android')).items.map((d) => d.installId)).toEqual([C]);
    expect((await get('?releaseType=testflight&sinceDays=60')).items.map((d) => d.installId)).toEqual([A]);
    const limited = await get('?limit=1');
    expect(limited.items).toHaveLength(1);
    // Builds still cover every matching install.
    expect(limited.builds.reduce((n, b) => n + b.installs, 0)).toBe(2);
    expect((await adminFetch(h, s, `/projects/${h.projectId}/devices?limit=0`)).status).toBe(422);
    expect((await adminFetch(h, s, '/projects/nope/devices')).status).toBe(404);
  });

  it('is readable by members and needs a session', async () => {
    const h = await harness();
    await h.deps.users.create({ email: 'm@example.com', password: 'member password 1', role: 'member' });
    const ms = await login(h, { email: 'm@example.com', password: 'member password 1' });
    expect((await adminFetch(h, ms, `/projects/${h.projectId}/devices`)).status).toBe(200);
    expect((await h.app.request(`/api/admin/projects/${h.projectId}/devices`)).status).toBe(401);
  });

  it('forgets installs not seen for 180 days', async () => {
    const h = await harness({ config: { retentionDays: 0 } });
    await checkin(h, { platform: 'ios', releaseType: 'debug', installId: A });
    h.clock.t += 100 * 86_400_000;
    await checkin(h, { platform: 'ios', releaseType: 'debug', installId: B });
    h.clock.t += 81 * 86_400_000;
    h.deps.jobs.enqueue('retention_sweep', {});
    await drain(h.deps);
    expect((h.deps.db.prepare('SELECT install_id FROM installs').all() as any[]).map((r) => r.install_id)).toEqual([B]);
  });
});
