// Договора по городу: ОПС, дезинфекция, аренда, ТБО/ТКО. Договор города действует для всех ОСП,
// договор аренды — для своего ОСП; другие ОСП могут его «подтянуть». Допсоглашения — у каждого ОСП свои.
import { h, icon, fmtDate, pages as pagesWord, baseName } from '../util.js';
import { S, update, makeDoc } from '../store.js';
import { pickFiles, withBusy, toast, confirmDlg, promptDlg, openModal, chipSelect, choiceDlg, menu } from '../ui.js';
import { analyze, storeAnalyzed, getBytes, dropFile } from '../files.js';
import { blocksToPdf, buildPrint, renderThumbs } from '../pdf.js';
import { deliver } from '../output.js';
import { tabSettingsDlg } from './settings.js';

export const CONTRACT_TYPES = [
  { key: 'ops', title: 'ОПС — охранно-пожарная сигнализация', short: 'ОПС', scope: 'city', hint: 'Постановка и снятие с охраны, пульт, тонкости, контакты' },
  { key: 'pest', title: 'Дезинфекция и дератизация', short: 'Дезка', scope: 'city', hint: 'Подрядчик, периодичность, акты, контакты' },
  { key: 'rent', title: 'Аренда', short: 'Аренда', scope: 'osp', hint: 'Собственник здания, особенности площадей, кто решает вопросы' },
  { key: 'tko', title: 'ТБО / ТКО — вывоз мусора', short: 'ТКО', scope: 'city', hint: 'Оператор, график вывоза, заявки на дополнительный вывоз' },
];

let currentCity = null;
const ospKey = () => (S.session.osp || '').trim() || '—';

function cityData(city) {
  const c = S.contracts.cities;
  if (!c[city]) c[city] = { types: {}, osps: {} };
  for (const t of CONTRACT_TYPES) if (!c[city].types[t.key]) c[city].types[t.key] = { docs: [], notes: '' };
  return c[city];
}
function ospData(city, osp) {
  const cd = cityData(city);
  if (!cd.osps[osp]) cd.osps[osp] = { types: {} };
  for (const t of CONTRACT_TYPES) if (!cd.osps[osp].types[t.key]) cd.osps[osp].types[t.key] = { exclude: [], extra: [], supplements: [], notes: '' };
  return cd.osps[osp];
}

function applies(doc, od, osp) {
  if (od.exclude.includes(doc.id)) return false;
  if (od.extra.includes(doc.id)) return true;
  if (doc.scope === 'city') return true;
  return doc.origin === osp;
}

export function renderContracts(tab, root) {
  const cities = [...new Set([S.session.city, ...Object.keys(S.contracts.cities)].filter(Boolean))];
  if (!currentCity || !cities.includes(currentCity)) currentCity = S.session.city || cities[0] || null;
  const osp = ospKey();

  root.append(
    h('div', { class: 'tab-head glass' },
      h('div', { class: 'tab-head-row' },
        h('div', null, h('h1', { class: 'tab-title' }, tab.title), h('p', { class: 'tab-sub' }, currentCity ? `${currentCity} · для ОСП ${osp}` : 'Договоры и особенности по городам')),
        h('button', { class: 'icon-btn glass-btn', 'aria-label': 'Настройки вкладки', onClick: () => tabSettingsDlg(tab) }, icon('gear')),
      ),
      chipSelect({
        options: cities, value: currentCity,
        onChange: (v) => { currentCity = v || currentCity; update(() => {}); },
        onAdd: async () => { const c = await promptDlg('Город', { label: 'Название города' }); if (c) { currentCity = c; update(() => { cityData(c); }); } },
      }),
      currentCity ? h('div', { class: 'toolbar' }, h('button', { class: 'btn primary sm grow', onClick: () => printOsp(tab, currentCity, osp) }, icon('print'), `Печать для ОСП ${osp}`)) : null,
      currentCity && currentCity !== S.session.city ? h('p', { class: 'note warn' }, `Город сеанса — ${S.session.city || 'не указан'}. Допсоглашения ниже относятся к ОСП ${osp}.`) : null,
    ),
  );
  if (!currentCity) {
    root.append(h('section', { class: 'card glass' }, h('p', { class: 'empty' }, 'Добавьте город кнопкой «+» или укажите его во вводных сеанса.')));
    return;
  }
  const cd = cityData(currentCity);
  const od = ospData(currentCity, osp);
  for (const t of CONTRACT_TYPES) root.append(typeCard(tab, t, cd.types[t.key], od.types[t.key], osp));
}

