// «Материалы к открытию»: файлы из общей папки Google Диска, всегда в актуальной версии.
// Папку читает ваш Apps Script (видит всё, к чему есть доступ у вашего аккаунта).
// Файлы берутся по словам в названии, поэтому новая версия с другой датой подхватывается сама.
import { h, icon, fmtDate, fmtSize, plural } from '../util.js';
import { S, update, emit, CONTACT_LISTS, sessionLabel, activeFile, setActiveFile } from '../store.js';
import { openModal, toast, withBusy, promptDlg, formDlg, confirmDlg } from '../ui.js';
import { driveOn, listFolder, fileInfo, fetchExternal } from '../drive.js';
import { analyze, storeAnalyzed, getBytes, dropFile } from '../files.js';
import { deliver } from '../output.js';
import { blocksToPdf, buildPrint } from '../pdf.js';
import { openExternal } from '../tg.js';
import { tabSettingsDlg } from './settings.js';

const TG_LIMIT = 49 * 1024 * 1024; // предел отправки ботом в Telegram
const AUTO_LIMIT = 25 * 1024 * 1024; // сами скачиваем только файлы до 25 МБ
const CHECK_EVERY = 6 * 3600 * 1000;

const low = (x) => String(x || '').toLowerCase().replace(/ё/g, 'е');
export function folderIdOf(url) {
  const m = String(url || '').match(/folders\/([A-Za-z0-9_-]{10,})/) || String(url || '').match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : (/^[A-Za-z0-9_-]{20,}$/.test(String(url || '').trim()) ? String(url).trim() : '');
}
const groupOf = (f) => S.materials.groups.find((g) => g.words.some((w) => low(f.name).includes(low(w))));
const extOf = (f) => (/\.docx$/i.test(f.name) || f.mime === 'application/vnd.google-apps.document' ? 'docx' : /\.xlsx$/i.test(f.name) || /spreadsheet/.test(f.mime || '') ? 'xlsx' : /\.pdf$/i.test(f.name) || f.mime === 'application/pdf' ? 'pdf' : 'other');
const isNewer = (f) => !!(f.meta && f.storedModified && f.modified && f.modified > f.storedModified);

// ---------- проверка папки ----------
let checking = null;
export function checkFolder({ silent = false } = {}) {
  if (checking) return checking;
  const id = S.materials.folderId || folderIdOf(S.materials.folderUrl);
  if (!driveOn() || !id) return Promise.resolve();
  checking = (async () => {
    try {
      const r = await listFolder(id);
      const seen = new Set();
      update((st) => {
        for (const f of r.files) {
          if (!groupOf(f)) continue;
          seen.add(f.id);
          const cur = st.materials.files[f.id] || {};
          st.materials.files[f.id] = { ...cur, ...f };
        }
        // файл убрали из папки или переименовали так, что он больше не подходит
        for (const [fid, f] of Object.entries(st.materials.files)) if (!seen.has(fid)) f.missing = true; else delete f.missing;
        st.materials.lastCheck = new Date().toISOString();
        st.materials.error = '';
        st.materials.folderName = r.folder;
      });
      // небольшие файлы скачиваем сразу, большие — по кнопке
      const todo = Object.values(S.materials.files).filter((f) => !f.missing && f.size <= AUTO_LIMIT && (!f.meta || isNewer(f)));
      for (const f of todo) { try { await download(f, { quiet: true }); } catch (e) { console.warn(e); } }
      if (!silent) toast('Папка проверена');
    } catch (e) {
      update((st) => { st.materials.error = e.message; });
      if (!silent) toast('Не удалось проверить папку: ' + e.message, 'warn');
    } finally { checking = null; emit(); }
  })();
  return checking;
}

async function storeBytes(bytes, name, kind, step) {
  if (kind === 'pdf') {
    const info = await analyze(new File([bytes], name), step);
    return storeAnalyzed(info, { compression: 'auto', noDrive: true, padEven: true, onStep: step });
  }
  return storeAnalyzed({ original: bytes, pages: 0, text: '', name, kind: kind === 'docx' ? 'docx' : kind === 'xlsx' ? 'xlsx' : 'other' }, { noDrive: true });
}

