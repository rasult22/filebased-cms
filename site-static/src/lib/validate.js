// Проверка data/catalog.json.
// Обычный JS (не TS), чтобы один и тот же файл работал и в браузере (админка), и при сборке, и в API.

export const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * @param {unknown} catalog
 * @returns {string[]} список ошибок; пустой — всё в порядке
 */
export function validateCatalog(catalog) {
  if (!isObject(catalog)) return ['Каталог должен быть объектом'];
  const c = /** @type {Record<string, any>} */ (catalog);
  const errors = [];

  if (!Array.isArray(c.categories)) errors.push('categories: должен быть списком');
  if (!Array.isArray(c.products)) errors.push('products: должен быть списком');
  if (errors.length) return errors;

  const categoryIds = new Set();
  c.categories.forEach((cat, i) => {
    const at = `Категория №${i + 1}`;
    if (!isObject(cat)) return errors.push(`${at}: должна быть объектом`);
    const name = isText(cat.name) ? `«${cat.name}»` : at;
    if (!isText(cat.name)) errors.push(`${at}: нужно название`);
    if (typeof cat.id !== 'string' || !ID_RE.test(cat.id)) errors.push(`${name}: ID — латиница в нижнем регистре, цифры и дефисы`);
    else if (categoryIds.has(cat.id)) errors.push(`${name}: ID «${cat.id}» уже занят`);
    else categoryIds.add(cat.id);
  });

  const productIds = new Set();
  c.products.forEach((p, i) => {
    const at = `Товар №${i + 1}`;
    if (!isObject(p)) return errors.push(`${at}: должен быть объектом`);
    const name = isText(p.name) ? `«${p.name}»` : at;
    if (!isText(p.name)) errors.push(`${at}: нужно название`);
    if (typeof p.id !== 'string' || !ID_RE.test(p.id)) errors.push(`${name}: ID — латиница в нижнем регистре, цифры и дефисы`);
    else if (productIds.has(p.id)) errors.push(`${name}: ID «${p.id}» уже занят`);
    else productIds.add(p.id);
    if (!categoryIds.has(p.category)) errors.push(`${name}: категория «${p.category ?? ''}» не существует`);
    if (p.price !== undefined && (typeof p.price !== 'number' || !Number.isFinite(p.price) || p.price < 0)) {
      errors.push(`${name}: цена должна быть неотрицательным числом`);
    }
    if (p.image !== undefined && typeof p.image !== 'string') errors.push(`${name}: фото — путь или URL строкой`);
    if (p.available !== undefined && typeof p.available !== 'boolean') errors.push(`${name}: «в наличии» — true или false`);
  });

  return errors;
}