function docRow(d, actions) {
  return h('div', { class: 'doc-row' },
    h('div', { class: 'doc-main' },
      h('button', { class: 'doc-title', onClick: () => preview(d) }, d.title),
      h('div', { class: 'doc-meta' }, [d.scope === 'city' ? 'весь город' : 'ОСП ' + (d.origin || '—'), d.file ? 'загружено ' + fmtDate(d.file.uploadedAt) : '', d.file && d.file.pages ? pagesWord(d.file.pages) : ''].filter(Boolean).join(' · ')),
    ),
    ...actions,
  );
}

function notesField(label, get, set, ph) {
  const id = 'n' + Math.random().toString(36).slice(2, 7);
  const ta = h('textarea', { class: 'input', id, rows: 3, placeholder: ph });
  ta.value = get() || '';
  ta.addEventListener('input', () => update(() => set(ta.value), { silent: true }));
  return h('div', { class: 'field' }, h('label', { for: id }, label), ta);
}

function typeCard(tab, t, ct, ot, osp) {
  const docs = ct.docs.map((id) => S.docs[id]).filter(Boolean);
  const active = docs.filter((d) => applies(d, ot, osp));
  const others = docs.filter((d) => !applies(d, ot, osp));
  const sups = ot.supplements.map((id) => S.docs[id]).filter(Boolean);
  return h('section', { class: 'card glass' },
    h('div', { class: 'card-head' }, h('h2', null, t.title),
      h('div', { class: 'card-actions' }, h('button', { class: 'btn ghost sm', onClick: () => addContract(tab, t, ct, osp) }, icon('upload'), 'Договор'))),
    h('p', { class: 'cap strong' }, `Действует для ОСП ${osp}`),
    active.length ? h('div', { class: 'doc-list compact' }, active.map((d) => docRow(d, [
      h('button', { class: 'icon-btn', 'aria-label': 'Действия', onClick: () => contractMenu(t, ct, ot, d, osp) }, icon('more')),
    ]))) : h('p', { class: 'empty' }, t.scope === 'city' ? 'Договора нет. Обычно он один на город — загрузите, и он подтянется во все ОСП.' : 'Договора нет. Загрузите свой или подтяните из другого ОСП ниже.'),
    others.length ? h('details', { class: 'opt' }, h('summary', null, `Из других ОСП города · ${others.length}`),
      h('div', { class: 'doc-list compact' }, others.map((d) => docRow(d, [
        h('button', { class: 'btn ghost sm', onClick: () => update(() => { ot.exclude = ot.exclude.filter((x) => x !== d.id); if (!ot.extra.includes(d.id)) ot.extra.push(d.id); }) }, 'Подтянуть'),
      ])))) : null,
    h('div', { class: 'sub-row' },
      h('p', { class: 'cap strong' }, `Допсоглашения ОСП ${osp}`),
      h('button', { class: 'btn ghost sm', onClick: () => addSupplement(tab, t, ot, osp) }, icon('upload'), 'Допник'),
    ),
    sups.length ? h('div', { class: 'doc-list compact' }, sups.map((d) => docRow(d, [
      h('button', { class: 'icon-btn', 'aria-label': 'Удалить допсоглашение', onClick: async () => {
        if (!(await confirmDlg('Удалить допсоглашение?', d.title, 'Удалить', 'Отмена', true))) return;
        await dropFile(d.file);
        update((s) => { ot.supplements = ot.supplements.filter((x) => x !== d.id); delete s.docs[d.id]; });
      } }, icon('trash')),
    ]))) : h('p', { class: 'empty' }, 'Допсоглашений нет — у каждого ОСП они свои, загружаются вручную.'),
    notesField('Особенности по городу', () => ct.notes, (v) => (ct.notes = v), t.hint),
    notesField(`Особенности ОСП ${osp}`, () => ot.notes, (v) => (ot.notes = v), 'Что отличается именно в этом магазине'),
  );
}

function contractMenu(t, ct, ot, d, osp) {
  menu(d.title, [
    { label: 'Просмотр', onClick: () => preview(d) },
    { label: 'Переименовать', onClick: async () => { const n = await promptDlg('Название', { value: d.title }); if (n) update(() => { d.title = n; }); } },
    { label: d.scope === 'city' ? 'Сделать договором только ОСП ' + (d.origin || osp) : 'Сделать договором на весь город', onClick: () => update(() => { d.scope = d.scope === 'city' ? 'osp' : 'city'; }) },
    { label: `Не действует для ОСП ${osp}`, onClick: () => update(() => { ot.extra = ot.extra.filter((x) => x !== d.id); if (!ot.exclude.includes(d.id)) ot.exclude.push(d.id); }) },
    { label: 'Удалить договор совсем', danger: true, onClick: async () => {
      if (!(await confirmDlg('Удалить договор?', `${d.title} — пропадёт у всех ОСП города.`, 'Удалить', 'Отмена', true))) return;
      await dropFile(d.file);
      update((s) => { ct.docs = ct.docs.filter((x) => x !== d.id); delete s.docs[d.id]; });
    } },
  ]);
}

