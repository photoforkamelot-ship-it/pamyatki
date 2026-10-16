// Контакты по регионам — как ваша таблица: ФИО | Направление | Телефон | Почта / примечание, с разделами.
// Каждую строку в каждом регионе можно изменить, удалить, добавить; общие строки — скопировать в другие регионы.
import { h, icon, fmtDate, uid, formatPhone } from '../util.js';
import { S, update, sessionLabel } from '../store.js';
import { openModal, confirmDlg, toast, withBusy, chipSelect, formDlg, choiceDlg, menu, promptDlg, pickFiles } from '../ui.js';
import { blocksToPdf, buildPrint } from '../pdf.js';
import { deliver } from '../output.js';
import { tabSettingsDlg, contactsDlg } from './settings.js';

let region = null, query = '';

export function directory() {
  if (!S.directory) S.directory = {};
  return S.directory;
}
const regions = () => [...new Set([...S.lists.regions, ...Object.keys(directory())])];
const rowsOf = (r) => directory()[r] || [];

function match(row) {
  if (!query || row.section) return true;
  return [row.name, row.dept, row.phone, row.email].join(' ').toLowerCase().includes(query.toLowerCase());
}

export function renderPeople(tab, root) {
  if (region === null || !regions().includes(region)) region = S.session.region && regions().includes(S.session.region) ? S.session.region : regions()[0];
  const rows = rowsOf(region);

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Поиск: имя, направление, телефон', 'aria-label': 'Поиск контакта' });
  search.value = query;
  const listBox = h('div', { class: 'view-inner' });
  search.addEventListener('input', () => { query = search.value; draw(); });

  function draw() {
    listBox.innerHTML = '';
    if (!rows.length) {
      listBox.append(h('section', { class: 'card glass' }, h('p', { class: 'empty' }, 'В этом регионе пока пусто.'),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn ghost sm', onClick: () => addSection(region) }, icon('plus'), 'Раздел'),
          regions().filter((r) => r !== region && rowsOf(r).length).map((r) => h('button', { class: 'btn ghost sm', onClick: () => copyRegion(r, region) }, 'Скопировать из ' + r)),
        )));
      return;
    }
    // строки идут подряд, раздел — строка-заголовок
    let card = null, list = null;
    const flush = () => { if (card) listBox.append(card); };
    rows.forEach((row, i) => {
      if (row.section) {
        flush();
        list = h('div', { class: 'doc-list' });
        card = h('section', { class: 'card glass' },
          h('div', { class: 'card-head' },
            h('h2', null, row.section),
            h('div', { class: 'card-actions' },
              h('button', { class: 'icon-btn', 'aria-label': 'Добавить строку в раздел', onClick: () => editRow(region, null, i) }, icon('plus')),
              h('button', { class: 'icon-btn', 'aria-label': 'Действия с разделом', onClick: () => sectionMenu(region, row, i) }, icon('more')),
            )),
          list);
        return;
      }
      if (!match(row)) return;
      if (!list) { list = h('div', { class: 'doc-list' }); card = h('section', { class: 'card glass' }, list); }
      list.append(h('div', { class: 'doc-row person' + (row.name ? '' : ' is-empty') },
        h('div', { class: 'doc-main' },
          h('button', { class: 'doc-title', onClick: () => editRow(region, row) }, row.name || row.dept || '— пустая строка —'),
          row.name && row.dept ? h('div', { class: 'doc-meta' }, row.dept) : !row.name ? h('div', { class: 'doc-meta' }, 'ФИО не указано') : null,
          h('div', { class: 'person-links' },
            row.phone ? row.phone.split(/,\s*/).map((p) => h('a', { href: 'tel:' + p.replace(/доп.*$/i, '').replace(/[^\d+]/g, ''), class: 'chip' }, p)) : null,
            row.email && /@/.test(row.email) ? h('a', { href: 'mailto:' + row.email, class: 'chip' }, row.email) : row.email ? h('span', { class: 'cap' }, row.email) : null,
          ),
        ),
        h('button', { class: 'icon-btn', 'aria-label': 'Действия со строкой', onClick: () => rowMenu(region, row) }, icon('more')),
      ));
    });
    flush();
  }
  draw();

  root.append(
    h('div', { class: 'tab-head glass' },
      h('div', { class: 'tab-head-row' },
        h('div', null, h('h1', { class: 'tab-title' }, tab.title), h('p', { class: 'tab-sub' }, `${region}: ${rows.filter((r) => !r.section).length} строк`)),
        h('button', { class: 'icon-btn glass-btn', 'aria-label': 'Настройки вкладки', onClick: () => tabSettingsDlg(tab) }, icon('gear')),
      ),
      chipSelect({
        options: regions(), value: region, onChange: (v) => { region = v; update(() => {}); },
        onAdd: async () => {
          const v = await formDlg('Новый регион', [{ key: 'name', label: 'Название, например ПФО' }, { key: 'from', label: 'Скопировать строки из', options: [{ value: '', label: 'Пустой' }, ...regions().map((r) => ({ value: r, label: r }))] }]);
          if (!v || !v.name) return;
          update((st) => { if (!st.lists.regions.includes(v.name)) st.lists.regions.push(v.name); directory()[v.name] = v.from ? rowsOf(v.from).map((r) => ({ ...r, id: uid() })) : []; });
          region = v.name;
        },
      }),
      h('div', { class: 'toolbar' }, search,
        h('button', { class: 'btn ghost sm', onClick: () => addSection(region) }, icon('plus'), 'Раздел'),
        h('button', { class: 'btn primary sm', disabled: !rows.length, onClick: () => printRegion(region) }, icon('print'), 'PDF'),
      ),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn ghost sm', onClick: () => importFromPhone(region) }, icon('plus'), 'Из контактов телефона'),
        h('button', { class: 'btn ghost sm', onClick: () => importFromText(region) }, 'Вставить текстом'),
      ),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn ghost sm', onClick: contactsDlg }, 'Кадровики, бухгалтер, юрист для конвертов')),
    ),
    listBox,
  );
}

