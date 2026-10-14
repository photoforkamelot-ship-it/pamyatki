// Хранение PDF: локально (IndexedDB) и, если подключено, копия на Google Диске.
import { fileGet, filePut, fileDel } from './db.js';
import { driveOn, uploadFile, downloadFile, removeFile } from './drive.js';
import { pageCount, extractText, compress } from './pdf.js';
import { S, tabById } from './store.js';
import { uid } from './util.js';
import { toast } from './ui.js';
import { docxTags } from './docx.js';

export async function getBytes(meta) {
  if (!meta) return null;
  let b = await fileGet(meta.key);
  if (!b && meta.driveId && driveOn()) {
    b = await downloadFile(meta.driveId);
    await filePut(meta.key, b);
  }
  if (!b) throw new Error('Файл не найден на этом устройстве. Подключите Google Диск или загрузите файл заново.');
  return b;
}

// Разбор нового файла: страницы, текст, сжатие
export async function analyze(file, onStep) {
  const original = new Uint8Array(await file.arrayBuffer());
  if (/\.docx$/i.test(file.name)) {
    onStep && onStep('Читаю Word-файл…');
    const tags = await docxTags(original).catch(() => { throw new Error('Файл не открылся как Word'); });
    return { original, pages: 0, text: '', name: file.name, kind: 'docx', tags };
  }
  onStep && onStep('Считаю страницы…');
  const pages = await pageCount(original);
  onStep && onStep('Читаю текст для сравнения…');
  const text = await extractText(original);
  return { original, pages, text, name: file.name };
}

export async function storeAnalyzed(info, { padEven = true, compression = S.settings.compression, tabId, onStep, noDrive = false } = {}) {
  onStep && onStep('Сжимаю файл…');
  const c = info.kind === 'docx' || info.kind === 'xlsx' || info.kind === 'other'
    ? { bytes: info.original, mode: 'none' }
    : await compress(info.original, compression, (i, n) => onStep && onStep(`Сжимаю: страница ${i} из ${n}`));
  const key = uid();
  await filePut(key, c.bytes);
  const meta = {
    key,
    name: info.name,
    pages: info.pages,
    size: c.bytes.length,
    origSize: info.original.length,
    compression: c.mode,
    uploadedAt: new Date().toISOString(),
    text: info.text,
    padEven,
    driveId: '',
    kind: info.kind || 'pdf',
    tags: info.tags || null,
  };
  if (driveOn() && S.settings.drive.autoSync && !noDrive) {
    onStep && onStep('Копирую на Google Диск…');
    try {
      const tab = tabId ? tabById(tabId) : null;
      meta.driveId = await uploadFile(c.bytes, info.name, tab ? tab.title : 'Файлы', meta.kind === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf');
    } catch (e) {
      toast('Не удалось сохранить на Диск: ' + e.message, 'warn');
    }
  }
  return meta;
}

export async function dropFile(meta) {
  if (!meta) return;
  await fileDel(meta.key);
  if (meta.driveId && driveOn()) removeFile(meta.driveId);
}
