// Общая обвязка страницы редактора: вкладки «Форма / JSON», проверка, импорт и экспорт файла.
import { JsonEditor, type Json } from './json-editor';
import { validateContent } from '../lib/validate.js';

type Tone = 'info' | 'ok' | 'error';

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function mountAdmin() {
  const statusEl = byId('status');
  const issuesEl = byId('issues');
  const formEl = byId('form');
  const rawEl = byId('raw');
  const rawText = byId<HTMLTextAreaElement>('raw-text');
  const importInput = byId<HTMLInputElement>('import');
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-tab]')];

  let mode: 'form' | 'raw' = 'form';
  let dirty = false;

  const setStatus = (text: string, tone: Tone = 'info') => {
    statusEl.textContent = text;
    statusEl.dataset.tone = tone;
  };

  function showIssues() {
    let errors: string[];
    if (mode === 'raw') {
      try {
        errors = validateContent(JSON.parse(rawText.value));
      } catch (e) {
        errors = [`JSON не разбирается: ${(e as Error).message}`];
      }
    } else {
      errors = validateContent(editor.value);
    }
    issuesEl.replaceChildren(...errors.map((text) => Object.assign(document.createElement('li'), { textContent: text })));
    issuesEl.hidden = errors.length === 0;
  }

  const touch = () => {
    dirty = true;
    showIssues();
  };
  const editor = new JsonEditor(formEl, touch);
  rawText.addEventListener('input', touch);

  // Текущее значение. В режиме JSON сначала разбирает текст; при ошибке возвращает undefined.
  function read(): Json | undefined {
    if (mode === 'form') return editor.value;
    try {
      const value = JSON.parse(rawText.value) as Json;
      editor.value = value;
      return value;
    } catch (e) {
      setStatus(`Ошибка в JSON: ${(e as Error).message}`, 'error');
      return undefined;
    }
  }

  function switchTo(next: 'form' | 'raw') {
    if (next === mode) return;
    if (next === 'form' && read() === undefined) return;
    if (next === 'raw') rawText.value = JSON.stringify(editor.value, null, 2);
    mode = next;
    formEl.hidden = next !== 'form';
    rawEl.hidden = next !== 'raw';
    for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === next));
  }
  for (const tab of tabs) tab.addEventListener('click', () => switchTo(tab.dataset.tab as 'form' | 'raw'));

  function load(value: Json, message: string) {
    editor.value = value;
    if (mode === 'raw') rawText.value = JSON.stringify(value, null, 2);
    dirty = false;
    showIssues();
    setStatus(message, 'ok');
  }

  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    try {
      load(JSON.parse(await file.text()), `Импортирован файл ${file.name}`);
    } catch (e) {
      setStatus(`Не удалось прочитать ${file.name}: ${(e as Error).message}`, 'error');
    }
  });

  byId('export').addEventListener('click', () => {
    const value = read();
    if (value === undefined) return;
    const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: 'content.json' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    dirty = false;
    const problems = validateContent(value).length;
    if (problems) setStatus(`Файл скачан, но в нём ошибок: ${problems} — сборка с ним упадёт`, 'error');
    else setStatus('Файл скачан: замените им data/content.json и запустите сборку', 'ok');
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
  });

  return {
    load,
    read,
    setStatus,
    markClean: () => (dirty = false),
  };
}
