// Состояние приложения: вкладки, документы, сеанс, справочники. Хранится в IndexedDB.
import { kvGet, kvSet } from './db.js';
import { uid, debounce, clone } from './util.js';

export const runId = uid(); // один «заход» в приложение
export let S = null;
const listeners = new Set();
const saveHooks = [];

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function onSaved(fn) { saveHooks.push(fn); }

const persist = debounce(async () => {
  await kvSet('state', S);
  for (const fn of saveHooks) { try { fn(S); } catch (e) { console.warn(e); } }
}, 350);

export function update(fn, { silent = false } = {}) {
  fn(S);
  S.savedAt = Date.now();
  persist();
  if (!silent) for (const l of listeners) l();
}
export function emit() { for (const l of listeners) l(); }

export async function loadState() {
  const saved = await kvGet('state');
  S = saved ? migrate(saved) : defaultState();
  if (!saved) await kvSet('state', S);
  return S;
}

export async function replaceState(next) {
  S = migrate(next);
  await kvSet('state', S);
  emit();
}

function migrate(s) {
  const d = defaultState();
  for (const k of Object.keys(d)) if (s[k] === undefined) s[k] = d[k];
  for (const k of Object.keys(d.settings)) if (s.settings[k] === undefined) s.settings[k] = d.settings[k];
  for (const k of Object.keys(d.settings.org)) if (s.settings.org[k] === undefined) s.settings.org[k] = d.settings.org[k];
  for (const k of Object.keys(d.lists)) if (s.lists[k] === undefined) s.lists[k] = d.lists[k];
  for (const k of Object.keys(d.schedule)) if (s.schedule[k] === undefined) s.schedule[k] = d.schedule[k];
  // сеанс: новые поля
  const ns = newSession();
  for (const k of Object.keys(ns)) if (s.session[k] === undefined) s.session[k] = ns[k];
  for (const k of Object.keys(ns.money)) if (s.session.money[k] === undefined) s.session.money[k] = ns.money[k];
  // версия 1 → 2: просрочка по сеансу, новый формат делений
  for (const doc of Object.values(s.docs)) {
    if ('skippedRun' in doc) { if (doc.skippedRun) doc.skippedSession = s.session.id; delete doc.skippedRun; }
  }
  if (s.shelves.catalog.some((c) => !c.variants)) s.shelves.catalog = s.shelves.catalog.map(upgradeShelf);
  if (!s.shelves.regional) s.shelves.regional = {};
  if (!s.contracts.version) s.contracts = { version: 2, cities: {} };
  if (!s.tabs.some((t) => t.kind === 'people')) s.tabs.push(d.tabs.find((t) => t.kind === 'people'));
  if (!s.tabs.some((t) => t.kind === 'materials')) s.tabs.push(d.tabs.find((t) => t.kind === 'materials'));
  if (!s.lists.warehouses.some((w) => /омск/i.test(w.name))) s.lists.warehouses.push({ name: 'РЦ Омск', region: 'СФО' });
  if (!s.session.kic) s.session.kic = { name: '', email: '' };
  for (const k of Object.keys(d.materials)) if (s.materials[k] === undefined) s.materials[k] = d.materials[k];
  // дательный падеж, сохранённый с ошибкой («Лысовай»), пересчитываем
  for (const k of ['hr', 'accountants', 'legal']) for (const c of s.lists[k] || []) if (/(ов|ев|ин|ын)ай(\s|$)/i.test(c.dative || '')) c.dative = '';
  const envSec = (s.tabs.find((t) => t.id === 'memos') || { sections: [] }).sections.find((x) => x.key === 'gen-env');
  if (envSec && !envSec.items.some((id) => s.docs[id] && s.docs[id].generator === 'ospLabels')) {
    const nd = makeDoc('memos', 'Таблички «ОСП + адрес» для маркировки отправок', { generator: 'ospLabels' });
    s.docs[nd.id] = nd; envSec.items.push(nd.id);
    if (envSec.title === 'Конверты и таблички') envSec.title = 'Конверты и таблички на склад';
  }
  s.version = d.version;
  return s;
}

