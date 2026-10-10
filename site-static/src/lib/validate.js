// Проверка структуры content.json.
// Обычный JS (не TS), чтобы этот же файл можно было импортировать и в браузере (редактор),
// и при сборке Astro, и в Node без сборщика.

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * @param {unknown} content
 * @returns {string[]} список ошибок; пустой — всё в порядке
 */
export function validateContent(content) {
  if (!isObject(content)) return ['Корень файла должен быть объектом'];

  const errors = [];
  const c = /** @type {Record<string, any>} */ (content);

  if (!isObject(c.site)) errors.push('site: нужен объект');
  else if (!isText(c.site.title)) errors.push('site.title: нужна непустая строка');

  for (const key of ['nav', 'features', 'posts']) {
    if (c[key] !== undefined && !Array.isArray(c[key])) errors.push(`${key}: должен быть списком`);
  }

  if (Array.isArray(c.nav)) {
    c.nav.forEach((item, i) => {
      if (!isObject(item) || !isText(item.label) || !isText(item.href)) {
        errors.push(`nav[${i}]: нужны поля label и href`);
      }
    });
  }

  if (Array.isArray(c.posts)) {
    const seen = new Set();
    c.posts.forEach((post, i) => {
      const at = `posts[${i}]`;
      if (!isObject(post)) return errors.push(`${at}: должен быть объектом`);
      if (typeof post.slug !== 'string' || !SLUG_RE.test(post.slug)) {
        errors.push(`${at}.slug: только латиница в нижнем регистре, цифры и дефисы`);
      } else if (seen.has(post.slug)) {
        errors.push(`${at}.slug: «${post.slug}» уже занят другим постом`);
      } else {
        seen.add(post.slug);
      }
      if (!isText(post.title)) errors.push(`${at}.title: нужна непустая строка`);
      if (post.date !== undefined && Number.isNaN(Date.parse(post.date))) {
        errors.push(`${at}.date: ожидается дата вида 2026-10-01`);
      }
    });
  }

  return errors;
}