async function download(f, { quiet = false } = {}) {
  const kind = extOf(f);
  const run = async (step) => {
    const { bytes } = await fetchExternal(f.id, (got, total) => step(`Скачиваю: ${fmtSize(got)} из ${fmtSize(total)}`));
    const name = /\.(pdf|docx|xlsx)$/i.test(f.name) ? f.name : f.name + '.' + (kind === 'other' ? 'pdf' : kind);
    const meta = await storeBytes(bytes, name, kind, step);
    const old = S.materials.files[f.id] && S.materials.files[f.id].meta;
    update((st) => { Object.assign(st.materials.files[f.id], { meta, storedModified: f.modified, downloadedAt: new Date().toISOString() }); });
    if (old) dropFile(old);
    if (f.id && groupOf(f) && groupOf(f).participants && kind === 'docx') await parseParticipants(f.id, bytes);
    return meta;
  };
  return quiet ? run(() => {}) : withBusy('Скачиваю «' + f.name + '»…', run);
}

// ---------- рабочая группа из «Порядка открытия» ----------
async function docxText(bytes) {
  if (!window.JSZip) await new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = new URL('../../vendor/jszip.min.js', import.meta.url).href; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); });
  const zip = await window.JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml').async('string');
  return xml.split(/<\/w:p>/).map((p) => p.replace(/<w:tab\/>/g, ' ').replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim());
}

export function splitParticipants(text) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of text.replace(/\.\s*$/, '')) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && !depth) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = x.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    return m ? { name: m[1].trim(), phone: m[2].trim() } : { name: x, phone: '' };
  });
}

async function parseParticipants(fileId, bytes) {
  const paras = await docxText(bytes);
  let i = paras.findIndex((p) => /^участники\s*:?/i.test(p));
  if (i < 0) return;
  let text = paras[i].replace(/^участники\s*:?/i, '').trim();
  if (!text) { while (++i < paras.length && !paras[i]); text = paras[i] || ''; }
  const groupName = (paras.find((p) => /^название группы/i.test(p)) || '').replace(/^название группы\s*:?/i, '').trim();
  update((st) => { st.materials.team = { people: splitParticipants(text), groupName, fileId, at: new Date().toISOString() }; });
}

// телефон из «Контактов», если в документе его нет
function phoneFromContacts(name) {
  const [a, b] = low(name).split(/\s+/);
  for (const rows of Object.values(S.directory || {})) {
    for (const r of rows) if (!r.section && a && b && low(r.name).includes(a) && low(r.name).includes(b) && r.phone) return r.phone.split(/,\s*/).find((x) => /^8|^\+7/.test(x)) || r.phone;
  }
  for (const key of Object.keys(CONTACT_LISTS)) {
    for (const c of S.lists[key] || []) {
      const n = low(c.name);
      if (a && b && n.includes(a) && n.includes(b) && c.phone) return c.phone;
    }
  }
  return '';
}
function teamRows() {
  const t = S.materials.team;
  if (!t) return [];
  return t.people.map((p) => {
    const fromC = p.phone ? '' : phoneFromContacts(p.name);
    let name = p.name;
    if (/^директор магазина$/i.test(name) && S.session.manager.fio) name = `${S.session.manager.fio} (директор магазина)`;
    return { name, phone: p.phone || fromC || (/директор магазина/i.test(name) ? S.session.manager.phone || '' : ''), source: p.phone ? '' : fromC ? 'из Контактов' : '' };
  });
}
const teamGroupName = () => [S.session.osp, S.session.city ? `г. ${S.session.city}` : '', S.session.address].filter(Boolean).join(', ');