async function uploadPdfs(tab) {
  const files = await pickFiles({ multiple: true });
  if (!files.length) return [];
  const out = [];
  await withBusy('Сохраняю…', async (step) => {
    for (const f of files) {
      try {
        const info = await analyze(f, step);
        out.push({ title: baseName(f.name), meta: await storeAnalyzed(info, { padEven: true, tabId: tab.id, onStep: step }) });
      } catch (e) { toast(`«${f.name}» не открылся как PDF`, 'warn'); }
    }
  });
  return out;
}

async function addContract(tab, t, ct, osp) {
  const scope = await choiceDlg('Кому действует договор?', t.scope === 'city' ? 'Обычно этот договор один на весь город.' : 'Аренда обычно своя у каждого ОСП.', [
    { label: 'Отмена', value: null },
    { label: 'Только ОСП ' + osp, value: 'osp', kind: t.scope === 'osp' ? 'primary' : 'ghost' },
    { label: 'Весь город', value: 'city', kind: t.scope === 'city' ? 'primary' : 'ghost' },
  ]);
  if (!scope) return;
  const got = await uploadPdfs(tab);
  update((s) => { for (const g of got) { const d = makeDoc(tab.id, g.title, { file: g.meta, scope, origin: osp, ctype: t.key }); s.docs[d.id] = d; ct.docs.push(d.id); } });
}

async function addSupplement(tab, t, ot, osp) {
  const got = await uploadPdfs(tab);
  update((s) => { for (const g of got) { const d = makeDoc(tab.id, g.title, { file: g.meta, scope: 'osp', origin: osp, ctype: t.key, supplement: true }); s.docs[d.id] = d; ot.supplements.push(d.id); } });
}

async function preview(d) {
  const grid = h('div', { class: 'thumbs big' }, h('div', { class: 'spinner' }));
  openModal({ title: d.title, body: grid, wide: true });
  try { const b = await getBytes(d.file); const cs = await renderThumbs(b, { count: 12, width: 170 }); grid.innerHTML = ''; grid.append(...cs); }
  catch (e) { grid.innerHTML = ''; grid.append(h('p', { class: 'note warn' }, e.message)); }
}

async function printOsp(tab, city, osp) {
  const cd = cityData(city), od = ospData(city, osp);
  const duplex = tab.settings.printMode === 'duplex';
  const blocks = [{ t: 'h1', text: `Договора: ${city}, ОСП ${osp}`, sub: fmtDate(new Date()) }];
  for (const t of CONTRACT_TYPES) {
    const ct = cd.types[t.key], ot = od.types[t.key];
    const docs = ct.docs.map((id) => S.docs[id]).filter((d) => d && applies(d, ot, osp));
    const sups = ot.supplements.map((id) => S.docs[id]).filter(Boolean);
    blocks.push({ t: 'h2', text: t.title });
    blocks.push({ t: 'kv', rows: [['Договор', docs.map((d) => d.title).join('; ') || '—'], ['Допсоглашения', sups.map((d) => d.title).join('; ') || '—']], size: 10 });
    if (ct.notes.trim()) blocks.push({ t: 'p', text: 'Город: ' + ct.notes.trim(), size: 10 });
    if (ot.notes.trim()) blocks.push({ t: 'p', text: `ОСП ${osp}: ` + ot.notes.trim(), size: 10 });
    if (!ct.notes.trim() && !ot.notes.trim()) blocks.push({ t: 'kv', rows: [['Особенности', ''], ['', '']], size: 10 });
  }
  try {
    const bytes = await withBusy('Собираю файл…', async () => {
      const { pngs, size } = await blocksToPdf(blocks, { footer: `Договора · ${city} · ОСП ${osp}` });
      const parts = [{ title: 'Сводка', pngs, size, duplex }];
      for (const t of CONTRACT_TYPES) {
        const ct = cd.types[t.key], ot = od.types[t.key];
        const list = [...ct.docs.map((id) => S.docs[id]).filter((d) => d && applies(d, ot, osp)), ...ot.supplements.map((id) => S.docs[id]).filter(Boolean)];
        for (const d of list) if (d.file) parts.push({ title: d.title, section: t.short, bytes: await getBytes(d.file), duplex: duplex && d.file.padEven !== false });
      }
      return buildPrint({ parts });
    });
    deliver(bytes, `Договора — ${city} — ОСП ${osp}`, { duplex });
  } catch (e) { toast('Ошибка: ' + e.message, 'warn'); }
}
