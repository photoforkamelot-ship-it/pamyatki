// Деления между кронштейнами: каталог карточек, выбор под магазин, печать по образцу, архив.
import { h, icon, uid, fmtDate, monthKey, clone } from '../util.js';
import { S, update, sessionLabel, SHELF_KINDS } from '../store.js';
import { openModal, confirmDlg, promptDlg, toast, withBusy, formDlg, menu } from '../ui.js';
import { blocksToPdf, buildPrint } from '../pdf.js';
import { deliver } from '../output.js';
import { tabSettingsDlg } from './settings.js';
import { setSheetsCells } from '../xlsx.js';
import { getBytes } from '../files.js';
import { choiceDlg } from '../ui.js';

const DRAFT = 'ДЕЛЕНИЯ ЧЕРНОВИК для РЕДАКТИРОВ';
const PRINT = 'ПЕЧАТЬ';
const colN = (c) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colL = (n) => { let s = ''; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

// Ваш файл делений: значения пишутся в лист-черновик, а лист «ПЕЧАТЬ» сам подтягивает их формулами.
// Названия и оформление карточек не меняются; для выбранных карточек ставится нужная высота (2,20 / 1,80).
export async function shelvesXlsx(items) {
  const draft = {}, print = {};
  for (const it of S.shelves.catalog) {
    if (!it.src || !it.xl) continue;
    const [, c, r] = it.src.match(/^([A-Z]+)(\d+)$/);
    const col = colN(c), row = Number(r);
    const p = pick(it.id);
    it.variants.slice(0, 2).forEach((v, vi) => {
      const sel = p && p.on && (p.v || 0) === vi ? { reinforced: p.reinforced, variant: v } : null;
      for (let lvl = 10; lvl >= 1; lvl--) {
        const raw = (v.levels || {})[String(lvl)];
        const val = raw === undefined || raw === '' ? ' ' : gapValue(raw, v.reinforced, sel ? !!sel.reinforced : v.reinforced);
        draft[colL(col + vi) + (row + 5 + (10 - lvl))] = val;
      }
    });
    if (p && p.on) {
      const w = p.width || '';
      if (w && w !== it.width) draft[colL(col) + (row + 1)] = `(${w})`;
      const lab = it.xl.labels[p.v || 0];
      if (lab) print[colL(col + 2) + (row - 1)] = lab;
    }
  }
  return setSheetsCells(await getBytes(S.shelves.xlsxTpl), { [DRAFT]: draft, [PRINT]: print });
}

const WIDTHS = ['65', '80', '100', '125'];
let filter = '';
let onlySelected = false;
const openGroups = new Set();

const cur = () => S.shelves.current;
const pick = (id) => cur().items[id];
const kindLabel = (k) => (SHELF_KINDS.find((x) => x.value === k) || {}).label || '';

function selOf(it) {
  const p = pick(it.id);
  if (!p) return null;
  const v = it.variants[p.v || 0] || it.variants[0];
  return { ...p, variant: v };
}

// Значение промежутка с учётом усиления: число меняется на разницу между выбранным и исходным
export function gapValue(raw, base, want) {
  const d = (want ? 1 : 0) - (base ? 1 : 0);
  if (!d) return raw;
  const m = String(raw).trim().match(/^(\d+)()$/);
  return m ? `${Number(m[1]) + d}${m[2]}` : raw;
}

export function cardRows(it, sel) {
  const v = sel ? sel.variant : it.variants[0];
  if (!v) return [];
  const keys = Object.keys(v.levels).map(Number).sort((a, b) => b - a);
  if (!keys.length) return [];
  const top = keys[0];
  const rows = [];
  for (let n = top; n >= 1; n--) rows.push({ shelf: n, gap: gapValue(v.levels[String(n)] || '', v.reinforced, sel ? !!sel.reinforced : v.reinforced) });
  return rows;
}

function cardTitle(it, sel) {
  const w = (sel && sel.width) || it.width;
  const reinforced = sel ? sel.reinforced : false;
  return { title: (w ? `(${w}) ` : '') + it.name.toLocaleUpperCase('ru-RU') + (reinforced ? ' — УСИЛ.' : '') };
}

export function renderShelves(tab, root) {
  const catalog = S.shelves.catalog;
  const selectedCount = catalog.filter((it) => pick(it.id) && pick(it.id).on).length;

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Поиск категории', 'aria-label': 'Поиск категории' });
  search.value = filter;
  search.addEventListener('input', () => { filter = search.value; drawGroups(); });

  const groupsWrap = h('div', { class: 'view-inner' });
  function drawGroups() {
    groupsWrap.innerHTML = '';
    const qq = filter.trim().toLowerCase();
    for (const g of S.shelves.groupsOrder) {
      let items = catalog.filter((it) => it.group === g);
      if (!items.length && !qq && !onlySelected) continue;
      if (qq) items = items.filter((it) => (it.name + ' ' + (it.sub || '')).toLowerCase().includes(qq));
      if (onlySelected) items = items.filter((it) => pick(it.id) && pick(it.id).on);
      if (!items.length && (qq || onlySelected)) continue;
      const n = catalog.filter((it) => it.group === g && pick(it.id) && pick(it.id).on).length;
      const det = h('details', { class: 'card glass group', open: openGroups.has(g) || !!qq || onlySelected },
        h('summary', null, h('span', null, g), h('span', { class: 'pill' + (n ? ' on' : '') }, n ? `${n} выбр.` : String(catalog.filter((it) => it.group === g).length)), h('span', { class: 'chev', 'aria-hidden': 'true' }, icon('down'))),
        h('div', { class: 'shelf-list' }, items.map((it) => itemRow(it)), h('button', { class: 'btn ghost sm dashed', onClick: () => editItem(null, g) }, icon('plus'), 'Категория')),
      );
      det.addEventListener('toggle', () => (det.open ? openGroups.add(g) : openGroups.delete(g)));
      groupsWrap.appendChild(det);
    }
  }
  drawGroups();

  root.append(
    h('div', { class: 'tab-head glass' },
      h('div', { class: 'tab-head-row' },
        h('div', null, h('h1', { class: 'tab-title' }, tab.title), h('p', { class: 'tab-sub' }, `${sessionLabel(S.session)} · выбрано ${selectedCount} из ${catalog.length}`)),
        h('button', { class: 'icon-btn glass-btn', 'aria-label': 'Настройки вкладки', onClick: () => tabSettingsDlg(tab) }, icon('gear')),
      ),
      h('div', { class: 'heights' },
        h('label', null, 'Карточек на листе',
          h('div', { class: 'seg' }, [1, 2, 4].map((n) => h('button', { class: 'seg-btn' + (cur().perPage === n ? ' on' : ''), 'aria-pressed': cur().perPage === n ? 'true' : 'false', onClick: () => update(() => { cur().perPage = n; }) }, String(n))))),
      ),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn ghost sm', onClick: openArchive }, icon('archive'), 'Архив'),
        h('button', { class: 'btn ghost sm', disabled: !selectedCount, onClick: saveToArchive }, 'В архив'),
        h('button', { class: 'btn primary sm grow', disabled: !selectedCount, onClick: printShelves }, icon('print'), `Печать${selectedCount ? ' · ' + selectedCount : ''}`),
      ),
      h('div', { class: 'toolbar' }, search,
        h('button', { class: 'btn ghost sm' + (onlySelected ? ' on' : ''), 'aria-pressed': onlySelected ? 'true' : 'false', onClick: () => { onlySelected = !onlySelected; update(() => {}); } }, 'Выбранные'),
      ),
    ),
    groupsWrap,
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn ghost sm', onClick: addGroup }, icon('plus'), 'Группа'),
      selectedCount ? h('button', { class: 'btn ghost sm', onClick: async () => { if (await confirmDlg('Сбросить выбор?', 'Снимутся все отмеченные категории и опции.', 'Сбросить')) update(() => { cur().items = {}; }); } }, 'Сбросить выбор') : null,
    ),
  );
}

