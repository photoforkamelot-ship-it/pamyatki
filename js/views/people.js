// Контакты по регионам — как ваш файл «Контакты сотрудников»: ФИО | Направление | Телефон | Почта, с разделами.
// Книга региона хранит все правки и открывается для следующего объекта в этом регионе.
// Скрыть строку (глаз) — только для текущего объекта; удалить — из книги региона.
import { h, icon, uid } from '../util.js';
import { S, update, sessionLabel } from '../store.js';
import { confirmDlg, toast, withBusy, chipSelect, formDlg, choiceDlg, menu, promptDlg, pickFiles } from '../ui.js';
import { deliver, excelPdf } from '../output.js';
import { tabSettingsDlg } from './settings.js';
import { book, regionsAll, hasTemplate, resetToTemplate, isHidden, toggleHidden, sectionsOf, sectionOf, insertInSection, moveRow, contactsXlsx, absorbLegacy, parseVcf, parseText, normPhones } from '../contactbook.js';
import { personDlg } from './persondlg.js';

export { normPhones };
let region = null, query = '';

export function directory() {
  if (!S.directory) S.directory = {};
  return S.directory;
}
const regions = regionsAll;

function match(row) {
  if (!query || row.section) return true;
  return [row.name, row.dept, row.phone, row.email].join(' ').toLowerCase().includes(query.toLowerCase());
}

export function renderPeople(tab, root) {
  if (region === null || !regions().includes(region)) region = S.session.region && regions().includes(S.session.region) ? S.session.region : regions()[0];
  if (!region) { root.append(h('section', { class: 'card glass' }, h('p', { class: 'empty' }, 'Регионов пока нет. Загрузите стартовый пакет в «Настройках».'))); return; }
  const rows = book(region);
  const own = region === S.session.region;
  if (own) absorbLegacy(region);

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Поиск: имя, отдел, телефон', 'aria-label': 'Поиск контакта' });
  search.value = query;
  const listBox = h('div', { class: 'view-inner' });
  search.addEventListener('input', () => { query = search.value; draw(); });

  function draw() {
    listBox.innerHTML = '';
    let card = null, list = null, secIdx = -1;
    const flush = () => { if (card) { if (!query) list.append(h('button', { class: 'cb-add', onClick: ((i) => () => addPerson(region, i))(secIdx) }, '+ добавить в раздел')); listBox.append(card); } };
    rows.forEach((row, i) => {
      if (row.section) {
        flush();
        secIdx = i;
        list = h('div', { class: 'cb-list' });
        card = h('section', { class: 'card glass' },
          h('div', { class: 'card-head' },
            h('h2', null, row.section),
            h('div', { class: 'card-actions' },
              h('button', { class: 'icon-btn', 'aria-label': 'Действия с разделом', onClick: () => sectionMenu(region, row, i) }, icon('more')),
            )),
          list);
        return;
      }
      if (!match(row)) return;
      if (!list) { list = h('div', { class: 'cb-list' }); card = h('section', { class: 'card glass' }, list); }
      const off = own && isHidden(row);
      const phones = (row.phone || '').split(/,\s*/).filter(Boolean);
      list.append(h('div', { class: 'cb-row' + (off ? ' off' : '') },
        h('div', { class: 'cb-main' },
          h('button', { class: 'cb-name-btn', onClick: () => editPerson(region, row) },
            h('div', { class: 'cb-name' }, row.name || row.dept || '— пустая строка —'),
            row.name && row.dept ? h('div', { class: 'cb-meta' }, row.dept) : null),
          phones.length || row.email ? h('div', { class: 'cb-links' },
            phones.map((p) => h('a', { href: 'tel:' + p.replace(/доп.*$/i, '').replace(/[^\d+]/g, '') }, p)),
            row.email ? h('a', { href: 'mailto:' + row.email }, row.email) : null) : null),
        own ? h('button', { class: 'icon-btn', 'aria-label': off ? 'Вернуть в печать' : 'Не печатать для этого объекта', title: off ? 'Вернуть в печать' : 'Не печатать для этого объекта', onClick: () => toggleHidden(row) }, icon(off ? 'eyeOff' : 'eye')) : null,
        h('button', { class: 'icon-btn', 'aria-label': 'Действия со строкой', onClick: () => rowMenu(region, row) }, icon('more')),
      ));
    });
    flush();
    if (!rows.length) listBox.append(h('section', { class: 'card glass' }, h('p', { class: 'empty' }, 'В этом регионе пока пусто.'), h('button', { class: 'btn ghost sm', onClick: () => addSection(region) }, icon('plus'), 'Раздел')));
  }
  draw();

  const hiddenN = own ? rows.filter((r) => !r.section && isHidden(r)).length : 0;
  root.append(
    h('div', { class: 'tab-head glass' },
      h('div', { class: 'tab-head-row' },
        h('div', null, h('h1', { class: 'tab-title' }, tab.title), h('p', { class: 'tab-sub' }, `${region}: ${rows.filter((r) => !r.section).length} контактов`)),
        h('button', { class: 'icon-btn glass-btn', 'aria-label': 'Настройки вкладки', onClick: () => tabSettingsDlg(tab) }, icon('gear')),
      ),
      chipSelect({
        options: regions(), value: region, onChange: (v) => { region = v; update(() => {}); },
        onAdd: async () => {
          const v = await formDlg('Новый регион', [{ key: 'name', label: 'Название, например ПФО' }, { key: 'from', label: 'Взять контакты из', options: [{ value: '', label: 'Пустой' }, ...regions().map((r) => ({ value: r, label: r }))] }]);
          if (!v || !v.name) return;
          update((st) => { if (!st.lists.regions.includes(v.name)) st.lists.regions.push(v.name); st.contactBook = st.contactBook || {}; st.contactBook[v.name] = v.from ? book(v.from).map((r) => ({ ...r, id: uid() })) : []; });
          region = v.name;
        },
      }),
      h('div', { class: 'cb-banner' },
        own ? `Это контакты ${region} для объекта ${sessionLabel(S.session)}. Правки сохранятся и для следующего объекта в ${region}${hiddenN ? `; скрыто на эту печать: ${hiddenN}` : ''}. ` : `Так откроются контакты для следующего объекта в ${region}. `,
        hasTemplate(region) ? h('button', { onClick: async () => { if (await confirmDlg('Вернуть как в шаблоне?', `Контакты ${region} станут такими, как в исходном файле «Контакты сотрудников». Добавленные и исправленные строки пропадут.`, 'Вернуть', 'Отмена', true)) resetToTemplate(region); } }, 'Вернуть как в шаблоне') : null,
      ),
      h('div', { class: 'toolbar' }, search,
        h('button', { class: 'btn primary sm', disabled: !rows.length, onClick: () => printRegion(region) }, icon('print'), 'Печать'),
      ),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn ghost sm', onClick: () => importFromPhone(region) }, icon('plus'), 'Из контактов телефона'),
        h('button', { class: 'btn ghost sm', onClick: () => importFromText(region) }, 'Вставить текстом'),
        h('button', { class: 'btn ghost sm', onClick: () => addSection(region) }, icon('plus'), 'Раздел'),
      ),
    ),
    listBox,
  );
}

