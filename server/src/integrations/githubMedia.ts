/**
 * `repo` media for GitHub issues: commits a report's files to the snitch-media
 * branch so the issue can show them, behind the repository's own access
 * control. GitHub has no API for issue attachments; a file in the repo is the
 * only place an issue can load an image from without making it public.
 *
 * One commit per report, through the Git data API (blobs → tree on top of the
 * branch → commit → move the branch), under <KEY>/ (MOCH-42/screenshot.jpg).
 * Links point at the commit, so they keep working whatever happens to the
 * branch later. A race with another upload (the branch moved) is retried once.
 *
 * Every file stays in git history: deleting a ticket in Snitch doesn't remove
 * it from GitHub. `mediaRepo` puts it in another repository so the app's own
 * clones don't download it.
 */
import { GITHUB_MEDIA_BRANCH, type GithubConfig } from '@snitch/contract';
import type { Deps } from '../deps';
import type { AttachmentRow } from '../repo/tickets';
import { classifyHttp, SendError } from './errors';
import { githubApiBase, githubHeaders } from './github';

export interface MediaFile {
  /** Path under the ticket's folder, e.g. screenshot.jpg. */
  name: string;
  content: Buffer;
}

export interface UploadedMedia {
  /** Attachment name → a URL that renders (images) or opens (anything else) for people who can see the repo. */
  urls: Record<string, string>;
  repo: string;
  commitSha: string;
}

/** Bigger files would make the issue slow to load and the branch heavy; they stay in Snitch. */
export const MAX_REPO_FILE_BYTES = 30 * 1024 * 1024;

export function mediaRepo(cfg: GithubConfig): { owner: string; repo: string } {
  if (cfg.mediaRepo) {
    const [owner, repo] = cfg.mediaRepo.split('/') as [string, string];
    return { owner, repo };
  }
  return { owner: cfg.owner, repo: cfg.repo };
}

/** The attachments worth putting in the issue, with file names: screenshot, video, timeline, logs. */
export function mediaFiles(attachments: AttachmentRow[]): AttachmentRow[] {
  return attachments.filter(
    (a) => a.state === 'stored' && a.storage_key && (a.size_bytes ?? 0) <= MAX_REPO_FILE_BYTES && (a.content_type.startsWith('image/') || a.content_type === 'video/mp4' || a.content_type === 'application/x-ndjson' || a.content_type.startsWith('text/')),
  );
}

const EXTENSIONS: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'video/mp4': '.mp4', 'application/x-ndjson': '.ndjson' };

export function mediaFileName(a: AttachmentRow): string {
  return `${a.name}${EXTENSIONS[a.content_type] ?? '.txt'}`;
}

/** Commits `files` under `<folder>/` and returns their URLs. Throws SendError (retryable or not). */
export async function uploadToRepo(deps: Deps, cfg: GithubConfig, token: string, folder: string, files: MediaFile[]): Promise<UploadedMedia> {
  const { owner, repo } = mediaRepo(cfg);
  const api = `${githubApiBase(cfg)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  interface Reply<T> {
    res: Response;
    data: T | null;
    text: string;
  }
  const call = async <T>(method: string, path: string, what: string, body?: unknown, timeoutMs = 20_000): Promise<Reply<T>> => {
    let res: Response;
    try {
      res = await deps.fetch(`${api}${path}`, {
        method,
        headers: githubHeaders(token),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new SendError(`GitHub ${what} failed: ${(e as Error).message}`, true);
    }
    const text = await res.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      data = null;
    }
    return { res, data, text };
  };
  const ok = <T>(r: Reply<T>, what: string): T => {
    if (r.res.ok && r.data !== null) return r.data;
    throw classifyHttp(r.res, `GitHub ${what}`, r.text);
  };

  const repoInfo = ok(await call<{ html_url: string }>('GET', '', 'repository lookup'), 'repository lookup');
  const blobs: { path: string; sha: string }[] = [];
  for (const f of files) {
    const blob = ok(
      await call<{ sha: string }>('POST', '/git/blobs', `upload of ${f.name}`, { content: f.content.toString('base64'), encoding: 'base64' }, 120_000),
      `upload of ${f.name}`,
    );
    blobs.push({ path: `${folder}/${f.name}`, sha: blob.sha });
  }

  for (let attempt = 1; ; attempt++) {
    const ref = await call<{ object: { sha: string } }>('GET', `/git/ref/heads/${GITHUB_MEDIA_BRANCH}`, 'branch lookup');
    const head = ref.res.status === 404 ? null : ok(ref, 'branch lookup').object.sha;
    const baseTree = head ? ok(await call<{ tree: { sha: string } }>('GET', `/git/commits/${head}`, 'commit lookup'), 'commit lookup').tree.sha : null;
    const tree = ok(
      await call<{ sha: string }>('POST', '/git/trees', 'tree', {
        ...(baseTree ? { base_tree: baseTree } : {}),
        tree: blobs.map((b) => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
      }),
      'tree',
    );
    const commit = ok(
      await call<{ sha: string }>('POST', '/git/commits', 'commit', { message: `${folder}: media from Snitch`, tree: tree.sha, parents: head ? [head] : [] }),
      'commit',
    );
    const moved = head
      ? await call('PATCH', `/git/refs/heads/${GITHUB_MEDIA_BRANCH}`, 'branch update', { sha: commit.sha, force: false })
      : await call('POST', '/git/refs', 'branch creation', { ref: `refs/heads/${GITHUB_MEDIA_BRANCH}`, sha: commit.sha });
    // 422: the branch moved (or appeared) since we looked; build on the new head once.
    if (moved.res.status === 422 && attempt === 1) continue;
    if (!moved.res.ok) throw classifyHttp(moved.res, 'GitHub branch update', moved.text);

    const urls: Record<string, string> = {};
    for (const b of blobs) {
      const name = b.path.slice(folder.length + 1);
      urls[name] = `${repoInfo.html_url}/blob/${commit.sha}/${b.path.split('/').map(encodeURIComponent).join('/')}?raw=true`;
    }
    return { urls, repo: `${owner}/${repo}`, commitSha: commit.sha };
  }
}
