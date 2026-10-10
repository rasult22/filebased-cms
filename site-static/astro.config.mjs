import { defineConfig } from 'astro/config';

// Полностью статическая сборка: все страницы генерируются в dist/ при `astro build`.
// SITE_URL и BASE_PATH задаются при публикации в подпапку (см. .github/workflows/pages.yml),
// локально сайт собирается от корня.
export default defineConfig({
  output: 'static',
  site: process.env.SITE_URL,
  base: process.env.BASE_PATH || '/',
});
