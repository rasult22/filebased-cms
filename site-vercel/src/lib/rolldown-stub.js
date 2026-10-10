// Замена пакета rolldown в серверном бандле — см. astro.config.mjs.
// Адаптер вызывает rolldown только во время сборки; в функции до этого кода дело не доходит.
export function rolldown() {
  throw new Error('rolldown недоступен в серверной функции');
}
