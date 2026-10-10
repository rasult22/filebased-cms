// Админка каталога: списки товаров и категорий, создание, правка и удаление.
// Работает с данными в памяти; как их загрузить и сохранить, решает страница
// (импорт/экспорт файла в первом варианте, API во втором).
import { ID_RE, validateCatalog } from '../lib/validate.js';

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

export interface Upload {
  path: string;
  blob: Blob;
}

interface Options {
  /** Адрес картинки по пути из каталога (добавляет base сайта). */
  imageSrc: (path: string) => string;
  /** Подготовка загруженного фото; если не задано, загрузки нет. */
  prepareUpload?: (file: File, name: string) => Promise<Upload>;
}

type Tone = 'info' | 'ok' | 'error';

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u',
  ү: 'u', һ: 'h', і: 'i',
};

export const slugify = (text: string) =>
  [...text.toLowerCase()]
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const priceFormat = new Intl.NumberFormat('ru-RU');
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string | false | null | undefined)[]) {
  const node = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className) node.className = className;
  Object.assign(node, rest);
  for (const child of children) if (child) node.append(child);
  return node;
}

// Кнопка удаления в два нажатия вместо confirm().
function deleteButton(onConfirm: () => void, disabledReason?: string) {
  const button = el('button', { type: 'button', class: 'btn btn-small btn-danger', textContent: 'Удалить' });
  if (disabledReason) {
    button.disabled = true;
    button.title = disabledReason;
    return button;
  }
  let timer: number | undefined;
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (button.dataset.armed) {
      clearTimeout(timer);
      onConfirm();
      return;
    }
    button.dataset.armed = '1';
    button.textContent = 'Точно удалить?';
    timer = window.setTimeout(() => {
      delete button.dataset.armed;
      button.textContent = 'Удалить';
    }, 3000);
  });
  return button;
}

