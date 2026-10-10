// Подготовка фото перед загрузкой: уменьшаем до 1600 px по длинной стороне и кодируем в WebP
// (или в JPEG, если браузер не умеет WebP). Так файл обычно весит 100–400 КБ.
import { slugify, type Upload } from './catalog-admin';

const MAX_SIDE = 1600;

function encode(canvas: HTMLCanvasElement, type: string) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
}

export async function prepareUpload(file: File, name: string): Promise<Upload> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Поддерживаются фото в JPEG, PNG и WebP');

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  let blob = await encode(canvas, 'image/webp');
  let ext = 'webp';
  if (!blob || blob.type !== 'image/webp') {
    blob = await encode(canvas, 'image/jpeg');
    ext = 'jpg';
  }
  if (!blob) throw new Error('Не удалось обработать фото');

  const base = slugify(name) || 'photo';
  return { path: `/uploads/${base}-${Date.now().toString(36)}.${ext}`, blob };
}
