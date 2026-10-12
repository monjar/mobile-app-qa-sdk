/**
 * SDK installs, from their remote-config fetches (feature `checkin`): which
 * builds actually run Snitch, with what release-type verdict, and whether they
 * ever sent anything. The installId is random per install, so a row says
 * nothing about the person holding the device.
 */
import type { BuildView, DeviceList, DeviceListQuery, DeviceView, Platform, ReleaseType, SdkConfigQuery } from '@snitch/contract';
import type { Db } from '../db/open';
import { DAY_MS, type Clock } from '../util/clock';

interface InstallRow {
  project_id: string;
  install_id: string;
  platform: Platform;
  release_type: ReleaseType;
  app_id: string | null;
  app_version: string | null;
  build: string | null;
  os: string | null;
  model: string | null;
  sdk_version: string | null;
  wrapper: string | null;
  signals: string | null;
  active: number;
  health: 'ok' | 'crashloop' | null;
  config_enabled: number;
  first_seen_at: number;
  last_seen_at: number;
  checkins: number;
}

export const DEVICE_LIST_DEFAULT_DAYS = 30;
export const DEVICE_LIST_DEFAULT_LIMIT = 200;
/** Installs not seen for this long are forgotten by the retention sweep. */
export const INSTALL_RETENTION_MS = 180 * DAY_MS;

export class InstallsRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  /** Records one config fetch; the latest values win, first-seen and the count accumulate. */
  checkin(projectId: string, q: SdkConfigQuery & { installId: string }, configEnabled: boolean): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO installs (project_id, install_id, platform, release_type, app_id, app_version, build, os, model, sdk_version, wrapper, signals,
           active, health, config_enabled, first_seen_at, last_seen_at, checkins)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (project_id, install_id) DO UPDATE SET
           platform = excluded.platform, release_type = excluded.release_type, app_id = excluded.app_id,
           app_version = excluded.app_version, build = excluded.build, os = excluded.os, model = excluded.model,
           sdk_version = excluded.sdk_version, wrapper = excluded.wrapper, signals = excluded.signals,
           active = excluded.active, health = excluded.health, config_enabled = excluded.config_enabled,
           last_seen_at = excluded.last_seen_at, checkins = installs.checkins + 1`,
      )
      .run(
        projectId,
        q.installId,
        q.platform,
        q.releaseType,
        q.appId ?? null,
        q.appVersion ?? null,
        q.build ?? null,
        q.os ?? null,
        q.model ?? null,
        q.sdkVersion ?? null,
        q.wrapper ?? null,
        q.signals ?? null,
        q.active === '0' ? 0 : 1,
        q.health ?? null,
        configEnabled ? 1 : 0,
        t,
        t,
      );
  }

  list(projectId: string, q: DeviceListQuery): DeviceList {
    const where = ['i.project_id = ?', 'i.last_seen_at >= ?'];
    const args: unknown[] = [projectId, this.now() - (q.sinceDays ?? DEVICE_LIST_DEFAULT_DAYS) * DAY_MS];
    if (q.platform) (where.push('i.platform = ?'), args.push(q.platform));
    if (q.releaseType) (where.push('i.release_type = ?'), args.push(q.releaseType));
    const filter = where.join(' AND ');

    const rows = this.db
      .prepare(
        `SELECT i.*, (SELECT COUNT(*) FROM tickets t WHERE t.project_id = i.project_id AND t.install_id = i.install_id) AS reports
         FROM installs i WHERE ${filter} ORDER BY i.last_seen_at DESC, i.install_id LIMIT ?`,
      )
      .all(...args, q.limit ?? DEVICE_LIST_DEFAULT_LIMIT) as (InstallRow & { reports: number })[];

    // Builds cover every matching install, not just the page of items. An install
    // that never said which version it runs can't be placed under a build.
    const groups = this.db
      .prepare(
        `SELECT i.platform, i.app_version, i.build, i.release_type, i.active, COUNT(*) AS n, MAX(i.last_seen_at) AS last_seen_at
         FROM installs i WHERE ${filter} AND i.app_version IS NOT NULL AND i.build IS NOT NULL
         GROUP BY i.platform, i.app_version, i.build, i.release_type, i.active`,
      )
      .all(...args) as { platform: Platform; app_version: string; build: string; release_type: ReleaseType; active: number; n: number; last_seen_at: number }[];
    const reportCounts = new Map(
      (
        this.db
          .prepare('SELECT platform, app_version, app_build, COUNT(*) AS n FROM tickets WHERE project_id = ? GROUP BY platform, app_version, app_build')
          .all(projectId) as { platform: string; app_version: string; app_build: string; n: number }[]
      ).map((r) => [buildKey(r.platform, r.app_version, r.app_build), r.n]),
    );
    const builds = new Map<string, BuildView>();
    for (const g of groups) {
      const key = buildKey(g.platform, g.app_version, g.build);
      let b = builds.get(key);
      if (!b) {
        b = { platform: g.platform, appVersion: g.app_version, build: g.build, installs: 0, releaseTypes: {}, inactive: 0, reports: reportCounts.get(key) ?? 0, lastSeenAt: 0 };
        builds.set(key, b);
      }
      b.installs += g.n;
      b.releaseTypes[g.release_type] = (b.releaseTypes[g.release_type] ?? 0) + g.n;
      if (g.active === 0) b.inactive += g.n;
      b.lastSeenAt = Math.max(b.lastSeenAt, g.last_seen_at);
    }

    return {
      items: rows.map(toDeviceView),
      builds: [...builds.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    };
  }

  /** Forgets installs last seen before `cutoff`; returns how many. */
  purge(cutoff: number): number {
    return this.db.prepare('DELETE FROM installs WHERE last_seen_at < ?').run(cutoff).changes;
  }
}

function buildKey(platform: string, version: string, build: string): string {
  return JSON.stringify([platform, version, build]);
}

function toDeviceView(r: InstallRow & { reports: number }): DeviceView {
  return {
    installId: r.install_id,
    platform: r.platform,
    releaseType: r.release_type,
    appId: r.app_id,
    appVersion: r.app_version,
    build: r.build,
    os: r.os,
    model: r.model,
    sdkVersion: r.sdk_version,
    wrapper: r.wrapper,
    signals: r.signals,
    active: r.active === 1,
    health: r.health,
    configEnabled: r.config_enabled === 1,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    checkins: r.checkins,
    reports: r.reports,
  };
}