function itemRow(it) {
  const p = pick(it.id);
  const on = !!(p && p.on);
  const id = 'sh' + it.id;
  const cb = h('input', { type: 'checkbox', id, class: 'check' });
  cb.checked = on;
  cb.addEventListener('change', () => update(() => {
    const x = cur().items[it.id] || { v: 0, width: '', reinforced: !!(it.variants[0] && it.variants[0].reinforced) };
    x.on = cb.checked;
    cur().items[it.id] = x;
  }));
  const hasNums = it.variants.some((v) => Object.keys(v.levels || {}).length);
  const info = [kindLabel(it.kind), it.width ? `ширина ${it.width}` : '', it.kind === 'showcase' ? 'только название' : hasNums ? `${it.variants.length > 1 ? it.variants.map((v) => v.label).join(' / ') : (it.variants[0] || {}).label || ''}` : 'деления не заданы'].filter(Boolean).join(' · ');
  const opts = [];
  if (on) {
    if (it.variants.length > 1) {
      opts.push(h('div', { class: 'seg mini' }, it.variants.map((v, i) => h('button', { class: 'seg-btn' + ((p.v || 0) === i ? ' on' : ''), onClick: () => update(() => { p.v = i; p.reinforced = !!v.reinforced; }) }, v.label))));
    }
    if (it.widthSelectable) {
      opts.push(h('div', { class: 'seg mini' }, WIDTHS.map((w) => h('button', { class: 'seg-btn' + (p.width === w ? ' on' : ''), onClick: () => update(() => { p.width = p.width === w ? '' : w; }) }, w))));
    }
    if (hasNums && it.kind !== 'showcase') {
      opts.push(h('button', { class: 'chip' + (p.reinforced ? ' on' : ''), 'aria-pressed': p.reinforced ? 'true' : 'false', onClick: () => update(() => { p.reinforced = !p.reinforced; }) }, 'Усиленный +1'));
      opts.push(h('button', { class: 'chip', onClick: () => previewCard(it) }, icon('eye'), 'Карточка'));
    }
  }
  return h('div', { class: 'shelf-row' + (on ? ' on' : '') },
    h('div', { class: 'shelf-top' },
      h('label', { class: 'check-wrap', for: id }, cb, h('span', { class: 'check-box', 'aria-hidden': 'true' })),
      h('label', { for: id, class: 'shelf-name' }, it.name, it.sub ? h('small', { class: 'sub' }, it.sub) : null, h('small', null, info), it.note ? h('small', null, it.note) : null),
      S.settings.showPencil ? h('button', { class: 'pencil', 'aria-label': 'Изменить категорию', onClick: () => menu(it.name, [{ label: 'Изменить', onClick: () => editItem(it) }, { label: 'Копия', onClick: () => copyItem(it) }, { label: 'Удалить', danger: true, onClick: () => deleteShelfItem(it) }]) }, icon('pencil')) : null,
    ),
    opts.length ? h('div', { class: 'shelf-opts' }, opts) : null,
  );
}

