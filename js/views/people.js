// Контакты сотрудников по регионам и городам: тренинг-менеджеры, рекрутеры, кадровики, бухгалтеры, юристы, ПБ, СБ.
// Те же контакты подставляются во вводные сеанса и в конверты.
import { h, icon, fmtDate } from '../util.js';
import { S, update, CONTACT_LISTS, sessionLabel } from '../store.js';
import { openModal, confirmDlg, toast, withBusy, chipSelect } from '../ui.js';
import { blocksToPdf, buildPrint } from '../pdf.js';
import { deliver } from '../output.js';
import { dative } from '../generators.js';
import { tabSettingsDlg } from './settings.js';

const ENVELOPE = ['hr', 'accountants', 'legal'];
let fRegion = null, fCity = '', fRole = '', query = '';

function everyone() {
  const out = [];
  for (const [key, label] of Object.entries(CONTACT_LISTS)) for (const c of S.lists[key] || []) out.push({ c, key, label });
  return out;
}
const citiesOf = (c) => (Array.isArray(c.cities) ? c.cities : String(c.cities || '').split(',').map((x) => x.trim()).filter(Boolean));

function matches({ c, key }) {
  if (fRegion && c.region !== fRegion) return false;
  if (fCity && !citiesOf(c).includes(fCity)) return false;
  if (fRole && key !== fRole) return false;
  if (query) {
    const q = query.toLowerCase();
    if (![c.name, c.phone, c.email, c.note, ...citiesOf(c)].join(' ').toLowerCase().includes(q)) return false;
  }
  return true;
}

export function renderPeople(tab, root) {
  if (fRegion === null) fRegion = S.session.region || '';
  const all = everyone();
  const list = all.filter(matches);
  const cities = [...new Set(all.flatMap(({ c }) => citiesOf(c)).concat(S.session.city ? [S.session.city] : []))].sort();

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Поиск: имя, телефон, город', 'aria-label': 'Поиск контакта' });
  search.value = query;
  search.addEventListener('input', () => { query = search.value; drawList(); });

  const listBox = h('div', { class: 'view-inner' });
  function drawList() {
    listBox.innerHTML = '';
    const items = everyone().filter(matches);
    if (!items.length) { listBox.append(h('section', { class: 'card glass' }, h('p', { class: 'empty' }, 'Никого не найдено. Добавьте контакт или снимите фильтры.'))); return; }
    const byRole = new Map();
    items.forEach((x) => { if (!byRole.has(x.label)) byRole.set(x.label, []); byRole.get(x.label).push(x); });
    for (const [label, arr] of byRole) {
      listBox.append(h('section', { class: 'card glass' },
        h('div', { class: 'card-head' }, h('h2', null, label, h('span', { class: 'pill' }, String(arr.length)))),
        h('div', { class: 'doc-list' }, arr.map(({ c, key }) => h('div', { class: 'doc-row person' },
          h('div', { class: 'doc-main' },
            h('button', { class: 'doc-title', onClick: () => editPerson(key, c) }, c.name || 'Без имени'),
            h('div', { class: 'doc-meta' }, [c.region, citiesOf(c).join(', '), c.note].filter(Boolean).join(' · ')),
            h('div', { class: 'person-links' },
              c.phone ? h('a', { href: 'tel:' + c.phone.replace(/[^\d+]/g, ''), class: 'chip' }, c.phone) : null,
              c.email ? h('a', { href: 'mailto:' + c.email, class: 'chip' }, c.email) : null,
              c.tg ? h('a', { href: 'https://t.me/' + c.tg.replace(/^@/, ''), class: 'chip', target: '_blank', rel: 'noopener' }, '@' + c.tg.replace(/^@/, '')) : null,
            ),
          ),
          h('button', { class: 'icon-btn', 'aria-label': 'Изменить', onClick: () => editPerson(key, c) }, icon('pencil')),
        ))),
      ));
    }
  }
  drawList();

  root.append(
    h('div', { class: 'tab-head glass' },
      h('div', { class: 'tab-head-row' },
        h('div', null, h('h1', { class: 'tab-title' }, tab.title), h('p', { class: 'tab-sub' }, `${list.length} из ${all.length} · по регионам и городам`)),
        h('button', { class: 'icon-btn glass-btn', 'aria-label': 'Настройки вкладки', onClick: () => tabSettingsDlg(tab) }, icon('gear')),
      ),
      h('p', { class: 'cap' }, 'Регион'),
      chipSelect({ options: ['*', ...S.lists.regions], value: fRegion || '*', labelOf: (o) => (o === '*' ? 'Все' : o), onChange: (v) => { fRegion = v && v !== '*' ? v : ''; update(() => {}); } }),
      cities.length ? h('p', { class: 'cap' }, 'Город') : null,
      cities.length ? chipSelect({ options: ['*', ...cities], value: fCity || '*', labelOf: (o) => (o === '*' ? 'Все' : o), onChange: (v) => { fCity = v && v !== '*' ? v : ''; update(() => {}); } }) : null,
      h('p', { class: 'cap' }, 'Роль'),
      chipSelect({ options: ['*', ...Object.keys(CONTACT_LISTS)], value: fRole || '*', labelOf: (o) => (o === '*' ? 'Все' : CONTACT_LISTS[o]), onChange: (v) => { fRole = v && v !== '*' ? v : ''; update(() => {}); } }),
      h('div', { class: 'toolbar' }, search,
        h('button', { class: 'btn ghost sm', onClick: () => editPerson(fRole || 'trainers', null) }, icon('plus'), 'Контакт'),
        h('button', { class: 'btn primary sm', disabled: !list.length, onClick: () => printList(list) }, icon('print'), 'PDF'),
      ),
    ),
    listBox,
  );
}

