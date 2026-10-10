// Сервер второго сайта: отдаёт статическую сборку и предоставляет API,
// которое меняет data/content.json и пересобирает страницы.
// Без зависимостей — только встроенные модули Node.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateContent } from './src/lib/validate.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_FILE = path.join(ROOT, 'data', 'content.json');
const HISTORY_DIR = path.join(ROOT, 'data', 'history');
const BUILDS_DIR = path.join(ROOT, '.builds');
const HISTORY_LIMIT = 20;
const MAX_BODY = 1024 * 1024;

const PORT = Number(process.env.PORT) || 4322;
const HOST = process.env.HOST || 'localhost';
const TOKEN = process.env.ADMIN_TOKEN || '';

const require = createRequire(import.meta.url);
const astroPkgPath = require.resolve('astro/package.json');
const ASTRO_BIN = path.join(path.dirname(astroPkgPath), require(astroPkgPath).bin.astro);

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------- сборка

let liveDir = null; // каталог сборки, который сейчас отдаётся посетителям
let lastBuild = null;
let building = false;
let queue = Promise.resolve();

/** Задачи выполняются строго по очереди: запись файла и сборки не пересекаются. */
function exclusive(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

function runAstroBuild(outDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ASTRO_BIN, 'build'], {
      cwd: ROOT,
      env: { ...process.env, ASTRO_OUT_DIR: outDir, ASTRO_TELEMETRY_DISABLED: '1', FORCE_COLOR: '0' },
    });
    let log = '';
    const collect = (chunk) => (log = (log + chunk).slice(-20_000));
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => resolve({ code: -1, log: `${log}\n${err}` }));
    child.on('close', (code) => resolve({ code, log: log.replace(/\x1b\[[0-9;]*m/g, '') }));
  });
}

/** Собирает сайт в новый каталог; при успехе атомарно переключает на него раздачу. */
async function build() {
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(BUILDS_DIR, id);
  const startedAt = Date.now();
  building = true;
  try {
    const { code, log } = await runAstroBuild(outDir);
    const finishedAt = Date.now();
    lastBuild = {
      id,
      ok: code === 0,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      log,
    };
    if (code !== 0) {
      await rm(outDir, { recursive: true, force: true });
      console.error(`[build] ${id} упала:\n${log}`);
      return lastBuild;
    }
    const previous = liveDir;
    liveDir = outDir;
    // Старую сборку удаляем с задержкой — вдруг по ней ещё отдаются файлы.
    if (previous) setTimeout(() => rm(previous, { recursive: true, force: true }).catch(() => {}), 10_000);
    console.log(`[build] ${id} готова за ${lastBuild.durationMs} мс`);
    return lastBuild;
  } finally {
    building = false;
  }
}

const buildSummary = (b) => b && { id: b.id, ok: b.ok, finishedAt: b.finishedAt, durationMs: b.durationMs };

// ---------------------------------------------------------------- контент

async function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