// ---------- правка ----------
export async function addPerson(reg, sectionIndex, prefill = {}) {
  const list = book(reg);
  const secs = sectionsOf(reg);
  const cur = sectionIndex != null && list[sectionIndex] ? list[sectionIndex].section : prefill.section || secs[0];
  const v = await personDlg({ title: 'Новый контакт · ' + reg, row: prefill, reg, sections: secs, section: cur });
  if (!v || v === 'delete') return null;
  const row = { id: uid(), name: v.name, dept: v.dept, phone: v.phone, email: v.email };
  update(() => {
    // в разделе есть пустая «вакансия» из шаблона (должность без ФИО и телефона) — заполняем её
    const secName = v.section || cur;
    const i0 = list.findIndex((r) => r.section === secName);
    let slot = null;
    for (let k = i0 + 1; i0 >= 0 && k < list.length && !list[k].section; k++) if (!list[k].name && !list[k].phone && !list[k].email) { slot = list[k]; break; }
    if (slot && v.name) Object.assign(slot, { name: v.name, dept: v.dept || slot.dept, phone: v.phone, email: v.email });
    else insertInSection(list, secName, row);
  });
  return row;
}

export async function editPerson(reg, row) {
  const list = book(reg);
  const cur = sectionOf(list, row);
  const v = await personDlg({ title: 'Контакт · ' + reg, row, reg, sections: sectionsOf(reg), section: cur, canDelete: true });
  if (!v) return;
  update(() => {
    if (v === 'delete') { list.splice(list.indexOf(row), 1); return; }
    Object.assign(row, { name: v.name, dept: v.dept, phone: v.phone, email: v.email });
    if (v.section && v.section !== cur) { list.splice(list.indexOf(row), 1); insertInSection(list, v.section, row); }
  });
}

