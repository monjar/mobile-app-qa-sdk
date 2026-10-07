/* eslint-disable @typescript-eslint/no-explicit-any -- test bodies are asserted field by field */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SDK_CONFIG, ReportCreated } from '@snitch/contract';
import { drain } from '../src/worker/worker';
import { harness, INGEST_KEY, jpeg, mp4, postReport, putAttachment, report, sdkHeaders, sendReport, sha256 } from './helpers';

describe('report intake', () => {
  it('creates a ticket, takes attachments and completes', async () => {
    const h = await harness();
    const shot = jpeg();
    const video = mp4();
    const body = report({ screenshot: shot, video });
    const res = await postReport(h, body);
    expect(res.status).toBe(201);
    const created = ReportCreated.parse(await res.json() as any);
    expect(created.ticket).toBe('MOCH-1');
    expect(created.state).toBe('pending');
    expect(created.attachments).toEqual([
      { name: 'screenshot', state: 'missing' },
      { name: 'video', state: 'missing' },
    ]);

    const early = await h.app.request(`/api/v1/reports/${created.reportId}/complete`, { method: 'POST', headers: sdkHeaders() });
    expect(early.status).toBe(409);
    expect(await early.json() as any).toMatchObject({ error: { code: 'attachments_missing', details: { missing: ['screenshot', 'video'] } } });

    expect((await putAttachment(h, created.reportId, 'screenshot', shot, 'image/jpeg')).status).toBe(201);
    expect((await putAttachment(h, created.reportId, 'video', video, 'video/mp4')).status).toBe(201);
    // Re-sending the same bytes is fine.
    expect((await putAttachment(h, created.reportId, 'video', video, 'video/mp4')).status).toBe(200);

    const done = await h.app.request(`/api/v1/reports/${created.reportId}/complete`, { method: 'POST', headers: sdkHeaders() });
    expect(done.status).toBe(200);
    expect(await done.json() as any).toEqual({ reportId: created.reportId, ticket: 'MOCH-1', state: 'complete' });

    const ticket = h.deps.tickets.get(created.reportId)!;
    expect(ticket.title).toBe('Petting the face froze it for a second.');
    expect(ticket.release_type).toBe('testflight');
    expect(h.deps.tickets.events(ticket.id).map((e) => e.kind)).toEqual(['created', 'completed']);
    // Routing is queued for the worker.
    expect(h.deps.jobs.list('queued').map((j) => j.kind)).toContain('route_ticket');
  });

  it('is idempotent on clientReportId', async () => {
    const h = await harness();
    const body = report({ screenshot: jpeg() });
    const a = await postReport(h, body);
    const b = await postReport(h, body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect((await a.json() as any).reportId).toBe((await b.json() as any).reportId);
    const c = await postReport(h, report({ screenshot: jpeg() }));
    expect((await c.json() as any).ticket).toBe('MOCH-2');
  });

  it('completes immediately when there are no attachments', async () => {
    const h = await harness();
    const res = await postReport(h, report({}));
    expect((await res.json() as any).state).toBe('complete');
  });

  it('rejects bad keys, disallowed release types and app ids', async () => {
    const h = await harness();
    expect((await postReport(h, report(), 'snitch_pk_ZZZZZZZZZZZZZZZZZZZZZZZZZZ')).status).toBe(401);
    expect((await postReport(h, report(), 'nope')).status).toBe(401);
    const store = report({}, { app: { ...report().app, releaseType: 'appstore' } });
    const r = await postReport(h, store);
    expect(r.status).toBe(403);
    expect((await r.json() as any).error.code).toBe('release_type_not_allowed');
    h.deps.projects.update(h.projectId, { allowedAppIds: ['com.other.app'] });
    const r2 = await postReport(h, report());
    expect((await r2.json() as any).error.code).toBe('app_id_not_allowed');
  });

  it('rejects revoked keys', async () => {
    const h = await harness();
    const key = h.deps.projects.listKeys(h.projectId)[0]!;
    h.deps.projects.revokeKey(key.id);
    expect((await postReport(h, report())).status).toBe(401);
  });

  it('validates the body', async () => {
    const h = await harness();
    const r = await postReport(h, { ...report(), clientReportId: 'not-a-uuid' });
    expect(r.status).toBe(422);
    const body = await r.json() as any;
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.details[0].path).toBe('clientReportId');
    const wrongType = await h.app.request('/api/v1/reports', { method: 'POST', headers: { 'x-snitch-key': INGEST_KEY, 'content-type': 'text/plain' }, body: '{}' });
    expect(wrongType.status).toBe(415);
  });

  it('checks every upload header and the bytes', async () => {
    const h = await harness();
    const shot = jpeg();
    const created = await (await postReport(h, report({ screenshot: shot }))).json() as any;
    const id = created.reportId as string;

    expect((await putAttachment(h, id, 'screenshot', shot, 'image/png')).status).toBe(415);
    expect((await putAttachment(h, id, 'nope', shot, 'image/jpeg')).status).toBe(404);
    const wrongLen = await putAttachment(h, id, 'screenshot', shot, 'image/jpeg', { 'content-length': String(shot.length + 1) });
    expect(wrongLen.status).toBe(422);
    const wrongHashHeader = await putAttachment(h, id, 'screenshot', shot, 'image/jpeg', { 'x-content-sha256': sha256(Buffer.from('x')) });
    expect((await wrongHashHeader.json() as any).error.code).toBe('hash_mismatch');

    // Same length, right header hash, different bytes.
    const tampered = Buffer.from(shot);
    tampered[100] = 0;
    const r = await h.app.request(`/api/v1/reports/${id}/attachments/screenshot`, {
      method: 'PUT',
      headers: { 'x-snitch-key': INGEST_KEY, 'content-type': 'image/jpeg', 'content-length': String(shot.length), 'x-content-sha256': sha256(shot) },
      body: tampered,
    });
    expect((await r.json() as any).error.code).toBe('hash_mismatch');

    const notJpeg = Buffer.alloc(2048, 1);
    const created2 = await (await postReport(h, report({ screenshot: notJpeg }))).json() as any;
    const m = await putAttachment(h, created2.reportId, 'screenshot', notJpeg, 'image/jpeg');
    expect((await m.json() as any).error.code).toBe('magic_mismatch');
  });

  it('refuses uploads to another project and after completion', async () => {
    const h = await harness();
    const other = h.deps.projects.create({ name: 'Other', slug: 'other', ticketPrefix: 'OTH' });
    const otherKey = h.deps.projects.createKey(other.id, null).plaintext;
    const shot = jpeg();
    const created = await (await postReport(h, report({ screenshot: shot }))).json() as any;
    const cross = await h.app.request(`/api/v1/reports/${created.reportId}/attachments/screenshot`, {
      method: 'PUT',
      headers: { 'x-snitch-key': otherKey, 'content-type': 'image/jpeg', 'content-length': String(shot.length), 'x-content-sha256': sha256(shot) },
      body: shot,
    });
    expect(cross.status).toBe(404);
    await putAttachment(h, created.reportId, 'screenshot', shot, 'image/jpeg');
    await h.app.request(`/api/v1/reports/${created.reportId}/complete`, { method: 'POST', headers: sdkHeaders() });
    const late = await putAttachment(h, created.reportId, 'screenshot', shot, 'image/jpeg');
    expect((await late.json() as any).error.code).toBe('report_completed');
  });

  it('rate limits reports per key', async () => {
    const h = await harness({ config: { limits: { reportsPerKeyPerHour: 2, reportsPerIpPer10Min: 100, configPerIpPerHour: 100, loginPerIpPer15Min: 100 } } });
    expect((await postReport(h, report())).status).toBe(201);
    expect((await postReport(h, report())).status).toBe(201);
    const third = await postReport(h, report());
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBeTruthy();
  });

  it('marks never-completed reports incomplete after a day and routes them', async () => {
    const h = await harness();
    const created = await (await postReport(h, report({ screenshot: jpeg() }))).json() as any;
    h.clock.t += 25 * 3600_000;
    h.deps.jobs.enqueue('stale_upload_sweep', {});
    await drain(h.deps);
    const t = h.deps.tickets.get(created.reportId)!;
    expect(t.upload_state).toBe('incomplete');
    expect(h.deps.tickets.events(t.id).at(-1)).toMatchObject({ kind: 'incomplete', data: { missing: ['screenshot'] } });
  });
});