// ---------- правка ----------
function editRow(reg, row, afterIndex, prefill = {}) {
  const isNew = !row;
  if (isNew && Object.keys(prefill).length) row = null;
  const sections = rowsOf(reg).filter((r) => r.section).map((r) => r.section);
  const curSection = isNew ? (afterIndex != null ? rowsOf(reg)[afterIndex].section : sections[0]) : sectionOf(reg, row);
  const others = regions().filter((r) => r !== reg);
  formDlg(isNew ? 'Новая строка · ' + reg : 'Строка · ' + reg, [
    { key: 'name', label: 'ФИО', value: row ? row.name : prefill.name || '', placeholder: 'Иванова Анна' },
    { key: 'dept', label: 'Направление', value: row ? row.dept : prefill.dept || '', placeholder: 'Например: специалист по кадрам' },
    { key: 'phone', label: 'Телефон (несколько — через запятую)', value: row ? row.phone : prefill.phone || '', placeholder: '8-923-900-90-90 (+7 заменится на 8 сам)' },
    { key: 'email', label: 'Почта / примечание', value: row ? row.email : prefill.email || '', placeholder: 'name@ya-retail.ru' },
    { key: 'section', label: 'Раздел', options: sections.map((s) => ({ value: s, label: s })), value: curSection },
    ...(isNew && others.length ? [{ key: 'also', label: 'Добавить и в другие регионы', options: [{ value: '', label: 'Только ' + reg }, { value: '*', label: 'Во все регионы (общий контакт)' }, ...others.map((r) => ({ value: r, label: 'Ещё в ' + r }))] }] : []),
  ]).then((v) => {
    if (!v) return;
    const data = { name: v.name.trim(), dept: v.dept.trim(), phone: normPhones(v.phone), email: v.email.trim() };
    update(() => {
      const put = (r) => {
        const list = directory()[r] = directory()[r] || [];
        if (!isNew && r === reg) {
          Object.assign(row, data);
          if (v.section && v.section !== curSection) { list.splice(list.indexOf(row), 1); insertInSection(list, v.section, row); }
          return;
        }
        insertInSection(list, v.section || curSection, { id: uid(), ...data });
      };
      put(reg);
      if (v.also === '*') others.forEach(put); else if (v.also) put(v.also);
    });
  });
}