function rowMenu(reg, row) {
  const list = book(reg);
  const others = regions().filter((r) => r !== reg);
  menu(row.name || row.dept || 'Строка', [
    { label: 'Изменить', onClick: () => editPerson(reg, row) },
    { label: 'Выше', onClick: () => update(() => { moveRow(list, row, -1); }) },
    { label: 'Ниже', onClick: () => update(() => { moveRow(list, row, 1); }) },
    ...others.map((r) => ({ label: 'Скопировать в ' + r, onClick: () => { update(() => { insertInSection(book(r), sectionOf(list, row), { ...row, id: uid() }); }); toast('Скопировано в ' + r); } })),
    { label: 'Удалить из книги ' + reg, danger: true, onClick: async () => { if (await confirmDlg('Удалить строку?', [row.name, row.dept].filter(Boolean).join(' — ') + '. Чтобы убрать только из этой печати — нажмите глаз.', 'Удалить', 'Отмена', true)) update(() => { list.splice(list.indexOf(row), 1); }); } },
  ]);
}

function sectionMenu(reg, row, i) {
  const list = book(reg);
  menu(row.section, [
    { label: 'Добавить контакт', onClick: () => addPerson(reg, i) },
    { label: 'Раздел выше', onClick: () => update(() => moveSection(list, i, -1)) },
    { label: 'Раздел ниже', onClick: () => update(() => moveSection(list, i, 1)) },
    { label: 'Переименовать раздел', onClick: async () => { const n = await promptDlg('Название раздела', { value: row.section }); if (n) update(() => { row.section = n; }); } },
    { label: 'Удалить раздел со строками', danger: true, onClick: async () => {
      let j = i + 1; while (j < list.length && !list[j].section) j++;
      if (!(await confirmDlg('Удалить раздел?', `«${row.section}» и ${j - i - 1} строк.`, 'Удалить', 'Отмена', true))) return;
      update(() => { list.splice(i, j - i); });
    } },
  ]);
}
function moveSection(list, i, dir) {
  const end = (k) => { let j = k + 1; while (j < list.length && !list[j].section) j++; return j; };
  const block = list.slice(i, end(i));
  if (dir < 0) {
    let p = i - 1; while (p > 0 && !list[p].section) p--;
    if (p < 0 || i === 0) return;
    list.splice(i, block.length); list.splice(p, 0, ...block);
  } else {
    const nx = end(i); if (nx >= list.length) return;
    const nb = end(nx) - nx;
    list.splice(i, block.length); list.splice(i + nb, 0, ...block);
  }
}

async function addSection(reg) {
  const n = await promptDlg('Новый раздел', { label: 'Например: Отдел кадров' });
  if (n) update(() => { book(reg).push({ id: uid(), section: n }); });
}

// ---------- импорт: контакты телефона, файл .vcf, вставка текста ----------
async function importFromPhone(reg) {
  // Android Chrome умеет выбирать из адресной книги; на iPhone — через файл контакта (.vcf)
  if (navigator.contacts && navigator.contacts.select) {
    try {
      const picked = await navigator.contacts.select(['name', 'tel', 'email'], { multiple: false });
      const c = picked && picked[0];
      if (c) return addPerson(reg, null, { name: (c.name || [])[0] || '', phone: normPhones((c.tel || []).join(', ')), email: (c.email || [])[0] || '' });
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
  addPerson(reg, null, all[0]);
  if (all.length > 1) toast(`Открыт первый из ${all.length}. Остальные добавьте тем же способом.`);
}

async function importFromText(reg) {
  let initial = '';
  try { if (navigator.clipboard && navigator.clipboard.readText) initial = await navigator.clipboard.readText(); } catch (e) { /* буфер недоступен — вставят вручную */ }
  const text = await promptDlg('Вставить контакт', { label: 'Вставьте сюда текст: имя, должность, телефон, почту — в любом порядке. Если буфер не вставился сам, нажмите в поле и удерживайте → «Вставить».', value: initial, multiline: true, okLabel: 'Разобрать' });
  if (!text) return;
  addPerson(reg, null, parseText(text));
}

// ---------- печать — по образцу вашего файла «Контакты сотрудников» (Excel + PDF на 1 лист) ----------
export async function printRegion(reg) {
  const bytes = await withBusy('Собираю контакты…', () => contactsXlsx(reg, 'Контакты ' + reg));
  const also = await excelPdf(bytes, 'Контакты ' + reg, { hint: 'PDF: 1 лист A4, как ваш файл «Контакты сотрудников».' });
  deliver(bytes, 'Контакты ' + reg, { excel: true, also });
}
