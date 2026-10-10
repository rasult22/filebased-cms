// API каталога. Единственный маршрут, который выполняется на сервере (функция Vercel);
// все страницы сайта собираются в статику.
import type { APIRoute } from 'astro';
import { ID_RE, validateCatalog } from '../../lib/validate.js';
import { getStorage, HttpError, type Storage } from '../../lib/storage';

export const prerender = false;

type Item = Record<string, any>;
type Catalog = { categories: Item[]; products: Item[] };
type Upload = { path: string; data: Buffer };

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const UPLOAD_PATH_RE = /^\/uploads\/[a-z0-9][a-z0-9-]*\.(webp|jpe?g|png)$/;
const MIME_EXT: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

async function readBody(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Тело запроса — не валидный JSON');
  }
}

function requireObject(body: unknown): Item {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Ожидается JSON-объект');
  return body as Item;
}

function requireAuth(request: Request, storage: Storage) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    // Без токена писать можно только в локальные файлы; в репозиторий — никогда.
    if (storage.kind === 'github') throw new HttpError(503, 'ADMIN_TOKEN не задан — запись отключена');
    return;
  }
  if (request.headers.get('authorization') !== `Bearer ${token}`) {
    throw new HttpError(401, 'Нужен токен: Authorization: Bearer <ADMIN_TOKEN>');
  }
}

/** JSON Merge Patch (RFC 7396): null удаляет поле, объекты сливаются, остальное заменяется. */
function mergePatch(target: any, patch: any): any {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

// Проверяем, что файл действительно картинка заявленного формата, по первым байтам.
function checkImage(data: Buffer, ext: string) {
  const isPng = data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isJpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const isWebp = data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP';
  const ok = ext === 'png' ? isPng : ext === 'webp' ? isWebp : isJpeg;
  if (!ok) throw new HttpError(415, `Файл не похож на ${ext.toUpperCase()}`);
  if (data.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'Фото больше 3 МБ');
}

function parseUploads(raw: unknown): Upload[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'uploads: ожидается список');
  return raw.map((u) => {
    if (!u || typeof u.path !== 'string' || !UPLOAD_PATH_RE.test(u.path) || typeof u.data !== 'string') {
      throw new HttpError(400, 'uploads: нужны path вида /uploads/имя.webp и data в base64');
    }
    const data = Buffer.from(u.data, 'base64');
    checkImage(data, u.path.split('.').pop()!);
    return { path: u.path, data };
  });
}

const uploadRefs = (catalog: Catalog) =>
  new Set(catalog.products.map((p) => p?.image).filter((img): img is string => typeof img === 'string' && img.startsWith('/uploads/')));

/**
 * Чтение → mutate → проверка → один коммит с каталогом, новыми фото и удалением ненужных.
 * If-Match защищает от затирания чужих правок: если каталог изменился после загрузки — 409.
 */
async function save(storage: Storage, request: Request, message: string, mutate: (c: Catalog) => unknown, uploads: Upload[] = []) {
  const snapshot = await storage.read();
  const expected = request.headers.get('if-match');
  if (expected && expected !== snapshot.version) {
    throw new HttpError(409, 'Каталог изменился с момента загрузки — загрузите свежую версию и повторите');
  }

  const prev: Catalog = JSON.parse(snapshot.text);
  const next = mutate(structuredClone(prev)) as Catalog;
  const errors = validateCatalog(next);
  if (errors.length) throw new HttpError(422, 'Каталог не прошёл проверку', { errors });

  const text = JSON.stringify(next, null, 2) + '\n';
  const prevRefs = uploadRefs(prev);
  const nextRefs = uploadRefs(next);
  const add = uploads.filter((u) => nextRefs.has(u.path));
  const remove = [...prevRefs].filter((p) => !nextRefs.has(p));
  if (text === snapshot.text && !add.length) return { ok: true, unchanged: true, catalog: next, version: snapshot.version };

  const written = await storage.commit(snapshot, { catalogText: text, add, remove }, message);
  return { ok: true, catalog: next, ...written, storage: storage.kind };
}

