import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import { fileURLToPath } from 'node:url';

// Все страницы — статика, собранная из data/catalog.json. Серверлесс-функцией становится
// только src/pages/api/[...path].ts (prerender = false): она коммитит правки в GitHub,
// а Vercel пересобирает сайт по пушу.
export default defineConfig({
  output: 'static',
  adapter: vercel(),
  vite: {
    resolve: {
      // @astrojs/vercel 11.0.13 оставляет в серверном бандле `import "rolldown"` (сборщик нужен адаптеру
      // только во время сборки). В функции Vercel у rolldown нет нативного бинарника, и она падает
      // при старте, поэтому в бандле подменяем его пустым модулем.
      alias: [{ find: /^rolldown$/, replacement: fileURLToPath(new URL('./src/lib/rolldown-stub.js', import.meta.url)) }],
    },
  },
});