describe('remote sdk config', () => {
  it('serves defaults merged with project entries, most specific last', async () => {
    const h = await harness();
    h.deps.projects.replaceSdkConfig(h.projectId, [
      { platform: '*', releaseType: '*', config: { video: { idleFps: 2 } } },
      { platform: 'ios', releaseType: '*', config: { video: { activeFps: 6 } } },
      { platform: 'ios', releaseType: 'testflight', config: { video: { idleFps: 0.5 }, message: 'Thanks for testing!' } },
    ]);
    const res = await h.app.request('/api/v1/sdk/config?platform=ios&releaseType=testflight', { headers: sdkHeaders() });
    expect(res.status).toBe(200);
    const cfg = await res.json() as any;
    expect(cfg.video).toEqual({ ...DEFAULT_SDK_CONFIG.video, idleFps: 0.5, activeFps: 6 });
    expect(cfg.message).toBe('Thanks for testing!');
    const etag = res.headers.get('etag')!;
    const again = await h.app.request('/api/v1/sdk/config?platform=ios&releaseType=testflight', { headers: sdkHeaders({ 'if-none-match': etag }) });
    expect(again.status).toBe(304);
  });

  it('disables the SDK for release types the project does not accept', async () => {
    const h = await harness();
    const res = await h.app.request('/api/v1/sdk/config?platform=ios&releaseType=appstore', { headers: sdkHeaders() });
    expect((await res.json() as any).enabled).toBe(false);
  });

  it('turns video off for a device reporting a capture crash loop', async () => {
    const h = await harness();
    const res = await h.app.request('/api/v1/sdk/config?platform=ios&releaseType=debug&health=crashloop', { headers: sdkHeaders() });
    const cfg = await res.json() as any;
    expect(cfg.video.captureMode).toBe('off');
    expect(cfg.enabled).toBe(true);
  });

  it('validates the query', async () => {
    const h = await harness();
    expect((await h.app.request('/api/v1/sdk/config?platform=windows&releaseType=debug', { headers: sdkHeaders() })).status).toBe(422);
  });
});

describe('end to end helper', () => {
  it('sendReport produces a complete ticket with stored attachments', async () => {
    const h = await harness();
    const id = await sendReport(h);
    expect(h.deps.tickets.attachments(id).every((a) => a.state === 'stored')).toBe(true);
  });
});