export function mountCatalogAdmin(options: Options) {
  let catalog: Catalog = { categories: [], products: [] };
  let baseline = JSON.stringify(catalog);
  const uploads = new Map<string, Blob>();
  const previews = new Map<string, string>();

  const statusEl = byId('status');
  const dirtyEl = byId('dirty');
  const issuesEl = byId('issues');
  const productList = byId('product-list');
  const categoryList = byId('category-list');
  const search = byId<HTMLInputElement>('product-search');
  const filter = byId<HTMLSelectElement>('product-filter');

  const setStatus = (text: string, tone: Tone = 'info') => {
    statusEl.textContent = text;
    statusEl.dataset.tone = tone;
  };

  const isDirty = () => JSON.stringify(catalog) !== baseline;
  const categoryName = (id: string) => catalog.categories.find((c) => c.id === id)?.name ?? `«${id}» (нет такой)`;
  const countIn = (id: string) => catalog.products.filter((p) => p.category === id).length;

  function imageSrc(path?: string) {
    if (!path) return '';
    return previews.get(path) ?? (/^(https?:|data:|blob:)/.test(path) ? path : options.imageSrc(path));
  }

  function thumb(path?: string) {
    return path ? el('img', { src: imageSrc(path), alt: '', loading: 'lazy', class: 'thumb' }) : el('span', { class: 'thumb thumb-empty', textContent: 'нет фото' });
  }

  // ---------------------------------------------------------- отрисовка

  function render() {
    document.querySelector('[data-count="products"]')!.textContent = String(catalog.products.length);
    document.querySelector('[data-count="categories"]')!.textContent = String(catalog.categories.length);

    const current = filter.value;
    filter.replaceChildren(el('option', { value: '', textContent: 'Все категории' }), ...catalog.categories.map((c) => el('option', { value: c.id, textContent: c.name })));
    filter.value = catalog.categories.some((c) => c.id === current) ? current : '';

    renderProducts();
    renderCategories();

    const errors = validateCatalog(catalog);
    issuesEl.replaceChildren(...errors.map((text) => el('li', { textContent: text })));
    issuesEl.hidden = errors.length === 0;
    dirtyEl.hidden = !isDirty();
  }

  function renderProducts() {
    const query = search.value.trim().toLowerCase();
    const items = catalog.products.filter(
      (p) => (!filter.value || p.category === filter.value) && (!query || p.name.toLowerCase().includes(query) || p.id.includes(query)),
    );
    if (!items.length) {
      productList.replaceChildren(el('li', { class: 'cms-empty', textContent: catalog.products.length ? 'Ничего не найдено' : 'Товаров пока нет' }));
      return;
    }
    productList.replaceChildren(
      ...items.map((p) => {
        const meta = [categoryName(p.category), p.price !== undefined && `${priceFormat.format(p.price)} ₸`, p.weight].filter(Boolean).join(' · ');
        const item = el(
          'li',
          { class: 'cms-item' },
          thumb(p.image),
          el(
            'div',
            { class: 'cms-item-text' },
            el('strong', { textContent: p.name }),
            el('span', { class: 'meta', textContent: meta }),
            p.available === false && el('span', { class: 'badge', textContent: 'Нет в наличии' }),
          ),
          el(
            'div',
            { class: 'cms-item-actions' },
            el('button', { type: 'button', class: 'btn btn-small', textContent: 'Изменить', onclick: () => openProduct(p) }),
            deleteButton(() => {
              catalog.products = catalog.products.filter((x) => x !== p);
              changed(`Товар «${p.name}» удалён`);
            }),
          ),
        );
        item.addEventListener('dblclick', () => openProduct(p));
        return item;
      }),
    );
  }

  function renderCategories() {
    if (!catalog.categories.length) {
      categoryList.replaceChildren(el('li', { class: 'cms-empty', textContent: 'Категорий пока нет' }));
      return;
    }
    categoryList.replaceChildren(
      ...catalog.categories.map((c, i) => {
        const count = countIn(c.id);
        const move = (to: number) => {
          const list = [...catalog.categories];
          [list[i], list[to]] = [list[to], list[i]];
          catalog.categories = list;
          changed();
        };
        return el(
          'li',
          { class: 'cms-item' },
          el(
            'div',
            { class: 'cms-item-text' },
            el('strong', { textContent: c.name }),
            el('span', { class: 'meta', textContent: `/catalog/${c.id}/ · товаров: ${count}` }),
            c.description && el('span', { class: 'meta', textContent: c.description }),
          ),
          el(
            'div',
            { class: 'cms-item-actions' },
            el('button', { type: 'button', class: 'btn btn-small btn-icon', textContent: '↑', title: 'Выше', disabled: i === 0, onclick: () => move(i - 1) }),
            el('button', { type: 'button', class: 'btn btn-small btn-icon', textContent: '↓', title: 'Ниже', disabled: i === catalog.categories.length - 1, onclick: () => move(i + 1) }),
            el('button', { type: 'button', class: 'btn btn-small', textContent: 'Изменить', onclick: () => openCategory(c) }),
            deleteButton(
              () => {
                catalog.categories = catalog.categories.filter((x) => x !== c);
                changed(`Категория «${c.name}» удалена`);
              },
              count ? `Сначала перенесите или удалите товары категории (${count})` : undefined,
            ),
          ),
        );
      }),
    );
  }

  function changed(message?: string) {
    render();
    if (message) setStatus(message, 'ok');
  }

  search.addEventListener('input', renderProducts);
  filter.addEventListener('change', renderProducts);

  // ---------------------------------------------------------- вкладки

  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-tab]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const t of tabs) t.setAttribute('aria-selected', String(t === tab));
      for (const panel of document.querySelectorAll<HTMLElement>('[data-panel]')) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    });
  }

  // ---------------------------------------------------------- общая логика форм

  function setupDialog(dialogId: string, formId: string, onSubmit: (form: HTMLFormElement) => string | null) {
    const dialog = byId<HTMLDialogElement>(dialogId);
    const form = byId<HTMLFormElement>(formId);
    const errorEl = form.querySelector<HTMLElement>('[data-error]')!;
    const idInput = form.elements.namedItem('id') as HTMLInputElement;
    const nameInput = form.elements.namedItem('name') as HTMLInputElement;
    const idPreview = form.querySelector<HTMLElement>('[data-id-preview]')!;
    let idTouched = false;

    const showId = () => (idPreview.textContent = idInput.value || '…');
    nameInput.addEventListener('input', () => {
      if (!idTouched) idInput.value = slugify(nameInput.value);
      showId();
    });
    idInput.addEventListener('input', () => {
      idTouched = true;
      showId();
    });
    form.querySelector('[data-cancel]')!.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const error = onSubmit(form);
      errorEl.textContent = error ?? '';
      if (!error) dialog.close();
    });

    return {
      form,
      open(title: string, isNew: boolean) {
        form.querySelector('h2')!.textContent = title;
        errorEl.textContent = '';
        idTouched = !isNew; // у существующей записи ID не следует за названием
        showId();
        dialog.showModal();
        nameInput.focus();
      },
    };
  }

  const field = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const text = (form: HTMLFormElement, name: string) => field(form, name).value.trim();

  function checkId(id: string, taken: boolean) {
    if (!ID_RE.test(id)) return 'ID: только латиница в нижнем регистре, цифры и дефисы';
    if (taken) return `ID «${id}» уже занят`;
    return null;
  }

  // ---------------------------------------------------------- товар

  let editingProduct: Product | null = null;
  const productDialog = setupDialog('product-dialog', 'product-form', (form) => {
    const name = text(form, 'name');
    const id = text(form, 'id');
    const category = text(form, 'category');
    const priceRaw = text(form, 'price');
    if (!name) return 'Укажите название';
    const idError = checkId(id, catalog.products.some((p) => p.id === id && p !== editingProduct));
    if (idError) return idError;
    if (!category) return 'Выберите категорию';
    if (priceRaw && !(Number(priceRaw) >= 0)) return 'Цена должна быть неотрицательным числом';

    const product: Product = { id, name, category };
    if (priceRaw) product.price = Number(priceRaw);
    if (text(form, 'weight')) product.weight = text(form, 'weight');
    if (text(form, 'description')) product.description = text(form, 'description');
    if (text(form, 'image')) product.image = text(form, 'image');
    product.available = field(form, 'available').checked;

    if (editingProduct) catalog.products = catalog.products.map((p) => (p === editingProduct ? product : p));
    else catalog.products = [...catalog.products, product];
    changed(editingProduct ? `Товар «${name}» изменён` : `Товар «${name}» добавлен`);
    return null;
  });

  const productForm = productDialog.form;
  const photoPreview = byId('photo-preview');
  const imageInput = field(productForm, 'image');
  const showPhoto = () => photoPreview.replaceChildren(imageInput.value.trim() ? el('img', { src: imageSrc(imageInput.value.trim()), alt: 'Превью фото' }) : el('span', { textContent: 'Нет фото' }));
  imageInput.addEventListener('input', showPhoto);

  const photoFile = document.getElementById('photo-file') as HTMLInputElement | null;
  if (photoFile && options.prepareUpload) {
    photoFile.addEventListener('change', async () => {
      const file = photoFile.files?.[0];
      photoFile.value = '';
      if (!file) return;
      const errorEl = productForm.querySelector<HTMLElement>('[data-error]')!;
      errorEl.textContent = 'Обработка фото…';
      try {
        const upload = await options.prepareUpload!(file, text(productForm, 'id') || text(productForm, 'name') || 'photo');
        uploads.set(upload.path, upload.blob);
        previews.set(upload.path, URL.createObjectURL(upload.blob));
        imageInput.value = upload.path;
        showPhoto();
        errorEl.textContent = '';
      } catch (e) {
        errorEl.textContent = (e as Error).message;
      }
    });
  }

  function openProduct(product?: Product) {
    if (!catalog.categories.length) {
      setStatus('Сначала создайте хотя бы одну категорию', 'error');
      return;
    }
    editingProduct = product ?? null;
    const p: Partial<Product> = product ?? { category: filter.value || catalog.categories[0].id, available: true };
    const select = field(productForm, 'category') as unknown as HTMLSelectElement;
    select.replaceChildren(...catalog.categories.map((c) => el('option', { value: c.id, textContent: c.name })));
    field(productForm, 'name').value = p.name ?? '';
    field(productForm, 'id').value = p.id ?? '';
    select.value = p.category ?? '';
    field(productForm, 'price').value = p.price === undefined ? '' : String(p.price);
    field(productForm, 'weight').value = p.weight ?? '';
    field(productForm, 'description').value = p.description ?? '';
    imageInput.value = p.image ?? '';
    field(productForm, 'available').checked = p.available !== false;
    showPhoto();
    productDialog.open(product ? 'Товар' : 'Новый товар', !product);
  }

  byId('add-product').addEventListener('click', () => openProduct());

  // ---------------------------------------------------------- категория

  let editingCategory: Category | null = null;
  const categoryDialog = setupDialog('category-dialog', 'category-form', (form) => {
    const name = text(form, 'name');
    const id = text(form, 'id');
    if (!name) return 'Укажите название';
    const idError = checkId(id, catalog.categories.some((c) => c.id === id && c !== editingCategory));
    if (idError) return idError;

    const category: Category = { id, name };
    if (text(form, 'description')) category.description = text(form, 'description');

    if (editingCategory) {
      const oldId = editingCategory.id;
      catalog.categories = catalog.categories.map((c) => (c === editingCategory ? category : c));
      // При смене ID категории переносим на него товары.
      if (oldId !== id) catalog.products = catalog.products.map((p) => (p.category === oldId ? { ...p, category: id } : p));
    } else {
      catalog.categories = [...catalog.categories, category];
    }
    changed(editingCategory ? `Категория «${name}» изменена` : `Категория «${name}» добавлена`);
    return null;
  });

  function openCategory(category?: Category) {
    editingCategory = category ?? null;
    const form = categoryDialog.form;
    field(form, 'name').value = category?.name ?? '';
    field(form, 'id').value = category?.id ?? '';
    field(form, 'description').value = category?.description ?? '';
    categoryDialog.open(category ? 'Категория' : 'Новая категория', !category);
  }

  byId('add-category').addEventListener('click', () => openCategory());

  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) e.preventDefault();
  });

  // ---------------------------------------------------------- API для страницы

  return {
    get catalog(): Catalog {
      return catalog;
    },
    load(next: Catalog, message?: string) {
      catalog = { categories: next.categories ?? [], products: next.products ?? [] };
      baseline = JSON.stringify(catalog);
      render();
      if (message) setStatus(message, 'ok');
    },
    /** Загруженные в этой сессии фото, на которые ссылается каталог. */
    pendingUploads(): Upload[] {
      const used = new Set(catalog.products.map((p) => p.image));
      return [...uploads].filter(([path]) => used.has(path)).map(([path, blob]) => ({ path, blob }));
    },
    /** Считать текущее состояние сохранённым (после экспорта или публикации). */
    markSaved() {
      baseline = JSON.stringify(catalog);
      uploads.clear(); // превью оставляем: файлы появятся на сайте только после сборки
      render();
    },
    errors: () => validateCatalog(catalog),
    isDirty,
    setStatus,
  };
}