function sectionOf(reg, row) {
  const list = rowsOf(reg);
  for (let i = list.indexOf(row); i >= 0; i--) if (list[i].section) return list[i].section;
  return '';
}
function insertInSection(list, section, row) {
  let i = list.findIndex((r) => r.section === section);
  if (i < 0) { list.push({ id: uid(), section }); list.push(row); return; }
  i++;
  while (i < list.length && !list[i].section) i++;
  list.splice(i, 0, row);
}

function rowMenu(reg, row) {
  const list = rowsOf(reg);
  const others = regions().filter((r) => r !== reg);
  menu(row.name || row.dept || 'Строка', [
    { label: 'Изменить', onClick: () => editRow(reg, row) },
    { label: 'Выше', onClick: () => update(() => { const i = list.indexOf(row); if (i > 0 && !list[i - 1].section) [list[i - 1], list[i]] = [list[i], list[i - 1]]; }) },
    { label: 'Ниже', onClick: () => update(() => { const i = list.indexOf(row); if (i < list.length - 1 && !list[i + 1].section) [list[i + 1], list[i]] = [list[i], list[i + 1]]; }) },
    ...others.map((r) => ({ label: 'Скопировать в ' + r, onClick: () => { update(() => { directory()[r] = directory()[r] || []; insertInSection(directory()[r], sectionOf(reg, row), { ...row, id: uid() }); }); toast('Скопировано в ' + r); } })),
    { label: 'Удалить', danger: true, onClick: async () => { if (await confirmDlg('Удалить строку?', [row.name, row.dept].filter(Boolean).join(' — '), 'Удалить', 'Отмена', true)) update(() => { list.splice(list.indexOf(row), 1); }); } },
  ]);
}

function sectionMenu(reg, row, i) {
  const list = rowsOf(reg);
  menu(row.section, [
    { label: 'Добавить строку', onClick: () => editRow(reg, null, i) },
    { label: 'Переименовать раздел', onClick: async () => { const n = await promptDlg('Название раздела', { value: row.section }); if (n) update(() => { row.section = n; }); } },
    { label: 'Удалить раздел со строками', danger: true, onClick: async () => {
      let j = i + 1; while (j < list.length && !list[j].section) j++;
      if (!(await confirmDlg('Удалить раздел?', `«${row.section}» и ${j - i - 1} строк.`, 'Удалить', 'Отмена', true))) return;
      update(() => { list.splice(i, j - i); });
    } },
  ]);
}

async function addSection(reg) {
  const n = await promptDlg('Новый раздел', { label: 'Например: Отдел кадров' });
  if (n) update(() => { (directory()[reg] = directory()[reg] || []).push({ id: uid(), section: n }); });
}

async function copyRegion(from, to) {
  if (!(await confirmDlg('Скопировать?', `Все строки ${from} попадут в ${to}. Потом замените региональных: тренеров, кадровиков, АХЧ, инженеров.`, 'Скопировать'))) return;
  update(() => { directory()[to] = rowsOf(from).map((r) => ({ ...r, id: uid() })); });
}

// ---------- импорт: контакты телефона, файл .vcf, вставка текста ----------
// Каждый номер — в вид 8-923-900-90-90, «+7» меняется на 8; добавочные и городские оставляем как есть
export function normPhones(str) {
  return String(str || '').split(/\s*[,;]\s*/).map((p) => {
    const d = p.replace(/\D/g, '');
    if (/доп/i.test(p) || d.length < 10 || d.length > 11) return p.trim();
    if (d.length === 10 && d[0] !== '9') return p.trim();
    return formatPhone(d);
  }).filter(Boolean).join(', ');
}

function parseVcf(text) {
  const out = [];
  for (const card of String(text).split(/BEGIN:VCARD/i).slice(1)) {
    const lines = card.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
    const get = (re) => lines.filter((l) => re.test(l)).map((l) => l.slice(l.indexOf(':') + 1).trim());
    const fn = get(/^FN[;:]/i)[0] || (get(/^N[;:]/i)[0] || '').split(';').filter(Boolean).reverse().join(' ');
    out.push({ name: fn, phone: normPhones(get(/^(item\d+\.)?TEL[;:]/i).join(', ')), email: get(/^(item\d+\.)?EMAIL[;:]/i)[0] || '', dept: [get(/^TITLE[;:]/i)[0], get(/^ORG[;:]/i)[0]].filter(Boolean).join(', ').replace(/;+/g, ' ').trim() });
  }
  return out.filter((c) => c.name || c.phone);
}