function upgradeShelf(c) {
  if (c.variants) return c;
  const lv = (arr) => { const o = {}; (arr || []).forEach((n, i) => { o[String(i + 1)] = String(n); }); return o; };
  const variants = c.kind === 'rack' || c.kind === 'super'
    ? [{ label: 'Высокий 2,20', levels: lv(c.spacings && c.spacings.high), reinforced: false }, { label: 'Низкий 1,80', levels: lv(c.spacings && c.spacings.low), reinforced: false }]
    : [{ label: 'Стандарт', levels: lv(c.spacings && c.spacings.any), reinforced: false }];
  return { id: c.id, name: c.name, group: c.group, kind: c.kind, width: c.widthFixed || '', widthSelectable: !!c.widthSelectable, variants, note: c.note || '' };
}

// ---------- Сеанс ----------
export function newSession(prefill = {}) {
  return {
    id: uid(),
    startedAt: new Date().toISOString(),
    city: '', osp: '', address: '', until: '',
    region: '', warehouse: '', hr: [],
    pbMain: '', pbRegional: '', sbRegional: '', sbHead: '',
    manager: { fio: '', phone: '' },
    staff: [],
    money: { total: '', cashCount: '', perCash: [], perKkm: '', rest: '', days: [], note: '', contract: '', controllers: '' },
    stickerExtra: '',
    kic: { name: '', email: '' },
    lunchMgr: '15:00-16:00',
    ...prefill,
  };
}

export function sessionLabel(s) {
  if (!s) return '';
  const parts = [s.city, s.osp ? 'ОСП ' + s.osp : ''].filter(Boolean);
  return parts.join(' · ') || 'Новый сеанс';
}

export function dependValue(dep, session = S.session) {
  if (!dep || !session) return '';
  if (dep === 'hr') return (session.hr || [])[0] || '';
  return session[dep] || '';
}

// Условие, при котором документ нужен в сеансе (регион, склад, город, начало кода ОСП)
export function docApplies(d, s = S.session) {
  const w = d && d.when;
  if (!w) return true;
  const low = (x) => String(x || '').trim().toLowerCase();
  if (w.regions && w.regions.length && !w.regions.includes(s.region)) return false;
  if (w.warehouses && w.warehouses.length && !w.warehouses.includes(s.warehouse)) return false;
  if (w.cities && w.cities.length && !w.cities.some((c) => low(c) === low(s.city))) return false;
  if (w.notCities && w.notCities.some((c) => low(c) === low(s.city))) return false;
  return true;
}
export function whenLabel(d) {
  const w = d && d.when;
  if (!w) return '';
  return [w.regions && w.regions.join(', '), w.warehouses && w.warehouses.join(', '), w.cities && w.cities.join(', '), w.notCities && w.notCities.length ? 'кроме: ' + w.notCities.join(', ') : ''].filter(Boolean).join(' · ');
}

// Склад по городу и коду ОСП: Омск и коды на «О» (О120, О010) — РЦ Омск
export function autoWarehouse(st) {
  const s = st.session;
  const code = String(s.osp || '').trim();
  const omsk = /^омск$/i.test(String(s.city || '').trim()) || /^[ОO]\d/i.test(code);
  const wh = st.lists.warehouses.find((w) => /омск/i.test(w.name));
  if (omsk && wh) { s.warehouse = wh.name; if (!s.region) s.region = wh.region || 'СФО'; return; }
  if (s.warehouse && /омск/i.test(s.warehouse) && !omsk) {
    const other = st.lists.warehouses.find((w) => w.region === s.region && !/омск/i.test(w.name));
    if (other) s.warehouse = other.name;
  }
}

export const DEPENDS = [
  { value: '', label: 'Не зависит' },
  { value: 'warehouse', label: 'От склада' },
  { value: 'region', label: 'От региона' },
  { value: 'hr', label: 'От кадровика' },
];

// ---------- Документы ----------
export function makeDoc(tabId, title, extra = {}) {
  return { id: uid(), tabId, title, dependsOn: '', file: null, variants: {}, skippedSession: null, lastPrinted: null, ...extra };
}

