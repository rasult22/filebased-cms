// Единственная точка, где читается data/catalog.json. Импорт выполняется во время `astro build`,
// поэтому в готовом HTML уже лежат категории и товары — в рантайме сайт ничего не загружает.
import raw from '../../data/catalog.json';
import { validateCatalog } from './validate.js';

export interface Category {
  id: string;
  name: string;
  description?: string;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  price?: number;
  weight?: string;
  description?: string;
  image?: string;
  available?: boolean;
}

export interface Catalog {
  categories: Category[];
  products: Product[];
}

const errors = validateCatalog(raw);
if (errors.length) {
  throw new Error(`data/catalog.json не прошёл проверку:\n  - ${errors.join('\n  - ')}`);
}

export const catalog = raw as Catalog;
export const builtAt = new Date();

export const categoryById = (id: string) => catalog.categories.find((c) => c.id === id);
export const productsIn = (categoryId: string) => catalog.products.filter((p) => p.category === categoryId);

// Ссылки пишутся от корня ("/catalog/"). Если сайт опубликован в подпапке
// (GitHub Pages: /filebased-cms/), к ним добавляется base из astro.config.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
export const url = (href: string) => (href.startsWith('/') && !href.startsWith('//') ? BASE + href : href);

const priceFormat = new Intl.NumberFormat('ru-RU');
export const formatPrice = (price?: number) => (price === undefined ? '' : `${priceFormat.format(price)} ₸`);