async function saveHistory(text) {
  await mkdir(HISTORY_DIR, { recursive: true });
  await writeFile(path.join(HISTORY_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`), text);
  const files = (await readdir(HISTORY_DIR)).filter((f) => f.endsWith('.json')).sort();
  await Promise.all(files.slice(0, -HISTORY_LIMIT).map((f) => rm(path.join(HISTORY_DIR, f), { force: true })));
}

/**
 * Транзакция над content.json: mutate(текущий) → проверка → запись → сборка.
 * Если сборка упала, файл возвращается к прежней версии, а сайт продолжает отдавать старую сборку.
 */
function commit(mutate) {
  return exclusive(async () => {
    const prevText = await readFile(CONTENT_FILE, 'utf8');
    const next = await mutate(JSON.parse(prevText));

    const errors = validateContent(next);
    if (errors.length) throw new HttpError(422, 'Контент не прошёл проверку', { errors });

    const nextText = JSON.stringify(next, null, 2) + '\n';
    if (nextText === prevText) return { ok: true, unchanged: true, content: next, build: buildSummary(lastBuild) };

    await writeFileAtomic(CONTENT_FILE, nextText);
    const result = await build();
    if (!result.ok) {
      await writeFileAtomic(CONTENT_FILE, prevText);
      throw new HttpError(500, 'Сборка упала — изменения откатаны, сайт не изменился', { log: result.log });
    }
    await saveHistory(prevText);
    return { ok: true, content: next, build: buildSummary(result) };
  });
}

/** JSON Merge Patch (RFC 7396): null удаляет поле, объекты сливаются, остальное заменяется. */
function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

function findPost(content, slug) {
  const posts = Array.isArray(content.posts) ? content.posts : [];
  const index = posts.findIndex((p) => p?.slug === slug);
  if (index === -1) throw new HttpError(404, `Пост «${slug}» не найден`);
  return { posts, index };
}

function requirePostObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Пост должен быть JSON-объектом');
  return body;
}

// ---------------------------------------------------------------- HTTP

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Слишком большое тело запроса');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Тело запроса — не валидный JSON');
  }
}

function requireAuth(req) {
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) throw new HttpError(401, 'Нужен токен: Authorization: Bearer <ADMIN_TOKEN>');
}

async function handleApi(req, res, url) {
  const [resource, slug, ...rest] = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
  const method = req.method;
  if (rest.length) throw new HttpError(404, 'Нет такого метода API');
  if (method !== 'GET') requireAuth(req);

  // /api/content — файл целиком
  if (resource === 'content' && !slug) {
    if (method === 'GET') return sendJson(res, 200, JSON.parse(await readFile(CONTENT_FILE, 'utf8')));
    if (method === 'PUT') {
      const body = await readJson(req);
      return sendJson(res, 200, await commit(() => body));
    }
    if (method === 'PATCH') {
      const patch = await readJson(req);
      return sendJson(res, 200, await commit((current) => mergePatch(current, patch)));
    }
  }

  // /api/posts и /api/posts/:slug — точечные правки постов
  if (resource === 'posts') {
    if (!slug && method === 'GET') {
      const content = JSON.parse(await readFile(CONTENT_FILE, 'utf8'));
      return sendJson(res, 200, content.posts ?? []);
    }
    if (!slug && method === 'POST') {
      const post = requirePostObject(await readJson(req));
      const result = await commit((current) => {
        const posts = Array.isArray(current.posts) ? current.posts : [];
        if (posts.some((p) => p?.slug === post.slug)) throw new HttpError(409, `Пост «${post.slug}» уже существует`);
        return { ...current, posts: [...posts, post] };
      });
      return sendJson(res, 201, result);
    }
    if (slug && method === 'GET') {
      const content = JSON.parse(await readFile(CONTENT_FILE, 'utf8'));
      const { posts, index } = findPost(content, slug);
      return sendJson(res, 200, posts[index]);
    }
    if (slug && (method === 'PUT' || method === 'PATCH')) {
      const body = requirePostObject(await readJson(req));
      const result = await commit((current) => {
        const { posts, index } = findPost(current, slug);
        const updated = method === 'PUT' ? { slug, ...body } : mergePatch(posts[index], body);
        return { ...current, posts: posts.with(index, updated) };
      });
      return sendJson(res, 200, result);
    }
    if (slug && method === 'DELETE') {
      const result = await commit((current) => {
        const { posts, index } = findPost(current, slug);
        return { ...current, posts: posts.toSpliced(index, 1) };
      });
      return sendJson(res, 200, result);
    }
  }

  // /api/rebuild — пересобрать без изменения файла (например, после ручной правки на диске)
  if (resource === 'rebuild' && !slug && method === 'POST') {
    const result = await exclusive(build);
    if (!result.ok) throw new HttpError(500, 'Сборка упала, сайт не изменился', { log: result.log });
    return sendJson(res, 200, { ok: true, build: buildSummary(result) });
  }

  // /api/status — состояние сборки
  if (resource === 'status' && !slug && method === 'GET') {
    return sendJson(res, 200, {
      building,
      live: liveDir && path.basename(liveDir),
      lastBuild: lastBuild && { ...buildSummary(lastBuild), log: lastBuild.ok ? undefined : lastBuild.log },
      authRequired: Boolean(TOKEN),
    });
  }

  throw new HttpError(404, `Нет такого метода API: ${method} ${url.pathname}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const isFile = (file) => stat(file).then((s) => s.isFile(), () => false);

function sendFile(req, res, status, file, immutable = false) {
  res.writeHead(status, {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    // Хешированные ассеты из /_astro/ не меняются; всё остальное перепроверяется после пересборки.
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Метод не поддерживается');
  const root = liveDir; // фиксируем каталог на время запроса — переключение сборки его не заденет
  if (!root) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '3' });
    return res.end('Сайт собирается, обновите страницу через пару секунд…');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'Некорректный путь');
  }
  const target = path.join(root, pathname);
  if (path.relative(root, target).startsWith('..')) throw new HttpError(403, 'Доступ запрещён');

  for (const candidate of [target, path.join(target, 'index.html'), `${target}.html`]) {
    if (await isFile(candidate)) return sendFile(req, res, 200, candidate, pathname.startsWith('/_astro/'));
  }
  const notFound = path.join(root, '404.html');
  if (await isFile(notFound)) return sendFile(req, res, 404, notFound);
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Не найдено');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (err) {
    const known = err instanceof HttpError;
    if (!known) console.error(err);
    if (res.headersSent) return res.end();
    sendJson(res, known ? err.status : 500, { error: known ? err.message : 'Внутренняя ошибка сервера', ...(known ? err.extra : {}) });
  }
});

// ---------------------------------------------------------------- запуск

async function start() {
  await mkdir(BUILDS_DIR, { recursive: true });

  // Пока идёт свежая сборка, отдаём последнюю уцелевшую с прошлого запуска.
  const existing = (await readdir(BUILDS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const name of existing.toReversed()) {
    if (await isFile(path.join(BUILDS_DIR, name, 'index.html'))) {
      liveDir = path.join(BUILDS_DIR, name);
      break;
    }
  }

  server.listen(PORT, HOST, () => {
    console.log(`Сайт:     http://${HOST}:${PORT}/`);
    console.log(`Редактор: http://${HOST}:${PORT}/admin/`);
    console.log(TOKEN ? 'API защищено токеном ADMIN_TOKEN' : 'ADMIN_TOKEN не задан — API открыто для записи');
  });

  // content.json мог поменяться, пока сервер был выключен, — собираем заново.
  await exclusive(build);
  for (const name of existing) {
    const dir = path.join(BUILDS_DIR, name);
    if (dir !== liveDir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