function parseText(text) {
  const t = String(text || '');
  const phones = t.match(/(\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g) || [];
  const email = (t.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0];
  let rest = t; phones.forEach((p) => { rest = rest.replace(p, ' '); }); rest = rest.replace(email, ' ');
  const words = rest.split(/\n|,|;|\t/).map((x) => x.trim()).filter((x) => x.length > 1);
  return { name: words[0] || '', dept: words.slice(1).join(', '), phone: normPhones(phones.join(', ')), email };
}

async function importFromPhone(reg) {
  // Android Chrome умеет выбирать из адресной книги; на iPhone — через файл контакта (.vcf)
  if (navigator.contacts && navigator.contacts.select) {
    try {
      const picked = await navigator.contacts.select(['name', 'tel', 'email'], { multiple: false });
      const c = picked && picked[0];
      if (c) return editRow(reg, null, undefined, { name: (c.name || [])[0] || '', phone: normPhones((c.tel || []).join(', ')), email: (c.email || [])[0] || '' });
      return;
    } catch (e) { /* не дали доступ — пробуем файлом */ }
  }
  const ok = await choiceDlg('Контакт из телефона', 'В «Контактах» откройте человека → «Поделиться контактом» → «Сохранить в Файлы». Затем выберите этот файл здесь. Можно сразу несколько.', [
    { label: 'Отмена', value: '' }, { label: 'Выбрать файл .vcf', value: 'f', kind: 'primary' },
  ]);
  if (!ok) return;
  const files = await pickFiles({ accept: '.vcf,text/vcard,text/x-vcard', multiple: true });
  const all = [];
  for (const f of files) all.push(...parseVcf(await f.text()));
  if (!all.length) { toast('В файле не нашлось контактов', 'warn'); return; }
  editRow(reg, null, undefined, all[0]);
  if (all.length > 1) toast(`Открыт первый из ${all.length}. Остальные добавьте тем же способом.`);
}

async function importFromText(reg) {
  let initial = '';
  try { if (navigator.clipboard && navigator.clipboard.readText) initial = await navigator.clipboard.readText(); } catch (e) { /* буфер недоступен — вставят вручную */ }
  const text = await promptDlg('Вставить контакт', { label: 'Вставьте сюда текст: имя, должность, телефон, почту — в любом порядке. Если буфер не вставился сам, нажмите в поле и удерживайте → «Вставить».', value: initial, multiline: true, okLabel: 'Разобрать' });
  if (!text) return;
  editRow(reg, null, undefined, parseText(text));
}

// ---------- печать — в виде вашей таблицы ----------
export function directoryBlocks(reg, title = 'Контакты') {
  const head = ['ФИО', 'Направление', 'Телефон', 'Почта / примечание'].map((t) => ({ t, bold: true, fill: '#efefef' }));
  const rows = [head];
  for (const r of rowsOf(reg)) {
    if (r.section) rows.push([{ t: r.section, bold: true, fill: '#f6f6f6', span: 4 }]);
    else rows.push([{ t: r.name, bold: true }, r.dept || '', (r.phone || '').replace(/,\s*/g, '\n'), r.email || '']);
  }
  return [
    { t: 'center', text: `${title} · ${reg}`, size: 15, bold: true, gap: 0 },
    { t: 'center', text: [sessionLabel(S.session), fmtDate(new Date())].filter(Boolean).join(' · '), size: 9, color: '#555', gap: 8 },
    { t: 'xtable', cols: [1.5, 2.1, 1.3, 1.6], rows, headRows: 1, size: 8.5, pad: 3 },
  ];
}

async function printRegion(reg) {
  const bytes = await withBusy('Собираю PDF…', async () => {
    const { pngs, size } = await blocksToPdf(directoryBlocks(reg), { footer: 'Контакты ' + reg + ' · ' + fmtDate(new Date()) });
    return buildPrint({ parts: [{ title: 'Контакты ' + reg, pngs, size, duplex: false }] });
  });
  deliver(bytes, 'Контакты — ' + reg);
}
