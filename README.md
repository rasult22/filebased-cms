# File-based CMS на Astro — два примера

Оба сайта одинаковые: полностью статические страницы, контент берётся из `data/content.json` во время `astro build`.
Отличаются они только тем, как этот файл меняется.

| | `site-static/` | `site-api/` |
|---|---|---|
| Где правится контент | `/admin/` в браузере: импорт → правки → экспорт | `/admin/` или HTTP API |
| Как правки попадают на сайт | вручную заменить `data/content.json` и запустить `npm run build` | сервер сам записывает файл и пересобирает сайт |
| Что нужно для хостинга | любой статический хостинг (`dist/`) | Node 22.12+ (`server.mjs`) |

## Общее

- `data/content.json` — весь контент: `site`, `nav`, `hero`, `labels`, `features`, `posts`, `contacts`.
  По каждому элементу `posts[]` генерируется страница `/posts/<slug>/` (`getStaticPaths`).
- `src/lib/content.ts` — единственное место, где читается JSON. Перед сборкой файл проверяется
  (`src/lib/validate.js`), и при ошибке сборка падает с понятным сообщением.
- `src/scripts/json-editor.ts` — редактор произвольного JSON в виде формы: правка значений, смена типа,
  добавление, удаление и переименование полей, перестановка и дублирование элементов списка.
  Есть вкладка «JSON» для правки исходного текста.
- В подвале показано время сборки — по нему видно, что сайт пересобрался.

## site-static

```sh
cd site-static
npm install
npm run dev      # http://localhost:4321, редактор: /admin/
npm run build    # готовый сайт в dist/
```

Порядок работы: откройте `/admin/` (по умолчанию там контент текущей сборки, можно импортировать другой файл) →
внесите правки → «Экспорт файла» → замените им `data/content.json` → `npm run build`.

### Публикация на GitHub Pages

`.github/workflows/pages.yml` собирает `site-static` и публикует его при каждом пуше в `main`, который затрагивает
`site-static/`. Новый контент: экспортируйте файл из `/admin/`, замените `site-static/data/content.json`,
закоммитьте и запушьте (или загрузите файл через веб-интерфейс GitHub) — через минуту сайт обновится.

Pages отдаёт сайт из подпапки (`/<repo>/`), поэтому workflow передаёт в сборку `BASE_PATH`, а все ссылки
в шаблонах и в `content.json` проходят через `url()` из `src/lib/content.ts`. Ссылки в JSON пишите от корня: `/posts/`.

## site-api

```sh
cd site-api
npm install
npm start        # http://localhost:4322, редактор: /admin/
```

`server.mjs` (без зависимостей) отдаёт статическую сборку и предоставляет API. При старте он собирает сайт.
Каждая версия собирается в отдельный каталог `.builds/<id>/`, и раздача переключается на него только после
успешной сборки: посетители никогда не видят полусобранный сайт. Если сборка упала, `content.json`
откатывается к прежней версии. Предыдущие версии файла сохраняются в `data/history/` (последние 20).

Переменные окружения: `PORT` (4322), `HOST` (localhost), `ADMIN_TOKEN` — если задан, все запросы, кроме GET,
требуют заголовок `Authorization: Bearer <токен>`.

Для разработки шаблонов: `npm start` в одном терминале и `npm run dev` в другом — dev-сервер Astro проксирует `/api` на `server.mjs`.

### API

Все изменяющие методы проверяют контент, записывают файл, пересобирают сайт и отвечают после окончания сборки:
`{ ok, content, build: { id, durationMs, ... } }`. Если проверка не прошла — `422 { error, errors[] }`,
если упала сборка — `500 { error, log }`, сайт при этом не меняется.

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/api/content` | весь файл |
| PUT | `/api/content` | заменить файл целиком |
| PATCH | `/api/content` | JSON Merge Patch (RFC 7396): объекты сливаются, `null` удаляет поле, массивы заменяются |
| GET | `/api/posts` | список постов |
| POST | `/api/posts` | добавить пост (`409`, если `slug` занят) |
| GET | `/api/posts/:slug` | один пост |
| PUT | `/api/posts/:slug` | заменить пост |
| PATCH | `/api/posts/:slug` | частично изменить пост |
| DELETE | `/api/posts/:slug` | удалить пост |
| POST | `/api/rebuild` | пересобрать без изменений (например, после ручной правки файла) |
| GET | `/api/status` | состояние: идёт ли сборка, последняя сборка, нужен ли токен |

```sh
curl -X PATCH localhost:4322/api/content -H 'content-type: application/json' \
  --data-binary '{"hero":{"heading":"Новый заголовок"}}'

curl -X POST localhost:4322/api/posts -H 'content-type: application/json' \
  --data-binary @new-post.json

curl -X DELETE localhost:4322/api/posts/kapping-po-subbotam
```

> В Windows (Git Bash, cmd) curl передаёт кириллицу из аргументов командной строки в системной кодировке, и она
> портится. Кладите тело запроса в UTF-8 файл и передавайте его через `--data-binary @file.json`.
