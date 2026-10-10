# File-based CMS на Astro: каталог из JSON

Два одинаковых сайта обжарочной «Зерно». Лендинг — обычная статика в шаблонах. Динамический контент — **каталог**:
категории и товары с фото в `data/catalog.json`. Из него при `astro build` генерируются страницы
`/catalog/`, `/catalog/<категория>/` и `/product/<товар>/`. В рантайме сайт ничего не загружает — это чистый HTML.

| | `site-static/` | `site-vercel/` |
|---|---|---|
| Хостинг | GitHub Pages | Vercel |
| Админка `/admin/` | правки в браузере → экспорт `catalog.json` | правки → «Опубликовать» |
| Как правки попадают на сайт | заменить `data/catalog.json` и закоммитить | API коммитит в GitHub сам, Vercel пересобирает |
| Фото | путь к файлу в `public/` | загрузка из админки |

## Админка (общая для обоих)

Вкладки «Товары» и «Категории»: создание, правка и удаление. Поиск и фильтр по категории.
ID (адрес страницы) генерируется из названия транслитом. Если сменить ID категории, её товары переедут на новый ID.
Категорию с товарами удалить нельзя. Перед сохранением каталог проверяется (`src/lib/validate.js`): та же проверка
выполняется при сборке и в API, так что битый каталог не соберётся.

## site-static → GitHub Pages

```sh
cd site-static && npm install
npm run dev      # http://localhost:4321, админка: /admin/
npm run build    # dist/
```

Порядок работы: `/admin/` → правки → «Экспорт catalog.json» → замените `site-static/data/catalog.json` →
коммит в `main`. `.github/workflows/pages.yml` соберёт и опубликует сайт.
Фото: положите файл в `site-static/public/images/products/` и укажите в товаре путь `/images/products/имя.jpg`.

Pages отдаёт сайт из подпапки (`/filebased-cms/`), поэтому workflow передаёт `BASE_PATH`, а все ссылки
и пути к фото в шаблонах проходят через `url()` из `src/lib/catalog.ts`. В JSON пути пишутся от корня.

## site-vercel → Vercel

Страницы — та же статика. На сервере выполняется только `src/pages/api/[...path].ts` (функция Vercel).
Она не пишет на диск (на Vercel его нет), а делает **коммит в GitHub** через Git Data API: каталог, новые фото
и удаление фото, на которые больше никто не ссылается, — одним коммитом. Vercel видит пуш и пересобирает сайт;
админка показывает статус сборки (по GitHub Deployments). Если сборка упала, на сайте остаётся прежняя версия.

Фото сжимаются в браузере до 1600 px и сохраняются в WebP в `site-vercel/public/uploads/`.
На сайте они появляются вместе с пересобранной версией.

Переменные окружения на Vercel:

| Переменная | |
|---|---|
| `GITHUB_TOKEN` | токен с правом записи в репозиторий |
| `GITHUB_REPO` | `rasult22/filebased-cms` |
| `GITHUB_BRANCH` | ветка, по умолчанию `main` |
| `SITE_DIR` | папка сайта в репозитории, по умолчанию `site-vercel` |
| `ADMIN_TOKEN` | пароль админки и API; без него запись в репозиторий отключена |

Локально `npm run dev` работает без этих переменных: API пишет прямо в `data/catalog.json` и `public/uploads/`.

### API

Изменяющие методы требуют `Authorization: Bearer <ADMIN_TOKEN>` и отвечают
`{ ok, catalog, version, commit: { sha, url } }`. Ошибка проверки — `422 { error, errors[] }`.
Если передать `If-Match: <version>` (из `ETag` ответа `GET /api/catalog`), а каталог успел измениться, вернётся `409`.

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/api/catalog` | весь каталог (+ `ETag`) |
| PUT | `/api/catalog` | заменить каталог; тело — каталог или `{ catalog, uploads: [{ path, data }] }` |
| GET, POST | `/api/categories` | список / создать |
| GET, PUT, PATCH, DELETE | `/api/categories/:id` | одна категория |
| GET, POST | `/api/products` | список / создать (можно с `uploads`) |
| GET, PUT, PATCH, DELETE | `/api/products/:id` | один товар (PATCH — JSON Merge Patch) |
| POST | `/api/images?name=<id>` | загрузить фото (тело — `image/webp`, `image/jpeg` или `image/png`), вернёт `path` |
| GET | `/api/status?sha=<коммит>` | статус сборки коммита |

```sh
# новый товар с фото одним коммитом
curl -X POST https://<проект>.vercel.app/api/products \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  --data-binary @product.json   # { "id": "...", "name": "...", "category": "...", "image": "/uploads/x.webp", "uploads": [{ "path": "/uploads/x.webp", "data": "<base64>" }] }

curl -X PATCH https://<проект>.vercel.app/api/products/efiopiya-guji \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' --data-binary '{"price": 7200}'
```

> В Windows curl передаёт кириллицу из аргументов командной строки в системной кодировке, и она портится.
> Кладите тело в UTF-8 файл и передавайте через `--data-binary @file.json`.