function cardBlock(it, perPage) {
  const sel = selOf(it);
  const rows = it.kind === 'showcase' ? [] : cardRows(it, sel);
  const v = sel ? sel.variant : it.variants[0];
  const tags = [it.sub, sel && sel.reinforced ? 'усиленный (+1 деление)' : ''].filter(Boolean);
  return { t: 'shelfcard', perPage, top: v ? v.label : '', ...cardTitle(it, sel), tags, rows, blankRows: it.kind === 'showcase' || rows.length ? 0 : 8, note: it.note };
}

async function previewCard(it) {
  const { renderBlocks } = await import('../pages.js');
  const box = h('div', { class: 'thumbs big' }, h('div', { class: 'spinner' }));
  openModal({ title: it.name, body: box, wide: true });
  const canv = await renderBlocks([cardBlock(it, 1)]);
  box.innerHTML = '';
  box.append(h('img', { src: canv[0].toDataURL('image/png'), alt: 'Карточка делений: ' + it.name, style: { width: '320px' } }));
}

// Редактор: деления по полкам для каждого варианта (снизу вверх)
async function editItem(it, group) {
  const isNew = !it;
  const base = it ? clone(it) : { id: uid(), group: group || S.shelves.groupsOrder[0], kind: 'rack', name: '', width: '', widthSelectable: true, variants: [{ label: 'Высокий 2,20', levels: {}, reinforced: false }, { label: 'Низкий 1,80', levels: {}, reinforced: false }], note: '' };
  const lvToStr = (lv) => Object.keys(lv).map(Number).sort((a, b) => a - b).map((n) => lv[n] || '-').join('; ');
  const strToLv = (s) => { const o = {}; s.split(';').map((x) => x.trim()).forEach((x, i) => { if (x && x !== '-') o[String(i + 1)] = x; }); return o; };
  const fields = [
    { key: 'name', label: 'Название (как в зонах)', value: base.name },
    { key: 'sub', label: 'Уточнение (например, «с попкорном»)', value: base.sub || '' },
    { key: 'group', label: 'Группа', value: base.group, options: S.shelves.groupsOrder.map((g) => ({ value: g, label: g })) },
    { key: 'kind', label: 'Тип', value: base.kind, options: SHELF_KINDS },
    { key: 'width', label: 'Ширина в названии (если одна), см', value: base.width, inputmode: 'numeric' },
    { key: 'widthSelectable', label: 'Ширину выбирать под магазин (габариты)', value: base.widthSelectable ? '1' : '', options: [{ value: '1', label: 'Да' }, { value: '', label: 'Нет' }] },
  ];
  base.variants.forEach((v, i) => {
    fields.push({ key: 'vl' + i, label: `Вариант ${i + 1}: подпись`, value: v.label });
    fields.push({ key: 'vv' + i, label: `Вариант ${i + 1}: деления над полкой 1; 2; 3… (снизу вверх, «-» — пусто)`, value: lvToStr(v.levels) });
    fields.push({ key: 'vr' + i, label: `Вариант ${i + 1}: числа уже с усилением?`, value: v.reinforced ? '1' : '', options: [{ value: '', label: 'Нет, обычный' }, { value: '1', label: 'Да, усиленный' }] });
  });
  if (base.variants.length < 2) {
    fields.push({ key: 'vl' + base.variants.length, label: 'Ещё вариант: подпись (необязательно)', value: '' });
    fields.push({ key: 'vv' + base.variants.length, label: 'Ещё вариант: деления', value: '' });
  }
  fields.push({ key: 'note', label: 'Примечание на карточке', value: base.note });
  const v = await formDlg(isNew ? 'Новая категория' : 'Категория', fields);
  if (!v) return;
  if (!v.name) { toast('Нужно название'); return; }
  const variants = [];
  for (let i = 0; i < 3; i++) {
    if (!(('vl' + i) in v)) continue;
    const lab = v['vl' + i], lv = strToLv(v['vv' + i] || '');
    if (!lab && !Object.keys(lv).length) continue;
    variants.push({ label: lab || `Вариант ${i + 1}`, levels: lv, reinforced: !!v['vr' + i] });
  }
  update((s) => {
    const target = isNew ? base : s.shelves.catalog.find((x) => x.id === it.id);
    Object.assign(target, { name: v.name, sub: v.sub, group: v.group, kind: v.kind, width: v.width, widthSelectable: !!v.widthSelectable, variants: variants.length ? variants : [{ label: 'Стандарт', levels: {}, reinforced: false }], note: v.note });
    if (isNew) s.shelves.catalog.push(target);
  });
}

