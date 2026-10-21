// Выдача готового PDF: открыть/скачать, отправить в чат Telegram, сохранить на Диск.
import { h, fmtSize, pages as pagesWord, icon } from './util.js';
import { openModal, toast, withBusy } from './ui.js';
import { inTelegram, openExternal, haptic } from './tg.js';
import { driveOn, sendToChat, saveForPrint } from './drive.js';
import { pageCount } from './pdf.js';
import { S, sessionLabel } from './store.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Имя файла: «ПР22 Конверт кадровику Лысовой 16.10.26» — код ОСП, что внутри, дата
const RENAME = { 'Памятки / Бланки': 'Памятки', 'Деления': 'Деления полок' };
export function docName(title) {
  const s = S.session || {};
  const label = sessionLabel(s);
  const parts = String(title || '').split(/\s+—\s+/).map((p) => p.trim()).filter((p) => p && p !== label && p !== 'Word'
    && !/^\d{2}\.\d{2}\.\d{4}$/.test(p) && !(s.osp && (p === 'ОСП ' + s.osp || p === s.osp)) && !(s.city && p === s.city));
  const t = parts.map((p) => RENAME[p] || p).join(' ').replace(/\s*\/\s*/g, ' ').trim();
  const d = new Date();
  const date = [d.getDate(), d.getMonth() + 1].map((x) => String(x).padStart(2, '0')).join('.') + '.' + String(d.getFullYear()).slice(2);
  return [s.osp, t, date].filter(Boolean).join(' ');
}