// Файл, который сейчас действует для документа (с учётом зависимости от вводных)
export function activeFile(doc) {
  if (!doc) return null;
  if (doc.dependsOn) return doc.variants[dependValue(doc.dependsOn)] || null;
  return doc.file;
}
export function setActiveFile(doc, meta) {
  if (doc.dependsOn) {
    const v = dependValue(doc.dependsOn);
    if (!v) throw new Error('Сначала выберите значение во вводных: ' + DEPENDS.find((d) => d.value === doc.dependsOn).label.toLowerCase());
    doc.variants[v] = meta;
  } else doc.file = meta;
}

export function tabById(id) { return S.tabs.find((t) => t.id === id); }

export function makeTab(kind, title, extra = {}) {
  return {
    id: uid(), kind, title, builtin: false, hidden: false,
    settings: { printMode: S ? S.settings.defaultPrintMode : 'duplex', perItemPrint: true, cover: true, staleMode: 'ask' },
    sections: kind === 'docs' ? [{ id: uid(), title: 'Документы', items: [], printMode: '' }] : [],
    ...extra,
  };
}

// ---------- Начальные данные ----------
export const CONTACT_LISTS = {
  trainers: 'Тренинг-менеджеры', recruiters: 'Рекрутеры', hr: 'Кадровики', accountants: 'Бухгалтеры', legal: 'Юристы',
  pbMain: 'Главный специалист ПБ', pbRegional: 'Региональный специалист ПБ', sbHead: 'Начальник СБ', sbRegional: 'Региональный специалист СБ',
  other: 'Другие',
};

export const SCHEDULE_BLOCKS = [
  { id: 'morning', label: 'Зоны с 07:00 - 10:00' },
  { id: 'day', label: 'Зоны с 10:00 - 20:00' },
  { id: 'evening', label: 'Зоны с 20:00 - 22:00' },
];

