/* eslint-disable @typescript-eslint/no-explicit-any -- test bodies are asserted field by field */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AttachmentPartial, CHUNK_BYTES_MAX, DEFAULT_SDK_CONFIG, ReportCreated, SERVER_FEATURES } from '@snitch/contract';
import { deleteTicket, drain } from '../src/worker/worker';
import { partialDir, partialPath } from '../src/storage/partials';
import { harness, INGEST_KEY, jpeg, mp4, postReport, putAttachment, putChunk, report, sdkHeaders, sendReport, sha256, type Harness } from './helpers';

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
      { name: 'screenshot', state: 'missing', receivedBytes: 0 },
      { name: 'video', state: 'missing', receivedBytes: 0 },
    ]);
    expect(created.upload).toEqual({ resumable: true, chunkBytes: 1024 * 1024 });

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

describe('device check-ins', () => {
  const installId = '3d8e6c1a-2b4f-4e5d-8a9b-0c1d2e3f4a5b';
  const checkinQuery = (extra: Record<string, string> = {}) =>
    new URLSearchParams({
      platform: 'ios',
      releaseType: 'testflight',
      appVersion: '1.4.0',
      build: '210',
      os: '18.2',
      installId,
      appId: 'app.mochiro',
      sdkVersion: '0.3.0',
      wrapper: 'react-native',
      model: 'iPhone16,2',
      signals: 'sim=0;profile=none;devices=0;receipt=sandboxReceipt;at=sandbox',
      active: '1',
      ...extra,
    }).toString();

  it('lists the server features in every config, without breaking the ETag', async () => {
    const h = await harness();
    const res = await h.app.request('/api/v1/sdk/config?platform=ios&releaseType=debug', { headers: sdkHeaders() });
    const cfg = (await res.json()) as any;
    expect(cfg.features).toEqual([...SERVER_FEATURES]);
    expect(cfg.timeline).toEqual(DEFAULT_SDK_CONFIG.timeline);
    const again = await h.app.request('/api/v1/sdk/config?platform=ios&releaseType=debug', { headers: sdkHeaders({ 'if-none-match': res.headers.get('etag')! }) });
    expect(again.status).toBe(304);
    // Features are never stored with the project's config.
    expect(h.deps.projects.sdkConfigEntries(h.projectId)).toEqual([]);
  });

  it('records one row per install with the latest values', async () => {
    const h = await harness();
    expect((await h.app.request(`/api/v1/sdk/config?${checkinQuery()}`, { headers: sdkHeaders() })).status).toBe(200);
    h.clock.t += 60_000;
    // A 304 is still a check-in.
    const etag = (await h.app.request(`/api/v1/sdk/config?${checkinQuery({ build: '211' })}`, { headers: sdkHeaders() })).headers.get('etag')!;
    h.clock.t += 60_000;
    expect((await h.app.request(`/api/v1/sdk/config?${checkinQuery({ build: '211' })}`, { headers: sdkHeaders({ 'if-none-match': etag }) })).status).toBe(304);
    const row = h.deps.db.prepare('SELECT * FROM installs').get() as any;
    expect(row).toMatchObject({
      install_id: installId,
      platform: 'ios',
      release_type: 'testflight',
      app_id: 'app.mochiro',
      app_version: '1.4.0',
      build: '211',
      os: '18.2',
      model: 'iPhone16,2',
      sdk_version: '0.3.0',
      wrapper: 'react-native',
      active: 1,
      health: null,
      config_enabled: 1,
      checkins: 3,
      first_seen_at: Date.parse('2026-10-07T12:00:00Z'),
      last_seen_at: Date.parse('2026-10-07T12:02:00Z'),
    });
  });

  it('records inert pings and what the install was told', async () => {
    const h = await harness();
    await h.app.request(`/api/v1/sdk/config?${checkinQuery({ releaseType: 'unknown', active: '0' })}`, { headers: sdkHeaders() });
    expect(h.deps.db.prepare('SELECT active, config_enabled, release_type FROM installs').get()).toEqual({ active: 0, config_enabled: 0, release_type: 'unknown' });
    await h.app.request(`/api/v1/sdk/config?${checkinQuery({ health: 'crashloop' })}`, { headers: sdkHeaders() });
    expect(h.deps.db.prepare('SELECT active, config_enabled, health FROM installs').get()).toEqual({ active: 1, config_enabled: 1, health: 'crashloop' });
    // No installId, no row.
    await h.app.request('/api/v1/sdk/config?platform=android&releaseType=debug', { headers: sdkHeaders() });
    expect(h.deps.db.prepare('SELECT COUNT(*) AS n FROM installs').get()).toEqual({ n: 1 });
  });

  it('stores the install id and screen on tickets', async () => {
    const h = await harness();
    const id = await sendReport(h, {}, { installId, screen: '  Settings  ' });
    expect(h.deps.tickets.get(id)).toMatchObject({ install_id: installId, screen: 'Settings' });
  });
});