const clean = (t) => docName(t).replace(/\s*\/\s*/g, ' - ').replace(/[\\/:*?"<>|]+/g, ' ').trim();
const KIND = { pdf: ['.pdf', 'application/pdf'], docx: ['.docx', DOCX], xlsx: ['.xlsx', XLSX], zip: ['.zip', 'application/zip'] };

// Шаг предпросмотра перед отправкой: все листы всех файлов; ✕ — убрать файл из отправки
export async function previewFiles(files, title = 'Предпросмотр') {
  const { renderThumbs } = await import('./pdf.js');
  const keep = new Set(files.map((_, i) => i));
  const body = h('div', { class: 'pv' });
  let m = null;
  const count = () => files.filter((f, i) => keep.has(i)).length;
  const sync = () => { if (m) m.setActions([{ label: 'Отмена', kind: 'ghost', value: null }, { label: `Отправить${files.length > 1 ? ' · ' + count() : ''}`, kind: 'primary', disabled: !count(), value: 'ok' }]); };
  const blocks = files.map((f, i) => {
    const grid = h('div', { class: 'thumbs pv-grid' });
    const info = h('span', null, f.kind === 'pdf' ? '…' : f.kind === 'zip' ? 'архив Word' : f.kind === 'xlsx' ? 'Excel' : 'Word');
    const x = h('button', { class: 'icon-btn pv-x', 'aria-label': 'Убрать из отправки', onClick: () => {
      keep.has(i) ? keep.delete(i) : keep.add(i);
      wrap.classList.toggle('off', !keep.has(i)); x.replaceChildren(icon(keep.has(i) ? 'close' : 'refresh')); x.setAttribute('aria-label', keep.has(i) ? 'Убрать из отправки' : 'Вернуть'); sync();
    } }, icon('close'));
    const wrap = h('div', { class: 'pv-file' }, h('div', { class: 'pv-head' }, h('b', null, f.name), info, x),
      f.kind === 'pdf' ? grid : h('p', { class: 'cap' }, f.kind === 'zip' ? 'Файлы Word в ваших формах — их PDF показаны рядом.' : 'Откроется в ' + (f.kind === 'xlsx' ? 'Excel' : 'Word') + '; PDF к нему — рядом.'));
    return { wrap, grid, info, f };
  });
  body.append(...blocks.map((b) => b.wrap));
  m = openModal({ title, body, wide: true });
  sync();
  (async () => {
    let total = 0;
    for (const b of blocks) {
      if (b.f.kind !== 'pdf') continue;
      try {
        const imgs = await renderThumbs(b.f.bytes, { count: 120, width: 104 });
        total += imgs.length;
        b.info.textContent = imgs.length >= 120 ? 'первые 120 стр.' : pagesWord(imgs.length);
        imgs.forEach((c, k) => b.grid.append(h('figure', { class: 'pv-page' }, c, h('figcaption', null, String(k + 1)))));
        m.setTitle(`${title} · ${pagesWord(total)}`);
      } catch (e) { b.info.textContent = 'не открылся'; }
    }
  })();
  const v = await m.promise;
  return v === 'ok' ? files.filter((_, i) => keep.has(i)) : null;
}

export async function deliver(bytes, filename, { duplex = false, word = false, excel = false, zip = false, note = '', also = [], noPreview = false } = {}) {
  const mainKind = zip ? 'zip' : excel ? 'xlsx' : word ? 'docx' : 'pdf';
  let files = [{ bytes, kind: mainKind, name: clean(filename) + KIND[mainKind][0], hint: '' },
    ...also.map((a) => { const k = a.kind || 'pdf'; return { bytes: a.bytes, kind: k, name: clean(a.filename) + KIND[k][0], hint: a.hint || '' }; })];
  if (!noPreview && S.settings.previewBeforeSend !== false) {
    files = await previewFiles(files);
    if (!files || !files.length) return;
  }
  const main = files[0];
  bytes = main.bytes;
  zip = main.kind === 'zip'; excel = main.kind === 'xlsx'; word = main.kind === 'docx';
  const office = main.kind !== 'pdf';
  const mime = KIND[main.kind][1];
  const name = main.name;
  const n = office ? 0 : await pageCount(bytes);
  haptic('success');
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const canChat = driveOn() && (inTelegram || S.settings.drive.chatId);
  // дополнительные файлы (например, PDF к Word) — отправляются и скачиваются вместе с основным
  const extra = await Promise.all(files.slice(1).map(async (a) => ({
    bytes: a.bytes, mime: KIND[a.kind][1], name: a.name, kind: a.kind,
    n: a.kind === 'pdf' ? await pageCount(a.bytes) : 0, url: URL.createObjectURL(new Blob([a.bytes], { type: KIND[a.kind][1] })), hint: a.hint || '',
  })));
  const allFiles = [{ bytes, name, mime, url }, ...extra];

  const hint = zip ? 'Архив с файлами Word: распакуйте и печатайте из Word — вёрстка как в ваших исходных файлах.' : excel ? 'Файл Excel в вашей корпоративной форме: печатайте из Excel, масштаб «на одну страницу» уже задан.' : word ? 'Файл Word в вашей корпоративной форме: откройте и печатайте из Word.' : duplex
    ? 'Печать: двусторонняя, переворот по длинному краю. Пустые страницы уже добавлены, документы не залезут друг на друга.'
    : 'Печать: односторонняя.';

  const body = h('div', { class: 'deliver' },
    h('div', { class: 'deliver-file' }, icon('file'), h('div', null, h('strong', null, name), h('small', null, office ? `${zip ? 'ZIP' : excel ? 'Excel' : 'Word'} · ${fmtSize(bytes.length)}` : `${pagesWord(n)} · ${fmtSize(bytes.length)}`))),
    h('p', { class: 'note' }, hint),
    ...extra.map((x) => h('div', null,
      h('div', { class: 'deliver-file' }, icon('file'), h('div', null, h('strong', null, x.name), h('small', null, `${x.kind === 'pdf' ? pagesWord(x.n) : x.kind === 'xlsx' ? 'Excel' : x.kind === 'zip' ? 'ZIP' : 'Word'} · ${fmtSize(x.bytes.length)}`))),
      x.hint ? h('p', { class: 'note' }, x.hint) : null)),
    note ? h('p', { class: 'note warn' }, note) : null,
    inTelegram && !driveOn()
      ? h('p', { class: 'note warn' }, 'Внутри Telegram скачивание файлов работает не на всех устройствах. Подключите Google Диск в настройках, и готовый файл будет приходить прямо в чат с ботом.')
      : null,
  );

  const actions = [];
  if (canChat) {
    actions.push({ label: 'Отправить в чат', kind: 'primary', keepOpen: true, onClick: async () => {
      try {
        await withBusy('Отправляю в Telegram…', async () => { for (const f of allFiles) await sendToChat(f.bytes, f.name, f.name.replace(/\.[a-z]+$/i, '')); });
        toast(allFiles.length > 1 ? `Файлы отправлены в чат с ботом: ${allFiles.length}` : 'Файл отправлен в чат с ботом');
      } catch (e) { toast('Не отправилось: ' + e.message, 'warn'); }
    } });
  }
  if (driveOn()) {
    actions.push({ label: 'На Google Диск', kind: canChat ? 'ghost' : 'primary', keepOpen: true, onClick: async () => {
      try {
        let link = '';
        await withBusy('Сохраняю на Диск…', async () => { for (const f of allFiles) { const l = await saveForPrint(f.bytes, f.name, f.mime); link = link || l; } });
        toast('Сохранено в папку «Печать»');
        if (link) openExternal(link);
      } catch (e) { toast('Ошибка Диска: ' + e.message, 'warn'); }
    } });
  }
  actions.push({ label: 'Скачать', kind: actions.length ? 'ghost' : 'primary', keepOpen: true, onClick: () => {
    allFiles.forEach((f, i) => setTimeout(() => {
      const a = h('a', { href: f.url, download: f.name, style: { display: 'none' } });
      document.body.appendChild(a); a.click(); a.remove();
    }, i * 400));
  } });
  if (!inTelegram && !office) {
    actions.push({ label: 'Открыть для печати', kind: 'ghost', keepOpen: true, onClick: () => window.open(url, '_blank') });
  }
  if (!inTelegram && extra.some((x) => x.kind === 'pdf')) {
    actions.push({ label: 'Открыть PDF', kind: 'ghost', keepOpen: true, onClick: () => window.open(extra.find((x) => x.kind === 'pdf').url, '_blank') });
  }

  await openModal({ title: 'Файл готов', body, actions, onClose: () => setTimeout(() => allFiles.forEach((f) => URL.revokeObjectURL(f.url)), 60000) }).promise;
}

// PDF к файлу Excel — как напечатал бы Excel (масштаб, поля, разрывы из файла)
export async function excelPdf(bytes, name, opts = {}) {
  try {
    const { xlsxToPdf } = await import('./xlsxpdf.js');
    const pdf = await withBusy('Собираю PDF…', (step) => xlsxToPdf(bytes, { ...opts, onProgress: (i, n) => step(`PDF: страница ${i} из ${n}`) }));
    return [{ bytes: pdf, filename: `${name} — ${sessionLabel(S.session)}`, hint: opts.hint || 'PDF: как печать из Excel — масштаб и поля из вашего файла.' }];
  } catch (e) { console.error(e); toast('PDF из Excel: ' + e.message, 'warn'); return []; }
}


// Несколько разных файлов одной отправкой (с предпросмотром): [{bytes, filename, kind: 'pdf'|'docx'|'xlsx', hint}]
export function deliverBundle(list, opts = {}) {
  if (!list.length) return;
  const [first, ...rest] = list;
  return deliver(first.bytes, first.filename, { ...opts, word: first.kind === 'docx', excel: first.kind === 'xlsx', also: rest });
}

// Плавающая кнопка-принтер (на всех вкладках, где есть печать). count — сколько отмечено (необязательно)
export function printFab(onClick, count = null) {
  return h('button', { class: 'print-fab' + (count === 0 ? ' empty' : ''), 'aria-label': 'Печать' + (count != null ? `: выбрано ${count}` : ''), onClick },
    icon('print'), count ? h('span', { class: 'print-fab-n' }, String(count)) : null);
}

// Окно «В печать»: список того, что можно напечатать, с галочками; дальше — предпросмотр и отправка
export function printChooser({ title = 'В печать', items, selected, onPrint }) {
  const sel = new Set(selected || items.map((x) => x.id));
  const box = h('div', { class: 'ps-list' });
  let m = null;
  const draw = () => {
    box.innerHTML = '';
    for (const it of items) {
      const id = 'pc' + it.id;
      const cb = h('input', { type: 'checkbox', id, class: 'check' });
      cb.checked = sel.has(it.id);
      cb.addEventListener('change', () => { cb.checked ? sel.add(it.id) : sel.delete(it.id); draw(); });
      box.append(h('label', { class: 'ps-row' + (cb.checked ? '' : ' off'), for: id }, cb, h('span', { class: 'check-box', 'aria-hidden': 'true' }),
        h('span', { class: 'ps-t' }, it.title), h('span', { class: 'ps-f' }, it.fmt || 'PDF')));
    }
    const n = items.filter((x) => sel.has(x.id)).length;
    if (m) {
      m.setTitle(`${title}: ${n} из ${items.length}`);
      m.setActions([
        items.length > 1 ? { label: n === items.length ? 'Снять все' : 'Выбрать все', kind: 'ghost', keepOpen: true, onClick: () => { if (n === items.length) sel.clear(); else items.forEach((x) => sel.add(x.id)); draw(); } } : null,
        { label: 'Предпросмотр', kind: 'primary', disabled: !n, onClick: () => setTimeout(() => onPrint(items.filter((x) => sel.has(x.id)).map((x) => x.id)), 50) },
      ]);
    }
  };
  m = openModal({ title, body: box, wide: true });
  draw();
  return m.promise;
}