function defaultState() {
  const docs = {};
  const sec = (tabId, title, names, opts = {}) => {
    const items = names.map((n) => {
      const [title2, dep, gen] = Array.isArray(n) ? n : [n, '', ''];
      const d = makeDoc(tabId, title2, { dependsOn: dep || '', generator: gen || '' });
      docs[d.id] = d;
      return d.id;
    });
    return { id: uid(), title, items, printMode: opts.printMode || '', collage: !!opts.collage, key: opts.key || '' };
  };

  const memos = {
    id: 'memos', kind: 'memos', title: 'Памятки / Бланки', builtin: true, hidden: false,
    settings: { printMode: 'duplex', perItemPrint: true, cover: false, staleMode: 'badge' },
    sections: [
      sec('memos', 'Конверты и таблички на склад', [
        ['Конверт кадровику', '', 'envHr'],
        ['Конверт бухгалтеру — документы (справки)', '', 'envAcc'],
        ['Конверт бухгалтеру — ГПХ документы (дворник)', '', 'envGph'],
        ['Конверт юристу', '', 'envLegal'],
        ['Таблички возврата: МОПы, ковёр и подконтрольная продукция', '', 'returnLabels'],
        ['Таблички «ОСП + адрес» для маркировки отправок', '', 'ospLabels'],
      ], { printMode: 'simplex', key: 'gen-env' }),
      sec('memos', 'Из вводных', [
        ['Расписка о размене', '', 'receipt'],
        ['График перерывов на обед', '', 'lunch'],
        ['Контакты для директора', '', 'contacts'],
        ['Размен и инкассация', '', 'cash'],
      ], { printMode: 'simplex', key: 'gen-main' }),
      sec('memos', 'Наклейки', [
        ['Наклейки (Word-шаблон: ОСП, адрес, ФИО)', '', 'stickersDocx'],
      ], { printMode: 'simplex', key: 'stickers' }),
      sec('memos', 'Склад', [], { key: 'warehouse' }),
      sec('memos', 'Памятки директору', [], { printMode: 'simplex', collage: true, key: 'director' }),
      sec('memos', 'Памятки сотрудникам', [], { printMode: 'simplex', collage: true, key: 'staff' }),
      sec('memos', 'Кассовые бланки', [], { key: 'cash' }),
      sec('memos', 'Табели и журналы', [
        ['Табель учёта рабочего времени', '', 'tabel'],
      ], { key: 'journals' }),
    ],
  };

  const instr = {
    id: 'instr', kind: 'docs', title: 'Инструкции', builtin: true, hidden: false,
    settings: { printMode: 'duplex', perItemPrint: true, cover: true, staleMode: 'badge' },
    sections: [{ id: uid(), title: 'Инструкции', items: [], printMode: '' }],
  };

  const simple = (id, kind, title) => ({ id, kind, title, builtin: true, hidden: false, settings: { printMode: 'simplex', perItemPrint: false, cover: false, staleMode: 'badge' }, sections: [] });

  return {
    version: 2,
    tabs: [
      memos,
      instr,
      simple('schedule', 'schedule', 'Сервисный график'),
      simple('plan', 'plan', 'Опорный план'),
      { ...simple('contracts', 'contracts', 'Договора'), settings: { printMode: 'duplex', perItemPrint: false, cover: false, staleMode: 'badge' } },
      simple('shelves', 'shelves', 'Деления'),
      simple('people', 'people', 'Контакты'),
      simple('materials', 'materials', 'Материалы к открытию'),
    ],
    activeTab: 'memos',
    docs,
    session: newSession(),
    sessions: [],
    lists: {
      regions: ['ЦФО', 'УФО', 'СФО'],
      warehouses: [
        { name: 'РЦ Обухово', region: 'ЦФО' },
        { name: 'РЦ Верхняя Пышма', region: 'УФО' },
        { name: 'РЦ Толмачево', region: 'СФО' },
        { name: 'РЦ Омск', region: 'СФО' },
      ],
      kic: [],
      hr: [], accountants: [], legal: [], trainers: [], recruiters: [], other: [],
      pbMain: [], pbRegional: [], sbRegional: [], sbHead: [],
      roles: ['Пекарь', 'Приёмщик', 'Кассир'],
      cities: [],
    },
    selection: {},
    staleAsked: {},
    schedule: { zones: [], bySession: {}, view: 'fio', yachchpMode: 'slash', blocks: SCHEDULE_BLOCKS.map((b) => ({ ...b })), peak: 'ЧАСЫ ПИК 17:00–20:00', rules: 'Выкладка товара, срок годности, дыры на полках, товар лицом к покупателю, чистота полок, ротация, ценники, ценникодержатели.' },
    plan: { items: [], done: {} },
    directory: {},
    materials: {
      folderId: '', folderUrl: '',
      groups: [
        { id: 'rules', title: 'Правила выкладки', words: ['СФО', 'УФО', 'ЦФО', '1-й формат'] },
        { id: 'open', title: 'Для открытия', words: ['5 метров холода', 'Инструкция выкладки ФРОВ', 'Чек-лист открытия магазина', 'уголок_потребителя', 'Шаблон письма о приемке'] },
        { id: 'team', title: 'Рабочая группа по открытию', words: ['Порядок открытия'], participants: true },
      ],
      files: {}, lastCheck: null, error: '',
    },
    contracts: { version: 2, cities: {} },
    shelves: {
      catalog: seedShelves().map(upgradeShelf),
      groupsOrder: SHELF_GROUPS.slice(),
      current: { items: {}, perPage: 2 },
      regional: {},
      archive: [],
    },
    settings: {
      showBadges: true,
      showReminders: true,
      showPencil: true,
      lowGlass: false,
      defaultPrintMode: 'duplex',
      compression: 'auto',
      drive: { url: '', key: '', autoSync: true, chatId: '' },
      org: { name: '', short: '', details: '', order: '', returnCopies: 4 },
      starterLoaded: false,
    },
  };
}

// ---------- Каталог делений ----------
export const SHELF_GROUPS = [
  'Холодильники', 'Заморозка', 'Кондитерка, шоколад, детское, чай, кофе', 'Напитки, алкоголь, сигареты',
  'Бакалея', 'Остальное', 'Химия (2 стеллажа)', 'Химия (3 стеллажа)', 'Прочие стеллажи', 'Торцы',
];

