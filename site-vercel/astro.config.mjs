import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

// Все страницы — статика, собранная из data/content.json. Серверлесс-функцией становится
// только src/pages/api/[...path].ts (prerender = false): она коммитит правки в GitHub,
// а Vercel пересобирает сайт по пушу.
export default defineConfig({
  output: 'static',
  adapter: vercel(),
});
