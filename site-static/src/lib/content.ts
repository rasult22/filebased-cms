// Единственная точка, где читается data/content.json.
// Импорт выполняется во время `astro build`, поэтому в готовом HTML уже лежат данные —
// в рантайме сайт ничего не загружает.
import raw from '../../data/content.json';
import { validateContent } from './validate.js';

export interface NavItem { label: string; href: string }
export interface Feature { title: string; text?: string }
export interface Post {
  slug: string;
  title: string;
  date?: string;
  tags?: string[];
  excerpt?: string;
  body?: string[] | string;
}
export interface Content {
  site: { title: string; tagline?: string; description?: string };
  nav?: NavItem[];
  hero?: { heading?: string; text?: string; cta?: { label: string; href: string } };
  labels?: Record<string, string>;
  features?: Feature[];
  posts?: Post[];
  contacts?: { address?: string; email?: string; phone?: string };
}

const errors = validateContent(raw);
if (errors.length) {
  throw new Error(`data/content.json не прошёл проверку:\n  - ${errors.join('\n  - ')}`);
}

export const content = raw as unknown as Content;
export const builtAt = new Date();

// Ссылки в контенте и шаблонах пишутся от корня ("/posts/"). Если сайт опубликован в подпапке
// (например, GitHub Pages: /filebased-cms/), к ним добавляется base из astro.config.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
export const url = (href: string) => (href.startsWith('/') && !href.startsWith('//') ? BASE + href : href);

export const label = (key: string, fallback: string) => content.labels?.[key] ?? fallback;

export function sortedPosts(): Post[] {
  return [...(content.posts ?? [])].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

export function paragraphs(body: Post['body']): string[] {
  if (Array.isArray(body)) return body;
  return String(body ?? '').split(/\n{2,}/).filter(Boolean);
}

export function formatDate(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}