export const SHELF_KINDS = [
  { value: 'rack', label: 'Стеллаж' },
  { value: 'super', label: 'Суперструктура' },
  { value: 'fridge', label: 'Холодильник' },
  { value: 'freezer', label: 'Заморозка' },
  { value: 'endcap', label: 'Торец' },
  { value: 'showcase', label: 'Витрина' },
  { value: 'other', label: 'Другое' },
];

function seedShelves() {
  const out = [];
  // Строка: имя | флаги. d — ширина выбирается (габариты)
  const add = (group, kind, lines) => {
    for (const line of lines) {
      const [name, flags = ''] = line.split('|');
      const m = name.match(/\((\d{2,3})\)\s*$|\s(\d{2,3})\s*$/);
      out.push({ id: uid(), group, kind, name: name.trim(), widthFixed: m ? (m[1] || m[2]) : '', widthSelectable: flags.includes('d'), spacings: { high: [], low: [], any: [] }, note: '' });
    }
  };
  add('Холодильники', 'fridge', ['Холод ФРОВ', 'Молочка (от творога) 125', 'Молочка + торты / детский блок 125', 'Йогурты 125', 'Сыры 125', 'Рыба 125', 'Рыба + обеды 125', 'Мясо 125', 'Колбаса / Майонезы', 'Торты / Обеды 160', 'Напитки хол.']);
  add('Заморозка', 'freezer', ['Шкаф 2/3 дверцы', 'Мороженое ларь (бонета)', 'Мороженое Торрос']);
  add('Кондитерка, шоколад, детское, чай, кофе', 'rack', ['Кондитерка 1 (белая линия)', 'Кондитерка 2 (тубы)', 'Кондитерка 3 (жёлтая линия)', 'Наборы конфет|d', 'Шоколад 100', 'Шоколад 125', 'Детское питание|d', 'Игрушки|d', 'Прикасса (стеллаж Бэбифокс)|d', 'Кофе (100)', 'Чай (100)', 'Чай (125)', 'Чай / Кофе — общ.|d']);
  add('Напитки, алкоголь, сигареты', 'rack', ['Сладкая вода / газировки|d', 'Белая вода / минералки|d', 'Соки|d', 'Пиво 1 стеллаж|d', 'Пиво 2 стеллаж|d', 'Крепкий алкоголь|d', 'Вина — игристые|d', 'Закасса (с акцизом / без акциза)']);
  add('Бакалея', 'rack', ['Макароны|d', 'Крупы (100)', 'Крупы (125)', 'Консервация 1 ст. (100)', 'Консервация 1 ст. (125)', 'Консервация 2 ст. (200)', 'Мука / Масло|d', 'Кетчупы / Соусы стеллаж|d', 'ПБП — стеллаж|d', 'Специи 8 полок|d', 'Специи 7 полок|d']);
  add('Бакалея', 'super', ['Кетчупы / Соусы (суперструктура)', 'ПБП (суперструктура)']);
  add('Остальное', 'rack', ['Здоровое питание (ЗОЖ) стеллаж|d', 'Чипсы|d', 'Сухарики|d', 'Чипсы / Сухарики|d', 'Семечки, орешки|d', 'Семечки, орешки с попкорном|d', 'ФРОВ стеллаж|d', 'Конфетный стеллаж|d']);
  add('Остальное', 'showcase', ['Конфетная витрина', 'Мармеладная витрина', 'Хлебная витрина']);
  add('Остальное', 'other', ['Колготки', 'Кофестанция', 'Яйцо куриное']);
  add('Химия (2 стеллажа)', 'rack', ['Химия: порошки / чистящие / непрод.|d', 'Химия: гигиена / шампуни|d']);
  add('Химия (3 стеллажа)', 'rack', ['Химия 1|d', 'Химия 2|d', 'Химия 3|d']);
  add('Прочие стеллажи', 'rack', ['Зоотовары|d']);
  add('Прочие стеллажи', 'other', ['Сигареты (шкаф)']);
  add('Торцы', 'endcap', ['Снеки', 'Специи', 'Химия', 'Медицина', 'Прикасса', 'Игрушки', 'Мармелад', 'Кондитерка', 'Сладкие орешки', 'Экзотика', 'Колготки', 'Попкорн']);
  return out;
}

export function snapshot() { return clone(S); }