function editPerson(key, c) {
  const isNew = !c;
  const st = c ? { ...c, cities: citiesOf(c).join(', ') } : { name: '', region: fRegion || S.session.region || '', cities: fCity || S.session.city || '', phone: '', email: '', tg: '', note: '', address: '', dative: '' };
  let role = key;
  const body = h('div', { class: 'form' });
  const inputs = {};
  const field = (k, label, opts = {}) => {
    const id = 'p' + k;
    const el = opts.options
      ? h('select', { class: 'input', id }, opts.options.map(([v, l]) => h('option', { value: v, selected: v === (opts.value ?? st[k]) }, l)))
      : opts.multi ? h('textarea', { class: 'input', id, rows: 2, placeholder: opts.ph || '' }) : h('input', { class: 'input', id, placeholder: opts.ph || '', inputmode: opts.im });
    if (!opts.options) el.value = st[k] || '';
    inputs[k] = el;
    return h('div', { class: 'field' }, h('label', { for: id }, label), el);
  };
  const envBox = h('div', { class: 'form' });
  const drawEnv = () => {
    envBox.innerHTML = '';
    if (ENVELOPE.includes(role)) envBox.append(
      h('p', { class: 'cap' }, 'Для конвертов'),
      field('dative', 'Кому (дательный падеж)', { ph: dative(inputs.name ? inputs.name.value : st.name) }),
      field('address', 'Куда (строки под именем)', { multi: true }),
    );
  };
  body.append(
    field('name', 'Фамилия Имя'),
    field('role', 'Роль', { options: Object.entries(CONTACT_LISTS), value: role }),
    h('div', { class: 'grid-2' },
      field('region', 'Регион', { options: [['', '—'], ...S.lists.regions.map((r) => [r, r])] }),
      field('cities', 'Города (через запятую)', { ph: 'Екатеринбург, Челябинск' }),
      field('phone', 'Телефон', { im: 'tel' }),
      field('email', 'Почта', { im: 'email' }),
      field('tg', 'Telegram', { ph: '@username' }),
    ),
    field('note', 'Примечание', { ph: 'Например: отвечает за новые открытия' }),
    envBox,
  );
  drawEnv();
  inputs.role.addEventListener('change', () => { role = inputs.role.value; drawEnv(); });
  openModal({
    title: isNew ? 'Новый контакт' : 'Контакт', body,
    actions: [
      !isNew ? { label: 'Удалить', kind: 'danger', onClick: async () => {
        if (!(await confirmDlg('Удалить контакт?', c.name, 'Удалить', 'Отмена', true))) return false;
        update((s) => { s.lists[key] = s.lists[key].filter((x) => x !== c); });
      } } : null,
      { label: 'Сохранить', kind: 'primary', onClick: () => {
        const v = {};
        for (const [k, el] of Object.entries(inputs)) v[k] = el.value.trim();
        if (!v.name) { toast('Нужно имя'); return false; }
        const data = { name: v.name, region: v.region, cities: v.cities.split(',').map((x) => x.trim()).filter(Boolean), phone: v.phone, email: v.email, tg: v.tg, note: v.note, address: v.address ?? (c ? c.address : ''), dative: v.dative || (ENVELOPE.includes(role) ? dative(v.name) : '') };
        update((s) => {
          s.lists[role] = s.lists[role] || [];
          if (c && role === key) Object.assign(c, data);
          else {
            if (c) s.lists[key] = s.lists[key].filter((x) => x !== c);
            s.lists[role].push(data);
          }
          for (const city of data.cities) if (!s.lists.cities.includes(city)) s.lists.cities.push(city);
        });
      } },
    ],
  });
}

async function printList(list) {
  const rows = [[{ t: 'Роль', bold: true, fill: '#efefef' }, { t: 'ФИО', bold: true, fill: '#efefef' }, { t: 'Регион, города', bold: true, fill: '#efefef' }, { t: 'Телефон', bold: true, fill: '#efefef' }, { t: 'Почта, Telegram', bold: true, fill: '#efefef' }]];
  for (const { c, label } of list) rows.push([label, { t: c.name, bold: true }, [c.region, citiesOf(c).join(', ')].filter(Boolean).join(': '), c.phone || '', [c.email, c.tg].filter(Boolean).join('\n')]);
  const blocks = [
    { t: 'center', text: 'Контакты', size: 15, bold: true, gap: 0 },
    { t: 'center', text: [fRegion, fCity, sessionLabel(S.session), fmtDate(new Date())].filter(Boolean).join(' · '), size: 9, color: '#555', gap: 8 },
    { t: 'xtable', cols: [1.2, 1.6, 1.6, 1.2, 1.6], rows, headRows: 1, size: 9, pad: 3 },
  ];
  const bytes = await withBusy('Собираю PDF…', async () => {
    const { pngs, size } = await blocksToPdf(blocks, { footer: 'Контакты · ' + fmtDate(new Date()) });
    return buildPrint({ parts: [{ title: 'Контакты', pngs, size, duplex: false }] });
  });
  deliver(bytes, `Контакты${fRegion ? ' — ' + fRegion : ''}${fCity ? ' — ' + fCity : ''}`);
}