function copyItem(it) {
  update((s) => { const c = clone(it); c.id = uid(); c.name += ' (копия)'; s.shelves.catalog.splice(s.shelves.catalog.indexOf(s.shelves.catalog.find((x) => x.id === it.id)) + 1, 0, c); });
}

async function addGroup() {
  const n = await promptDlg('Новая группа', { label: 'Например: Холодильники 2' });
  if (n && !S.shelves.groupsOrder.includes(n)) update((s) => { s.shelves.groupsOrder.push(n); openGroups.add(n); });
}

export async function deleteShelfItem(it) {
  if (await confirmDlg('Удалить категорию?', it.name, 'Удалить', 'Отмена', true)) update((s) => { s.shelves.catalog = s.shelves.catalog.filter((x) => x.id !== it.id); delete s.shelves.current.items[it.id]; });
}

async function printShelves() {
  const perPage = cur().perPage || 2;
  const items = S.shelves.groupsOrder.flatMap((g) => S.shelves.catalog.filter((it) => it.group === g && pick(it.id) && pick(it.id).on));
  if (S.shelves.xlsxTpl) {
    const how = await choiceDlg('Деления', 'Excel — ваш файл с листом «ПЕЧАТЬ»: шрифты, рамки и окошки как в оригинале. PDF — карточки, собранные приложением.', [
      { label: 'PDF', value: 'pdf' }, { label: 'Excel (лист «ПЕЧАТЬ»)', value: 'xlsx', kind: 'primary' },
    ]);
    if (!how) return;
    if (how === 'xlsx') {
      try {
        const bytes = await withBusy('Заполняю ваш файл делений…', () => shelvesXlsx(items));
        const noXl = items.filter((it) => !it.src);
        return deliver(bytes, `Деления — ${sessionLabel(S.session)}`, { excel: true, note: `Печатайте лист «ПЕЧАТЬ». Выбрано карточек: ${items.length}: ${items.map((it) => it.name).join(', ')}.` + (noXl.length ? ` Нет в файле (будут только в PDF): ${noXl.map((it) => it.name).join(', ')}.` : '') });
      } catch (e) { toast('Excel: ' + e.message, 'warn'); return; }
    }
  }
  const blocks = items.map((it) => cardBlock(it, perPage));
  try {
    const bytes = await withBusy('Собираю карточки…', async () => {
      const { pngs, size } = await blocksToPdf(blocks, { footer: `Деления · ${sessionLabel(S.session)} · ${fmtDate(new Date())}` });
      return buildPrint({ parts: [{ title: 'Деления', pngs, size, duplex: false }] });
    });
    deliver(bytes, `Деления — ${sessionLabel(S.session)}`);
  } catch (e) { toast('Ошибка: ' + e.message, 'warn'); }
}