describe('chunked upload', () => {
  const CHUNK = 64 * 1024;
  const chunked = () => harness({ config: { uploadChunkBytes: CHUNK } });
  async function create(h: Harness, video: Buffer) {
    const res = await postReport(h, report({ video }));
    return ReportCreated.parse(await res.json());
  }
  const part = (h: Harness, reportId: string) => partialPath(h.deps.config.dataDir, h.deps.tickets.attachment(reportId, 'video')!.id);

  it('assembles chunks, verifies the whole file and stores it', async () => {
    const h = await chunked();
    const video = mp4(200_000);
    const created = await create(h, video);
    expect(created.upload).toEqual({ resumable: true, chunkBytes: CHUNK });
    const first = await putChunk(h, created.reportId, 'video', video, 'video/mp4', 0, CHUNK - 1);
    expect(first.status).toBe(202);
    expect(AttachmentPartial.parse(await first.json())).toEqual({ name: 'video', state: 'partial', receivedBytes: CHUNK });
    expect(readFileSync(part(h, created.reportId))).toEqual(video.subarray(0, CHUNK));
    expect(h.deps.tickets.attachment(created.reportId, 'video')!.received_bytes).toBe(CHUNK);
    expect((await putChunk(h, created.reportId, 'video', video, 'video/mp4', CHUNK, 2 * CHUNK - 1)).status).toBe(202);
    const last = await putChunk(h, created.reportId, 'video', video, 'video/mp4', 2 * CHUNK, video.length - 1);
    expect(last.status).toBe(201);
    expect(await last.json()).toEqual({ name: 'video', state: 'stored', sizeBytes: video.length });
    expect(existsSync(part(h, created.reportId))).toBe(false);
    const att = h.deps.tickets.attachment(created.reportId, 'video')!;
    expect(att).toMatchObject({ state: 'stored', sha256: sha256(video), size_bytes: video.length });
    expect((await h.deps.blobs.readAll(att.storage_key!)).equals(video)).toBe(true);
    // The answer to the last chunk was lost and the client sends it again.
    expect((await putChunk(h, created.reportId, 'video', video, 'video/mp4', 2 * CHUNK, video.length - 1)).status).toBe(200);
    expect((await h.app.request(`/api/v1/reports/${created.reportId}/complete`, { method: 'POST', headers: sdkHeaders() })).status).toBe(200);
  });

  it('tells a client that lost its place where to resume', async () => {
    const h = await chunked();
    const video = mp4(150_000);
    const created = await create(h, video);
    await putChunk(h, created.reportId, 'video', video, 'video/mp4', 0, CHUNK - 1);
    const again = await putChunk(h, created.reportId, 'video', video, 'video/mp4', 0, CHUNK - 1);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'range_mismatch', details: { receivedBytes: CHUNK } } });
    const ahead = await putChunk(h, created.reportId, 'video', video, 'video/mp4', 2 * CHUNK, video.length - 1);
    expect((await ahead.json() as any).error.details.receivedBytes).toBe(CHUNK);
    // The idempotent create reports the offset too.
    const recreated = await postReport(h, { ...report({ video }), clientReportId: (h.deps.tickets.get(created.reportId)!).client_report_id });
    expect(recreated.status).toBe(200);
    const body = ReportCreated.parse(await recreated.json());
    expect(body.attachments).toEqual([{ name: 'video', state: 'missing', receivedBytes: CHUNK }]);
    expect(body.upload).toEqual({ resumable: true, chunkBytes: CHUNK });
    expect((await putChunk(h, created.reportId, 'video', video, 'video/mp4', CHUNK, 2 * CHUNK - 1)).status).toBe(202);
    expect((await putChunk(h, created.reportId, 'video', video, 'video/mp4', 2 * CHUNK, video.length - 1)).status).toBe(201);
  });

  it('rejects a chunk that changed on the wire without appending it', async () => {
    const h = await chunked();
    const video = mp4(100_000);
    const created = await create(h, video);
    const bad = await putChunk(h, created.reportId, 'video', video, 'video/mp4', 0, CHUNK - 1, { 'x-chunk-sha256': sha256(Buffer.from('other')) });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ error: { code: 'hash_mismatch', details: { chunk: true } } });
    expect(existsSync(part(h, created.reportId)) ? readFileSync(part(h, created.reportId)).length : 0).toBe(0);
    expect(h.deps.tickets.attachment(created.reportId, 'video')!.received_bytes).toBe(0);
    expect((await putChunk(h, created.reportId, 'video', video, 'video/mp4', 0, CHUNK - 1)).status).toBe(202);
  });

  it('accepts chunks without X-Chunk-SHA256 and catches a bad file at the end, then starts over', async () => {
    const h = await chunked();
    const video = mp4(100_000);
    const created = await create(h, video);
    const other = Buffer.from(video);
    other[CHUNK + 10] = 0xee;
    // Each chunk matches its own hash, but together they are not the declared file.
    expect((await putChunk(h, created.reportId, 'video', other, 'video/mp4', 0, CHUNK - 1, { 'x-content-sha256': sha256(video) })).status).toBe(202);
    const last = await putChunk(h, created.reportId, 'video', other, 'video/mp4', CHUNK, other.length - 1, { 'x-content-sha256': sha256(video), 'x-chunk-sha256': '' });
    // An empty X-Chunk-SHA256 is malformed, not "absent".
    expect(last.status).toBe(422);
    const lastNoChunkHash = await h.app.request(`/api/v1/reports/${created.reportId}/attachments/video`, {
      method: 'PUT',
      headers: {
        'x-snitch-key': INGEST_KEY,
        'content-type': 'video/mp4',
        'content-length': String(other.length - CHUNK),
        'content-range': `bytes ${CHUNK}-${other.length - 1}/${other.length}`,
        'x-content-sha256': sha256(video),
      },
      body: other.subarray(CHUNK),
    });
    expect(lastNoChunkHash.status).toBe(422);
    const err = (await lastNoChunkHash.json() as any).error;
    expect(err.code).toBe('hash_mismatch');
    expect(err.details).toBeUndefined();
    expect(existsSync(part(h, created.reportId))).toBe(false);
    expect(h.deps.tickets.attachment(created.reportId, 'video')!.received_bytes).toBe(0);
    // From the start, with the right bytes.
    expect((await putChunk(h, created.reportId, 'video', video, 'video/mp4', 0, CHUNK - 1)).status).toBe(202);
    expect((await putChunk(h, created.reportId, 'video', video, 'video/mp4', CHUNK, video.length - 1)).status).toBe(201);
  });

  it('validates the range headers', async () => {
    const h = await chunked();
    const video = mp4(100_000);
    const created = await create(h, video);
    const id = created.reportId;
    const code = async (r: Response) => [r.status, (await r.json() as any).error.code];
    expect(await code(await putChunk(h, id, 'video', video, 'video/mp4', 0, CHUNK - 1, { 'content-range': `bytes 0-${CHUNK - 1}/${video.length + 1}` }))).toEqual([422, 'invalid_request']);
    expect(await code(await putChunk(h, id, 'video', video, 'video/mp4', 0, CHUNK - 1, { 'content-range': 'bytes */100000' }))).toEqual([422, 'invalid_request']);
    expect(await code(await putChunk(h, id, 'video', video, 'video/mp4', 0, CHUNK - 1, { 'content-length': String(CHUNK - 1) }))).toEqual([422, 'invalid_request']);
    expect(await code(await putChunk(h, id, 'video', video, 'video/mp4', 0, CHUNK - 1, { 'x-content-sha256': sha256(Buffer.from('x')) }))).toEqual([422, 'hash_mismatch']);
    expect(await code(await putChunk(h, id, 'video', video, 'video/mp4', 0, CHUNK - 1, { 'content-type': 'image/jpeg' }))).toEqual([415, 'unsupported_media_type']);
    // A chunk bigger than any server may ask for is refused before its body is read.
    const big = await postReport(h, report({}, { attachments: [{ name: 'video', contentType: 'video/mp4', sizeBytes: CHUNK_BYTES_MAX + 10, sha256: sha256(video), durationMs: 1000 }] }));
    const bigId = ((await big.json()) as any).reportId;
    const tooBig = await h.app.request(`/api/v1/reports/${bigId}/attachments/video`, {
      method: 'PUT',
      headers: { 'x-snitch-key': INGEST_KEY, 'content-type': 'video/mp4', 'content-length': String(CHUNK_BYTES_MAX + 1), 'content-range': `bytes 0-${CHUNK_BYTES_MAX}/${CHUNK_BYTES_MAX + 10}`, 'x-content-sha256': sha256(video) },
      body: Buffer.alloc(1),
    });
    expect(await code(tooBig)).toEqual([413, 'payload_too_large']);
    // Not an MP4: refused at the first chunk.
    const junk = Buffer.alloc(100_000, 1);
    const junkReport = await create(h, junk);
    expect(await code(await putChunk(h, junkReport.reportId, 'video', junk, 'video/mp4', 0, CHUNK - 1))).toEqual([422, 'magic_mismatch']);
    expect(h.deps.tickets.attachment(id, 'video')!.received_bytes).toBe(0);
  });

  it('a whole-file PUT replaces a partial upload', async () => {
    const h = await chunked();
    const video = mp4(100_000);
    const created = await create(h, video);
    await putChunk(h, created.reportId, 'video', video, 'video/mp4', 0, CHUNK - 1);
    expect(existsSync(part(h, created.reportId))).toBe(true);
    expect((await putAttachment(h, created.reportId, 'video', video, 'video/mp4')).status).toBe(201);
    expect(existsSync(part(h, created.reportId))).toBe(false);
    expect(h.deps.tickets.attachment(created.reportId, 'video')!.state).toBe('stored');
  });

  it('is not throttled by the per-report limits', async () => {
    const h = await harness({ config: { uploadChunkBytes: CHUNK, limits: { reportsPerKeyPerHour: 1, reportsPerIpPer10Min: 1, configPerIpPerHour: 1, loginPerIpPer15Min: 1 } } });
    const video = mp4(5 * CHUNK);
    const created = await create(h, video);
    for (let start = 0; start < video.length; start += CHUNK) {
      const r = await putChunk(h, created.reportId, 'video', video, 'video/mp4', start, Math.min(start + CHUNK, video.length) - 1);
      expect(r.status).toBe(start + CHUNK >= video.length ? 201 : 202);
    }
  });

  it('handles one request per attachment at a time', async () => {
    const h = await chunked();
    const video = mp4(100_000);
    const created = await create(h, video);
    const results = await Promise.all([0, 1].map(() => putChunk(h, created.reportId, 'video', video, 'video/mp4', 0, CHUNK - 1)));
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(readFileSync(part(h, created.reportId)).length).toBe(CHUNK);
  });

  it('trusts the partial file over the database after a crash', async () => {
    const h = await chunked();
    const video = mp4(3 * CHUNK + 5);
    const created = await create(h, video);
    await putChunk(h, created.reportId, 'video', video, 'video/mp4', 0, CHUNK - 1);
    // The second chunk reached the disk but the server died before recording it.
    appendFileSync(part(h, created.reportId), video.subarray(CHUNK, 2 * CHUNK));
    const r = await putChunk(h, created.reportId, 'video', video, 'video/mp4', CHUNK, 2 * CHUNK - 1);
    expect(await r.json()).toMatchObject({ error: { code: 'range_mismatch', details: { receivedBytes: 2 * CHUNK } } });
    expect(h.deps.tickets.attachment(created.reportId, 'video')!.received_bytes).toBe(2 * CHUNK);
    // Every byte arrived, but the final verification never ran: the next request finishes it.
    appendFileSync(part(h, created.reportId), video.subarray(2 * CHUNK));
    const done = await putChunk(h, created.reportId, 'video', video, 'video/mp4', 2 * CHUNK, video.length - 1);
    expect(done.status).toBe(201);
  });

  it('cleans up partial files of abandoned, deleted and unknown uploads', async () => {
    const h = await chunked();
    const video = mp4(100_000);
    const abandoned = await create(h, video);
    await putChunk(h, abandoned.reportId, 'video', video, 'video/mp4', 0, CHUNK - 1);
    mkdirSync(partialDir(h.deps.config.dataDir), { recursive: true });
    const orphan = partialPath(h.deps.config.dataDir, 'NOT-AN-ATTACHMENT');
    writeFileSync(orphan, 'left over');
    h.clock.t += 25 * 3600_000;
    const live = await create(h, video);
    await putChunk(h, live.reportId, 'video', video, 'video/mp4', 0, CHUNK - 1);
    h.deps.jobs.enqueue('stale_upload_sweep', {});
    await drain(h.deps);
    expect(h.deps.tickets.get(abandoned.reportId)!.upload_state).toBe('incomplete');
    expect(existsSync(part(h, abandoned.reportId))).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(part(h, live.reportId))).toBe(true);
    const livePart = part(h, live.reportId);
    await deleteTicket(h.deps, live.reportId);
    expect(existsSync(livePart)).toBe(false);
  });
});
