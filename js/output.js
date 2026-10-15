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

export async function deliver(bytes, filename, { duplex = false, word = false, excel = false, zip = false, note = '' } = {}) {
  const ext = zip ? '.zip' : excel ? '.xlsx' : word ? '.docx' : '.pdf';
  const mime = zip ? 'application/zip' : excel ? XLSX : word ? DOCX : 'application/pdf';
  const office = word || excel || zip;
  const name = docName(filename).replace(/\s*\/\s*/g, ' - ').replace(/[\\/:*?"<>|]+/g, ' ').trim() + ext;
  const n = office ? 0 : await pageCount(bytes);
  haptic('success');
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const canChat = driveOn() && (inTelegram || S.settings.drive.chatId);

  const hint = zip ? 'Архив с файлами Word: распакуйте и печатайте из Word — вёрстка как в ваших исходных файлах.' : excel ? 'Файл Excel в вашей корпоративной форме: печатайте из Excel, масштаб «на одну страницу» уже задан.' : word ? 'Файл Word в вашей корпоративной форме: откройте и печатайте из Word.' : duplex
    ? 'Печать: двусторонняя, переворот по длинному краю. Пустые страницы уже добавлены, документы не залезут друг на друга.'
    : 'Печать: односторонняя.';

  const body = h('div', { class: 'deliver' },
    h('div', { class: 'deliver-file' }, icon('file'), h('div', null, h('strong', null, name), h('small', null, office ? `${zip ? 'ZIP' : excel ? 'Excel' : 'Word'} · ${fmtSize(bytes.length)}` : `${pagesWord(n)} · ${fmtSize(bytes.length)}`))),
    h('p', { class: 'note' }, hint),
    note ? h('p', { class: 'note warn' }, note) : null,
    inTelegram && !driveOn()
      ? h('p', { class: 'note warn' }, 'Внутри Telegram скачивание файлов работает не на всех устройствах. Подключите Google Диск в настройках, и готовый файл будет приходить прямо в чат с ботом.')
      : null,
  );

  const actions = [];
  if (canChat) {
    actions.push({ label: 'Отправить в чат', kind: 'primary', keepOpen: true, onClick: async () => {
      try {
        await withBusy('Отправляю в Telegram…', () => sendToChat(bytes, name, name.replace(/\.[a-z]+$/i, '')));
        toast('Файл отправлен в чат с ботом');
      } catch (e) { toast('Не отправилось: ' + e.message, 'warn'); }
    } });
  }
  if (driveOn()) {
    actions.push({ label: 'На Google Диск', kind: canChat ? 'ghost' : 'primary', keepOpen: true, onClick: async () => {
      try {
        const link = await withBusy('Сохраняю на Диск…', () => saveForPrint(bytes, name, mime));
        toast('Сохранено в папку «Печать»');
        if (link) openExternal(link);
      } catch (e) { toast('Ошибка Диска: ' + e.message, 'warn'); }
    } });
  }
  actions.push({ label: 'Скачать', kind: actions.length ? 'ghost' : 'primary', keepOpen: true, onClick: () => {
    const a = h('a', { href: url, download: name, style: { display: 'none' } });
    document.body.appendChild(a); a.click(); a.remove();
  } });
  if (!inTelegram && !office) {
    actions.push({ label: 'Открыть для печати', kind: 'ghost', keepOpen: true, onClick: () => window.open(url, '_blank') });
  }

  await openModal({ title: 'Файл готов', body, actions, onClose: () => setTimeout(() => URL.revokeObjectURL(url), 60000) }).promise;
}
