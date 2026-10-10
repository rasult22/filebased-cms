// Где лежат catalog.json и загруженные фото.
//  - На Vercel: в GitHub-репозитории. Каждое сохранение — один коммит (каталог + новые фото),
//    Vercel видит пуш и пересобирает сайт.
//  - Локально (`npm run dev` без GITHUB_TOKEN): файлы data/catalog.json и public/uploads/,
//    dev-сервер подхватывает их сразу.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface Snapshot {
  text: string;
  /** Версия catalog.json для If-Match: sha блоба в GitHub или хеш локального файла. */
  version: string;
  /** Коммит, от которого прочитан каталог (только GitHub). */
  head?: string;
}

export interface Change {
  /** Новый catalog.json; не задан — каталог не меняется. */
  catalogText?: string;
  /** Новые файлы; путь от корня сайта: /uploads/name.webp */
  add: { path: string; data: Buffer }[];
  /** Файлы, которые больше не нужны, — те же пути от корня сайта. */
  remove: string[];
}

export interface Written {
  version: string;
  commit?: { sha: string; url: string };
}

export type DeployState = 'queued' | 'pending' | 'in_progress' | 'success' | 'failure' | 'error' | 'inactive';

export interface Storage {
  kind: 'github' | 'file';
  read(): Promise<Snapshot>;
  commit(base: Snapshot, change: Change, message: string): Promise<Written>;
  /** Состояние сборки, запущенной коммитом. */
  deployment(sha: string): Promise<{ state: DeployState; url?: string; logUrl?: string }>;
}

const CONFLICT = 'Каталог в репозитории изменился — загрузите свежую версию и повторите';

class GitHubStorage implements Storage {
  kind = 'github' as const;
  private catalogPath: string;

  constructor(
    private token: string,
    private repo: string,
    private branch: string,
    private siteDir: string,
  ) {
    this.catalogPath = `${siteDir}/data/catalog.json`;
  }

  /** Путь в репозитории для файла из public/: /uploads/a.webp → site-vercel/public/uploads/a.webp */
  private publicPath = (sitePath: string) => `${this.siteDir}/public${sitePath}`;

  private async api(apiPath: string, init: RequestInit & { allow404?: boolean; conflictOn?: number[] } = {}) {
    const { allow404, conflictOn = [409], ...request } = init;
    const res = await fetch(`https://api.github.com/repos/${this.repo}${apiPath}`, {
      ...request,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'filebased-cms',
        ...(request.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    if (allow404 && res.status === 404) return null;
    const data = await res.json().catch(() => ({}));
    if (conflictOn.includes(res.status)) throw new HttpError(409, CONFLICT);
    if (!res.ok) throw new HttpError(502, `GitHub API ответил ${res.status}: ${data.message ?? res.statusText}`);
    return data;
  }

  private post = (apiPath: string, body: unknown, extra: { conflictOn?: number[] } = {}) =>
    this.api(apiPath, { method: 'POST', body: JSON.stringify(body), ...extra });

  async read(): Promise<Snapshot> {
    const ref = await this.api(`/git/ref/heads/${encodeURIComponent(this.branch)}`);
    const head: string = ref.object.sha;
    const file = await this.api(`/contents/${this.catalogPath}?ref=${head}`);
    return { text: Buffer.from(file.content, 'base64').toString('utf8'), version: file.sha, head };
  }

  async commit(base: Snapshot, change: Change, message: string): Promise<Written> {
    const head = base.head!;
    const tree: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = [];
    let version = base.version;

    if (change.catalogText !== undefined) {
      const blob = await this.post('/git/blobs', { content: change.catalogText, encoding: 'utf-8' });
      tree.push({ path: this.catalogPath, mode: '100644', type: 'blob', sha: blob.sha });
      version = blob.sha;
    }
    for (const file of change.add) {
      const blob = await this.post('/git/blobs', { content: file.data.toString('base64'), encoding: 'base64' });
      tree.push({ path: this.publicPath(file.path), mode: '100644', type: 'blob', sha: blob.sha });
    }
    if (change.remove.length) {
      // Удалять можно только то, что реально лежит в репозитории.
      const dirs = new Set(change.remove.map((p) => path.posix.dirname(p)));
      const existing = new Set<string>();
      for (const dir of dirs) {
        const list = await this.api(`/contents/${this.publicPath(dir)}?ref=${head}`, { allow404: true });
        for (const entry of Array.isArray(list) ? list : []) existing.add(entry.path);
      }
      for (const sitePath of change.remove) {
        const repoPath = this.publicPath(sitePath);
        if (existing.has(repoPath)) tree.push({ path: repoPath, mode: '100644', type: 'blob', sha: null });
      }
    }

    const headCommit = await this.api(`/git/commits/${head}`);
    const newTree = await this.post('/git/trees', { base_tree: headCommit.tree.sha, tree });
    const commit = await this.post('/git/commits', { message, tree: newTree.sha, parents: [head] });
    // Без force: если ветка ушла вперёд, GitHub вернёт 422 — это конфликт, а не ошибка.
    await this.api(`/git/refs/heads/${encodeURIComponent(this.branch)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: false }),
      conflictOn: [409, 422],
    });
    return { version, commit: { sha: commit.sha, url: commit.html_url } };
  }

  // Vercel публикует статус сборки как GitHub Deployment для коммита.
  async deployment(sha: string) {
    const deployments = await this.api(`/deployments?sha=${sha}&per_page=1`);
    if (!deployments.length) return { state: 'queued' as const };
    const [status] = await this.api(`/deployments/${deployments[0].id}/statuses?per_page=1`);
    if (!status) return { state: 'pending' as const };
    return { state: status.state as DeployState, url: status.environment_url || undefined, logUrl: status.log_url || status.target_url || undefined };
  }
}

const hash = (text: string) => createHash('sha1').update(text).digest('hex');

async function writeAtomic(file: string, data: string | Buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

class FileStorage implements Storage {
  kind = 'file' as const;
  private catalogFile = path.resolve('data/catalog.json');
  private publicFile = (sitePath: string) => path.resolve('public', `.${sitePath}`);

  async read(): Promise<Snapshot> {
    const text = await readFile(this.catalogFile, 'utf8');
    return { text, version: hash(text) };
  }

  async commit(base: Snapshot, change: Change): Promise<Written> {
    for (const file of change.add) await writeAtomic(this.publicFile(file.path), file.data);
    for (const sitePath of change.remove) await rm(this.publicFile(sitePath), { force: true });
    if (change.catalogText === undefined) return { version: base.version };
    await writeAtomic(this.catalogFile, change.catalogText);
    return { version: hash(change.catalogText) };
  }

  async deployment() {
    return { state: 'success' as const };
  }
}

export function getStorage(): Storage {
  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH = 'main', SITE_DIR = 'site-vercel' } = process.env;
  if (GITHUB_TOKEN && GITHUB_REPO) return new GitHubStorage(GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH, SITE_DIR);
  if (process.env.VERCEL) throw new HttpError(503, 'Хранилище не настроено: задайте GITHUB_TOKEN и GITHUB_REPO');
  return new FileStorage();
}