// ---------- отрисовка ----------
export function renderMaterials(tab, root) {
  const m = S.materials;
  const on = driveOn();
  const folderSet = !!(m.folderId || folderIdOf(m.folderUrl));
  if (on && folderSet && (!m.lastCheck || Date.now() - new Date(m.lastCheck).getTime() > CHECK_EVERY)) setTimeout(() => checkFolder({ silent: true }), 300);

  root.append(h('div', { class: 'tab-head glass' },
    h('div', { class: 'tab-head-row' },
      h('div', null,
        h('h1', { class: 'tab-title' }, tab.title),
        h('p', { class: 'tab-sub' }, m.lastCheck ? `Проверено ${fmtDate(m.lastCheck)} ${new Date(m.lastCheck).toTimeString().slice(0, 5)}` + (m.folderName ? ` · папка «${m.folderName}»` : '') : 'Файлы из общей папки на Google Диске'),
      ),
      h('button', { class: 'icon-btn glass-btn', 'aria-label': 'Настройки вкладки', onClick: () => tabSettingsDlg(tab) }, icon('gear')),
    ),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn ghost sm', onClick: folderDlg }, icon('pencil'), 'Папка и правила'),
      h('button', { class: 'btn primary sm grow', disabled: !on || !folderSet, onClick: () => checkFolder().then(() => {}) }, icon('refresh'), checking ? 'Проверяю…' : 'Проверить обновления'),
    ),
  ));

  if (!on) root.append(h('p', { class: 'note warn card glass' }, 'Подключите Google Диск в настройках приложения: папку с материалами читает ваш Apps Script.'));
  else if (!folderSet) root.append(h('p', { class: 'note warn card glass' }, 'Укажите ссылку на папку «Материалы к открытию» — кнопка «Папка и правила».'));
  if (m.error) root.append(h('p', { class: 'note warn card glass' }, 'Ошибка проверки: ' + m.error));

  const files = Object.values(m.files);
  for (const g of m.groups) {
    const list = files.filter((f) => groupOf(f) === g).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const card = h('section', { class: 'card glass' },
      h('div', { class: 'card-head' }, h('h2', null, g.title), h('span', { class: 'pill', title: g.words.join(' · ') }, g.words.length > 4 ? `${g.words.length} названий` : g.words.join(' · '))),
      h('div', { class: 'doc-list' }, list.length ? list.map(fileRow) : h('p', { class: 'empty' }, folderSet && on ? 'Подходящих файлов пока нет. Нажмите «Проверить обновления».' : 'Пока пусто.')),
      g.participants ? teamBlock() : null,
    );
    root.append(card);
  }
}

function fileRow(f) {
  const kind = extOf(f);
  const big = f.size > AUTO_LIMIT;
  const status = f.missing ? h('span', { class: 'badge red' }, 'не найден в папке')
    : !f.meta ? h('span', { class: 'badge yellow' }, big ? 'не скачан (большой)' : 'не скачан')
      : isNewer(f) ? h('span', { class: 'badge hot' }, 'обновлён ' + fmtDate(f.modified)) : h('span', { class: 'badge ok' }, 'актуальный');
  const meta = [
    f.path ? f.path : '',
    'изменён ' + fmtDate(f.modified),
    'на Диске ' + fmtSize(f.size),
    f.meta ? (f.meta.pages ? plural(f.meta.pages, f.meta.pages + ' страница', f.meta.pages + ' страницы', f.meta.pages + ' страниц') + ' · ' : '') + 'у нас ' + fmtSize(f.meta.size) : '',
  ].filter(Boolean).join(' · ');
  return h('div', { class: 'doc-row' + (isNewer(f) ? ' is-hot' : '') },
    h('div', { class: 'doc-main' },
      h('div', { class: 'doc-title-row' }, h('span', { class: 'doc-title' }, f.name), status),
      h('div', { class: 'doc-meta' }, meta),
    ),
    f.meta && !isNewer(f) ? h('button', { class: 'icon-btn', 'aria-label': 'Печать или отправка', onClick: () => output(f) }, icon('print')) : null,
    h('button', { class: 'icon-btn', 'aria-label': f.meta ? 'Обновить' : 'Скачать', onClick: () => download(f).catch((e) => toast('Не скачалось: ' + e.message, 'warn')) }, icon(f.meta ? 'refresh' : 'upload')),
    h('button', { class: 'icon-btn', 'aria-label': 'Открыть на Google Диске', onClick: () => openExternal(f.url || `https://drive.google.com/file/d/${f.id}/view`) }, icon('file')),
  );
}

async function output(f) {
  const kind = extOf(f);
  const bytes = await getBytes(f.meta);
  const name = f.name.replace(/\.(pdf|docx|xlsx)$/i, '');
  if (kind === 'pdf' && bytes.length > TG_LIMIT) {
    toast(`После сжатия файл весит ${fmtSize(bytes.length)} — больше лимита Telegram. Скачайте его или откройте на Диске.`, 'warn');
  }
  return deliver(bytes, name, { duplex: kind === 'pdf', word: kind === 'docx', excel: kind === 'xlsx' });
}

