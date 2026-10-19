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

export async function deliver(bytes, filename, { duplex = false, word = false, excel = false, zip = false, note = '', also = [] } = {}) {
  const ext = zip ? '.zip' : excel ? '.xlsx' : word ? '.docx' : '.pdf';
  const mime = zip ? 'application/zip' : excel ? XLSX : word ? DOCX : 'application/pdf';
  const office = word || excel || zip;
  const name = docName(filename).replace(/\s*\/\s*/g, ' - ').replace(/[\\/:*?"<>|]+/g, ' ').trim() + ext;
  const n = office ? 0 : await pageCount(bytes);
  haptic('success');
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const canChat = driveOn() && (inTelegram || S.settings.drive.chatId);
  // дополнительные файлы (например, PDF к Word) — отправляются и скачиваются вместе с основным
  const extra = await Promise.all(also.map(async (a) => ({
    bytes: a.bytes, mime: 'application/pdf',
    name: docName(a.filename).replace(/\s*\/\s*/g, ' - ').replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.pdf',
    n: await pageCount(a.bytes), url: URL.createObjectURL(new Blob([a.bytes], { type: 'application/pdf' })), hint: a.hint || '',
  })));
  const allFiles = [{ bytes, name, mime, url }, ...extra];

  const hint = zip ? 'Архив с файлами Word: распакуйте и печатайте из Word — вёрстка как в ваших исходных файлах.' : excel ? 'Файл Excel в вашей корпоративной форме: печатайте из Excel, масштаб «на одну страницу» уже задан.' : word ? 'Файл Word в вашей корпоративной форме: откройте и печатайте из Word.' : duplex
    ? 'Печать: двусторонняя, переворот по длинному краю. Пустые страницы уже добавлены, документы не залезут друг на друга.'
    : 'Печать: односторонняя.';

  const body = h('div', { class: 'deliver' },
    h('div', { class: 'deliver-file' }, icon('file'), h('div', null, h('strong', null, name), h('small', null, office ? `${zip ? 'ZIP' : excel ? 'Excel' : 'Word'} · ${fmtSize(bytes.length)}` : `${pagesWord(n)} · ${fmtSize(bytes.length)}`))),
    h('p', { class: 'note' }, hint),
    ...extra.map((x) => h('div', null,
      h('div', { class: 'deliver-file' }, icon('file'), h('div', null, h('strong', null, x.name), h('small', null, `${pagesWord(x.n)} · ${fmtSize(x.bytes.length)}`))),
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
  if (!inTelegram && extra.length) {
    actions.push({ label: 'Открыть PDF', kind: 'ghost', keepOpen: true, onClick: () => window.open(extra[0].url, '_blank') });
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

