import { defineConfig } from 'astro/config';

// Страницы по-прежнему полностью статические. server.mjs собирает каждую версию сайта
// в отдельный каталог (ASTRO_OUT_DIR) и переключается на него только после успешной сборки.
export default defineConfig({
  output: 'static',
  outDir: process.env.ASTRO_OUT_DIR || './dist',
  vite: {
    server: {
      // В `npm run dev` запросы редактора к /api уходят на запущенный server.mjs.
      proxy: { '/api': `http://localhost:${process.env.PORT || 4322}` },
    },
  },
});
