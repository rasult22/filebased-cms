// Универсальный редактор произвольного JSON в виде формы.
// Ничего не знает о структуре content.json: можно менять значения, типы, добавлять,
// удалять, переименовывать поля и переставлять элементы списков.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Kind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

const KINDS: Record<Kind, string> = {
  string: 'текст',
  number: 'число',
  boolean: 'да/нет',
  null: 'пусто',
  array: 'список',
  object: 'объект',
};

export const kindOf = (v: Json): Kind => (v === null ? 'null' : Array.isArray(v) ? 'array' : (typeof v as Kind));
const isContainer = (k: Kind) => k === 'array' || k === 'object';

const emptyOf = (kind: Kind): Json => ({ string: '', number: 0, boolean: false, null: null, array: [], object: {} })[kind];

// Пустая копия той же формы — чтобы новый элемент списка получил те же поля, что и предыдущий.
function blankLike(v: Json): Json {
  const kind = kindOf(v);
  if (kind !== 'object') return emptyOf(kind);
  return Object.fromEntries(Object.entries(v as JsonObject).map(([k, x]) => [k, blankLike(x)]));
}

function convert(v: Json, to: Kind): Json {
  const from = kindOf(v);
  if (from === to) return v;
  switch (to) {
    case 'string':
      return v === null ? '' : isContainer(from) ? JSON.stringify(v) : String(v);
    case 'number': {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    case 'boolean':
      return from === 'string' ? v === 'true' : from === 'number' ? v !== 0 : false;
    case 'array':
      return v === null ? [] : [v];
    default:
      return emptyOf(to);
  }
}

function summarize(v: Json): string {
  if (Array.isArray(v)) return `${v.length} эл.`;
  const obj = v as JsonObject;
  const hint = ['title', 'name', 'label', 'heading', 'slug'].map((k) => obj[k]).find((x) => typeof x === 'string' && x);
  return (hint as string | undefined) ?? `${Object.keys(obj).length} пол.`;
}

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (name.startsWith('on') && typeof value === 'function') el.addEventListener(name.slice(2), value as EventListener);
    else if (name === 'class') el.className = String(value);
    else if (name in el) (el as any)[name] = value;
    else if (value !== false) el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

interface RowOptions {
  label: HTMLElement;
  get: () => Json;
  set: (v: Json) => void;
  remove: () => void;
  path: string;
  depth: number;
  tools?: HTMLElement[];
}

export class JsonEditor {
  #root: HTMLElement;
  #onChange: () => void;
  #data: Json = {};
  // Явно раскрытые/свёрнутые группы по пути, чтобы перерисовка не сбрасывала их состояние.
  #open = new Map<string, boolean>();

  constructor(root: HTMLElement, onChange: () => void = () => {}) {
    this.#root = root;
    this.#onChange = onChange;
  }

  get value(): Json {
    return this.#data;
  }

  set value(v: Json) {
    this.#data = v;
    this.#open.clear();
    this.render();
  }

  render() {
    const data = this.#data;
    this.#root.replaceChildren(
      isContainer(kindOf(data)) ? this.#container(data, '$', 0) : this.#primitive(data, (v) => (this.#data = v)),
    );
  }

  // Правка значения не требует перерисовки (иначе пропадёт фокус); структурная — требует.
  #changed(structural = false) {
    if (structural) this.render();
    this.#onChange();
  }

  #primitive(value: Json, set: (v: Json) => void): HTMLElement {
    switch (kindOf(value)) {
      case 'string': {
        const text = value as string;
        const lines = text.match(/\n/g)?.length ?? 0;
        const field =
          text.length > 70 || lines > 0
            ? h('textarea', { rows: Math.min(12, Math.max(3, Math.ceil(text.length / 70) + lines)) })
            : h('input', { type: 'text' });
        field.value = text;
        field.addEventListener('input', () => {
          set(field.value);
          this.#changed();
        });
        return field;
      }
      case 'number': {
        const field = h('input', { type: 'number', step: 'any', value: String(value) });
        field.addEventListener('input', () => {
          if (field.value === '' || !Number.isFinite(field.valueAsNumber)) return;
          set(field.valueAsNumber);
          this.#changed();
        });
        return field;
      }
      case 'boolean': {
        const caption = document.createTextNode(value ? 'да' : 'нет');
        const box = h('input', { type: 'checkbox', checked: value });
        box.addEventListener('change', () => {
          caption.data = box.checked ? 'да' : 'нет';
          set(box.checked);
          this.#changed();
        });
        return h('label', { class: 'je-bool' }, box, caption);
      }
      default:
        return h('span', { class: 'je-null' }, 'null');
    }
  }

  #container(value: Json, path: string, depth: number): HTMLElement {
    return Array.isArray(value) ? this.#array(value, path, depth) : this.#object(value as JsonObject, path, depth);
  }

  #object(obj: JsonObject, path: string, depth: number) {
    const box = h('div', { class: 'je-list' });

    for (const key of Object.keys(obj)) {
      const keyInput = h('input', { type: 'text', class: 'je-key', value: key, spellcheck: false, 'aria-label': 'Имя поля' });
      keyInput.addEventListener('change', () => this.#rename(obj, key, keyInput));
      box.append(
        this.#row({
          label: keyInput,
          get: () => obj[key],
          set: (v) => (obj[key] = v),
          remove: () => delete obj[key],
          path: `${path}.${key}`,
          depth,
        }),
      );
    }

    const name = h('input', { type: 'text', placeholder: 'новое поле', spellcheck: false, 'aria-label': 'Имя нового поля' });
    const kind = this.#kindSelect('string');
    const add = () => {
      const key = name.value.trim();
      if (!key || key in obj) {
        name.classList.add('je-invalid');
        name.focus();
        return;
      }
      obj[key] = emptyOf(kind.value as Kind);
      this.#changed(true);
    };
    name.addEventListener('input', () => name.classList.remove('je-invalid'));
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        add();
      }
    });
    box.append(h('div', { class: 'je-adder' }, name, kind, h('button', { type: 'button', onclick: add }, '+ поле')));
    return box;
  }

  // Переименование с сохранением порядка полей.
  #rename(obj: JsonObject, oldKey: string, input: HTMLInputElement) {
    const next = input.value.trim();
    if (next === oldKey) return;
    if (!next || next in obj) {
      input.value = oldKey;
      return;
    }
    const entries = Object.entries(obj);
    for (const k of Object.keys(obj)) delete obj[k];
    for (const [k, v] of entries) obj[k === oldKey ? next : k] = v;
    this.#changed(true);
  }

  #array(arr: Json[], path: string, depth: number) {
    const box = h('div', { class: 'je-list' });

    arr.forEach((_, i) => {
      const move = (to: number) => {
        [arr[i], arr[to]] = [arr[to], arr[i]];
        this.#changed(true);
      };
      const duplicate = () => {
        arr.splice(i + 1, 0, structuredClone(arr[i]));
        this.#changed(true);
      };
      box.append(
        this.#row({
          label: h('span', { class: 'je-index' }, String(i + 1)),
          get: () => arr[i],
          set: (v) => (arr[i] = v),
          remove: () => arr.splice(i, 1),
          path: `${path}[${i}]`,
          depth,
          tools: [
            h('button', { type: 'button', class: 'je-icon', title: 'Выше', disabled: i === 0, onclick: () => move(i - 1) }, '↑'),
            h('button', { type: 'button', class: 'je-icon', title: 'Ниже', disabled: i === arr.length - 1, onclick: () => move(i + 1) }, '↓'),
            h('button', { type: 'button', class: 'je-icon', title: 'Дублировать', onclick: duplicate }, '⧉'),
          ],
        }),
      );
    });

    const kind = this.#kindSelect(arr.length ? 'like' : 'string', arr.length > 0);
    const add = () => {
      arr.push(kind.value === 'like' ? blankLike(arr[arr.length - 1]) : emptyOf(kind.value as Kind));
      this.#changed(true);
    };
    box.append(h('div', { class: 'je-adder' }, kind, h('button', { type: 'button', onclick: add }, '+ элемент')));
    return box;
  }

  #kindSelect(selected: string, withLike = false) {
    const select = h('select', { 'aria-label': 'Тип значения' });
    if (withLike) select.append(h('option', { value: 'like' }, 'как предыдущий'));
    for (const [kind, title] of Object.entries(KINDS)) select.append(h('option', { value: kind }, title));
    select.value = selected;
    return select;
  }

  #row(o: RowOptions): HTMLElement {
    const kind = kindOf(o.get());

    const type = this.#kindSelect(kind);
    type.classList.add('je-type');
    type.addEventListener('change', () => {
      o.set(convert(o.get(), type.value as Kind));
      this.#changed(true);
    });
    const remove = () => {
      o.remove();
      this.#changed(true);
    };
    const tools = h(
      'div',
      { class: 'je-tools' },
      ...(o.tools ?? []),
      type,
      h('button', { type: 'button', class: 'je-icon je-del', title: 'Удалить', onclick: remove }, '×'),
    );

    if (!isContainer(kind)) {
      return h('div', { class: 'je-row' }, h('div', { class: 'je-label' }, o.label), h('div', { class: 'je-value' }, this.#primitive(o.get(), o.set)), tools);
    }

    // По умолчанию раскрыт только первый уровень, глубже — свёрнуто.
    const isOpen = this.#open.get(o.path) ?? o.depth < 1;
    const body = h('div', { class: 'je-body', hidden: !isOpen }, this.#container(o.get(), o.path, o.depth + 1));
    const caret = h('button', { type: 'button', class: 'je-caret', title: 'Свернуть / развернуть', 'aria-expanded': String(isOpen) }, '▸');
    const toggle = () => {
      const open = body.hidden;
      body.hidden = !open;
      caret.setAttribute('aria-expanded', String(open));
      this.#open.set(o.path, open);
    };
    caret.addEventListener('click', toggle);

    return h(
      'div',
      { class: 'je-group' },
      h(
        'div',
        { class: 'je-row je-head' },
        h('div', { class: 'je-label' }, caret, o.label),
        h('div', { class: 'je-value je-summary', onclick: toggle }, summarize(o.get())),
        tools,
      ),
      body,
    );
  }
}