async function saveToArchive() {
  update((s) => {
    s.shelves.archive.unshift({ id: uid(), osp: s.session.osp || '—', city: s.session.city || '', date: new Date().toISOString(), config: clone(s.shelves.current) });
  });
  toast('Сохранено в архив: ' + sessionLabel(S.session));
}

function openArchive() {
  let mode = 'month';
  const body = h('div');
  const m = openModal({ title: 'Архив магазинов', body, wide: true });
  function draw() {
    body.innerHTML = '';
    const arch = S.shelves.archive;
    body.appendChild(h('div', { class: 'seg' }, [['month', 'По месяцам'], ['osp', 'По ОСП']].map(([v, l]) => h('button', { class: 'seg-btn' + (mode === v ? ' on' : ''), onClick: () => { mode = v; draw(); } }, l))));
    if (!arch.length) { body.appendChild(h('p', { class: 'empty' }, 'Пока пусто. Нажмите «В архив», когда настроите деления под магазин.')); return; }
    const groups = new Map();
    for (const e of arch) {
      const k = mode === 'month' ? monthKey(e.date) : `ОСП ${e.osp}${e.city ? ' · ' + e.city : ''}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    for (const [k, list] of groups) {
      body.appendChild(h('h3', { class: 'sub-h' }, k));
      for (const e of list) {
        const n = Object.values(e.config.items).filter((x) => x.on).length;
        body.appendChild(h('div', { class: 'arch-row' },
          h('div', null, h('strong', null, `ОСП ${e.osp}${e.city ? ', ' + e.city : ''}`), h('small', null, `${fmtDate(e.date)} · ${n} катег.`)),
          h('button', { class: 'btn primary sm', onClick: async () => {
            if (!(await confirmDlg('Загрузить конфигурацию?', 'Текущий выбор заменится выбором из архива.', 'Загрузить'))) return;
            update((s) => { s.shelves.current = clone(e.config); });
            m.close(); toast('Конфигурация загружена');
          } }, 'Загрузить'),
          h('button', { class: 'icon-btn', 'aria-label': 'Удалить из архива', onClick: async () => {
            if (await confirmDlg('Удалить из архива?', null, 'Удалить', 'Отмена', true)) { update((s) => { s.shelves.archive = s.shelves.archive.filter((x) => x !== e); }); draw(); }
          } }, icon('trash')),
        ));
      }
    }
  }
  draw();
}