// CRUD для categories и products устроен одинаково.
async function collection(storage: Storage, request: Request, name: 'categories' | 'products', id: string | undefined) {
  const method = request.method;
  const title = name === 'categories' ? 'Категория' : 'Товар';
  const find = (catalog: Catalog) => {
    const index = catalog[name].findIndex((x) => x?.id === id);
    if (index === -1) throw new HttpError(404, `${title} «${id}» не найден(а)`);
    return index;
  };

  if (method === 'GET') {
    const catalog: Catalog = JSON.parse((await storage.read()).text);
    return json(200, id ? catalog[name][find(catalog)] : catalog[name]);
  }

  requireAuth(request, storage);
  const body = method === 'DELETE' ? {} : requireObject(await readBody(request));
  const uploads = parseUploads(body.uploads);
  delete body.uploads;

  if (!id && method === 'POST') {
    const result = await save(storage, request, `catalog: ${title.toLowerCase()} ${body.id} добавлен(а)`, (c) => {
      if (c[name].some((x) => x?.id === body.id)) throw new HttpError(409, `${title} «${body.id}» уже существует`);
      c[name].push(body);
      return c;
    }, uploads);
    return json(201, result);
  }

  if (id && (method === 'PUT' || method === 'PATCH')) {
    const result = await save(storage, request, `catalog: ${title.toLowerCase()} ${id} изменён(а)`, (c) => {
      const index = find(c);
      const updated = method === 'PUT' ? { id, ...body } : mergePatch(c[name][index], body);
      c[name][index] = updated;
      // Сменили ID категории — переносим на него товары.
      if (name === 'categories' && updated.id !== id) {
        for (const p of c.products) if (p.category === id) p.category = updated.id;
      }
      return c;
    }, uploads);
    return json(200, result);
  }

  if (id && method === 'DELETE') {
    const result = await save(storage, request, `catalog: ${title.toLowerCase()} ${id} удалён(а)`, (c) => {
      const index = find(c);
      if (name === 'categories') {
        const count = c.products.filter((p) => p.category === id).length;
        if (count) throw new HttpError(409, `В категории ${count} товар(ов) — сначала перенесите или удалите их`);
      }
      c[name].splice(index, 1);
      return c;
    });
    return json(200, result);
  }

  throw new HttpError(405, 'Метод не поддерживается');
}

async function handle(request: Request, url: URL, parts: string[]): Promise<Response> {
  const [resource, id, ...rest] = parts;
  const method = request.method;
  if (rest.length) throw new HttpError(404, 'Нет такого метода API');

  if (resource === 'status' && !id && method === 'GET') {
    let storage: Storage | null = null;
    try {
      storage = getStorage();
    } catch {}
    const sha = url.searchParams.get('sha');
    return json(200, {
      storage: storage?.kind ?? null,
      authRequired: Boolean(process.env.ADMIN_TOKEN),
      deployment: storage && sha ? await storage.deployment(sha) : undefined,
    });
  }

  const storage = getStorage();

  if (resource === 'catalog' && !id) {
    if (method === 'GET') {
      const { text, version } = await storage.read();
      return json(200, JSON.parse(text), { etag: version });
    }
    requireAuth(request, storage);
    if (method === 'PUT') {
      // Тело — либо сам каталог, либо { catalog, uploads: [{ path, data(base64) }] }.
      const body = requireObject(await readBody(request));
      const catalog = body.catalog ?? body;
      const uploads = parseUploads(body.uploads);
      return json(200, await save(storage, request, 'catalog: правка через админку', () => catalog, uploads));
    }
  }

  if (resource === 'categories' || resource === 'products') return collection(storage, request, resource, id);

  // POST /api/images?name=<id> с телом-картинкой: кладёт файл в /uploads/ отдельным коммитом.
  if (resource === 'images' && !id && method === 'POST') {
    requireAuth(request, storage);
    const ext = MIME_EXT[request.headers.get('content-type')?.split(';')[0] ?? ''];
    if (!ext) throw new HttpError(415, 'Поддерживаются image/webp, image/jpeg и image/png');
    const data = Buffer.from(await request.arrayBuffer());
    checkImage(data, ext);
    const name = (url.searchParams.get('name') ?? 'photo').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'photo';
    const imagePath = `/uploads/${ID_RE.test(name) ? name : 'photo'}-${Date.now().toString(36)}.${ext}`;
    const snapshot = await storage.read();
    const written = await storage.commit(snapshot, { add: [{ path: imagePath, data }], remove: [] }, `catalog: фото ${imagePath}`);
    return json(201, { ok: true, path: imagePath, commit: written.commit });
  }

  throw new HttpError(404, `Нет такого метода API: ${method} ${url.pathname}`);
}

export const ALL: APIRoute = async ({ request, params, url }) => {
  try {
    const parts = (params.path ?? '').split('/').filter(Boolean).map(decodeURIComponent);
    return await handle(request, url, parts);
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message, ...err.extra });
    console.error(err);
    return json(500, { error: 'Внутренняя ошибка сервера' });
  }
};
