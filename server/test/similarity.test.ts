/* eslint-disable @typescript-eslint/no-explicit-any -- test bodies are asserted field by field */
import { describe, expect, it } from 'vitest';
import type { TicketDetail } from '@snitch/contract';
import { jaccard, rankSimilar, similarity, words, type SimilarityInput } from '../src/util/similarity';
import { adminFetch, harness, login, sendReport } from './helpers';

const base: SimilarityInput = {
  title: 'Chat freezes after sending a photo',
  description: 'Chat freezes after sending a photo from the gallery',
  screen: 'Chat',
  platform: 'ios',
  appVersion: '1.4.0',
  appBuild: '210',
  type: 'bug',
};

describe('similarity scoring', () => {
  it('tokenizes into lowercase words of three or more letters or digits, without stopwords', () => {
    expect([...words('The app CRASHED on iOS 18 when I tapped “Send” — again!')].sort()).toEqual(['app', 'crashed', 'ios', 'send', 'tapped']);
    expect([...words('Überweisung schlägt fehl, 404')].sort()).toEqual(['404', 'fehl', 'schlägt', 'überweisung']);
  });

  it('computes Jaccard over word sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(), new Set(['x']))).toBe(0);
  });

  it('weights text 0.6, screen 0.2, build 0.1, platform 0.05 and type 0.05', () => {
    expect(similarity(base, base)).toEqual({ score: 1, reasons: ['similar description', 'same screen', 'same build', 'same type'] });
    const elsewhere = { ...base, screen: 'Settings', appBuild: '211', type: 'idea' };
    expect(similarity(base, elsewhere)).toEqual({ score: 0.65, reasons: ['similar description', 'same platform'] });
    const unrelated = { ...base, title: 'Login button misaligned', description: 'Login button misaligned on iPad', screen: null, platform: 'android' };
    expect(similarity(base, unrelated)).toEqual({ score: 0.05, reasons: ['same type'] });
    // An unknown screen never matches, not even another unknown one.
    expect(similarity({ ...base, screen: null }, { ...base, screen: null }).reasons).not.toContain('same screen');
  });

  it('keeps matches of at least 0.35, best first, five at most', () => {
    const candidates = [
      { ...base, title: 'unrelated words entirely', description: 'nothing shared here', screen: 'Other', type: 'idea', id: 'low' }, // 0.15
      { ...base, title: 'Totally different', description: 'Nothing alike', id: 'context' }, // screen + build + platform + type = 0.4
      ...Array.from({ length: 6 }, (_, i) => ({ ...base, id: `same-${i}` })),
    ];
    const ranked = rankSimilar(base, candidates);
    expect(ranked).toHaveLength(5);
    expect(ranked.every((r) => r.score === 1)).toBe(true);
    const few = rankSimilar(base, candidates.slice(0, 3));
    expect(few.map((r) => [r.item.id, r.score])).toEqual([
      ['same-0', 1],
      ['context', 0.4],
    ]);
    expect(few[1]!.reasons).toEqual(['same screen', 'same build', 'same type']);
  });
});

describe('similar tickets in the detail', () => {
  it('lists recent open tickets of the same project that look alike', async () => {
    const h = await harness();
    const desc = 'Chat freezes after sending a photo from the gallery';
    const old = await sendReport(h, {}, { description: desc, screen: 'Chat' });
    h.clock.t += 61 * 86_400_000;
    const s = await login(h);
    const twin = await sendReport(h, {}, { description: desc, screen: 'Chat' });
    const closed = await sendReport(h, {}, { description: desc, screen: 'Chat' });
    const unrelated = await sendReport(h, {}, { description: 'Login button misaligned on the iPad settings page', screen: 'Login', type: 'idea' });
    const target = await sendReport(h, {}, { description: `${desc}. Happens every time.`, screen: 'Chat' });
    await adminFetch(h, s, `/tickets/${closed}`, { method: 'PATCH', body: { status: 'resolved' } });
    const other = h.deps.projects.create({ name: 'Other', slug: 'other', ticketPrefix: 'OTH' });
    h.deps.db.prepare('UPDATE tickets SET project_id = ? WHERE id = ?').run(other.id, unrelated);

    const d = (await (await adminFetch(h, s, `/tickets/${target}`)).json()) as TicketDetail;
    // Not the 61-day-old one, the resolved one, the other project's or itself.
    expect(d.similar.map((x) => x.id)).toEqual([twin]);
    expect(d.similar.map((x) => x.id)).not.toContain(old);
    expect(d.similar[0]).toMatchObject({ key: 'MOCH-2', status: 'new', reasons: ['similar description', 'same screen', 'same build', 'same type'] });
    // 0.6 × 5/8 shared words + 0.2 + 0.1 + 0.05 + 0.05
    expect(d.similar[0]!.score).toBe(0.78);

    // Once marked a duplicate of it, the original is no longer suggested.
    const marked = (await (await adminFetch(h, s, `/tickets/${target}`, { method: 'PATCH', body: { duplicateOfId: twin } })).json()) as TicketDetail;
    expect(marked.similar).toEqual([]);
  });

  it('marking a duplicate sets the status and logs it once', async () => {
    const h = await harness();
    const s = await login(h);
    const original = await sendReport(h);
    const dup = await sendReport(h);
    const d = (await (await adminFetch(h, s, `/tickets/${dup}`, { method: 'PATCH', body: { duplicateOfId: original } })).json()) as TicketDetail;
    expect(d.ticket.status).toBe('duplicate');
    expect(d.ticket.duplicateOfId).toBe(original);
    expect(d.events.slice(-2).map((e) => e.kind)).toEqual(['duplicate_marked', 'status_changed']);
    expect(d.events.at(-2)!.data).toEqual({ duplicateOfId: original, key: 'MOCH-1' });
    // Same patch again: nothing new.
    const again = (await (await adminFetch(h, s, `/tickets/${dup}`, { method: 'PATCH', body: { duplicateOfId: original } })).json()) as TicketDetail;
    expect(again.events).toHaveLength(d.events.length);
    // An explicit status wins over the implied one.
    const third = await sendReport(h);
    const t = (await (await adminFetch(h, s, `/tickets/${third}`, { method: 'PATCH', body: { duplicateOfId: original, status: 'triaged' } })).json()) as TicketDetail;
    expect(t.ticket.status).toBe('triaged');
    expect(t.events.filter((e) => e.kind === 'duplicate_marked')).toHaveLength(1);
    // Invalid targets change nothing at all.
    const bad = await adminFetch(h, s, `/tickets/${third}`, { method: 'PATCH', body: { title: 'Renamed', duplicateOfId: third } });
    expect(bad.status).toBe(422);
    expect(h.deps.tickets.get(third)!.title).not.toBe('Renamed');
  });
});