function teamBlock() {
  const rows = teamRows();
  const t = S.materials.team;
  if (!t) return h('p', { class: 'note' }, 'Список появится, когда «Порядок открытия» будет скачан.');
  const text = () => [`Группа: ${teamGroupName() || '[номер, адрес магазина]'}`, ...rows.map((r) => `${r.name}${r.phone ? ' — ' + r.phone : ''}`)].join('\n');
  return h('div', { class: 'team' },
    h('h3', { class: 'sub-h' }, 'Участники группы открытия в МАХ'),
    h('p', { class: 'cap' }, 'Название группы: ' + (teamGroupName() || 'номер и адрес магазина из вводных')),
    h('ul', { class: 'plain-list' }, rows.map((r) => h('li', null, h('strong', null, r.name), r.phone ? ' — ' + r.phone : h('span', { class: 'muted' }, ' — нет телефона'), r.source ? h('span', { class: 'cap' }, ' (' + r.source + ')') : null))),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn ghost sm', onClick: async () => { try { await navigator.clipboard.writeText(text()); toast('Список скопирован'); } catch (e) { promptDlg('Скопируйте список', { value: text(), multiline: true, okLabel: 'Готово' }); } } }, 'Скопировать'),
      h('button', { class: 'btn ghost sm', onClick: printTeam }, icon('print'), 'Печать'),
    ),
    h('p', { class: 'cap' }, `Из документа от ${fmtDate(t.at)}. Список обновляется вместе с «Порядком открытия».`),
  );
}

async function printTeam() {
  const rows = teamRows();
  const blocks = [
    { t: 'h1', text: 'Рабочая группа по открытию магазина', sub: sessionLabel(S.session) },
    { t: 'kv', rows: [['Название группы', teamGroupName() || '________________']] },
    { t: 'table', head: ['№', 'Участник', 'Телефон'], widths: [0.08, 0.55, 0.37], rows: rows.map((r, i) => [String(i + 1), r.name, r.phone]) },
  ];
  const bytes = await withBusy('Собираю…', async () => {
    const { pngs, size } = await blocksToPdf(blocks);
    return buildPrint({ parts: [{ title: 'Рабочая группа', pngs, size, duplex: false }] });
  });
  return deliver(bytes, 'Рабочая группа по открытию — ' + sessionLabel(S.session));
}

async function folderDlg() {
  const m = S.materials;
  const v = await formDlg('Папка и правила', [
    { key: 'url', label: 'Ссылка на папку на Google Диске', value: m.folderUrl || '' },
    ...m.groups.map((g) => ({ key: 'g_' + g.id, label: `${g.title}: слова в названии через ;`, value: g.words.join('; ') })),
  ]);
  if (!v) return;
  update((st) => {
    st.materials.folderUrl = v.url.trim();
    st.materials.folderId = folderIdOf(v.url);
    for (const g of st.materials.groups) {
      const w = (v['g_' + g.id] || '').split(';').map((x) => x.trim()).filter(Boolean);
      if (w.length) g.words = w;
    }
    st.materials.lastCheck = null;
  });
  if (driveOn() && S.materials.folderId) checkFolder();
}

// ---------- документы «Памяток» с Google Диска (памятка сотрудникам) ----------
export async function fetchDriveDoc(d, { force = false } = {}) {
  if (!driveOn()) throw new Error('Подключите Google Диск в настройках, чтобы скачать файл');
  const info = await fileInfo(d.drive.id);
  const have = activeFile(d);
  if (have && !force) return have;
  if (have && d.drive.modified && info.modified <= d.drive.modified) { toast('На Диске та же версия'); return have; }
  return withBusy('Скачиваю «' + info.name + '»…', async (step) => {
    const { bytes } = await fetchExternal(d.drive.id, (got, total) => step(`Скачиваю: ${fmtSize(got)} из ${fmtSize(total)}`));
    const meta = await storeBytes(bytes, info.name, 'pdf', step);
    update(() => { setActiveFile(d, meta); d.drive.modified = info.modified; d.drive.name = info.name; d.skippedSession = null; });
    if (have) dropFile(have);
    toast(have ? 'Обновлено с Диска' : 'Скачано с Диска');
    return meta;
  });
}

// Раз в 6 часов: не обновились ли файлы «Памяток» на Диске
export async function checkDriveDocs() {
  if (!driveOn()) return;
  for (const d of Object.values(S.docs)) {
    if (!d.drive || !d.drive.id) continue;
    try {
      const info = await fileInfo(d.drive.id);
      if (!activeFile(d) || (d.drive.modified && info.modified > d.drive.modified)) await fetchDriveDoc(d, { force: true });
    } catch (e) { console.warn('Диск', e); }
  }
}
