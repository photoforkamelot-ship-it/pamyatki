// Вводные сеанса: город, ОСП, срок, склад, контакты, сотрудники, размен.
import { h, icon, fmtDate, todayISO, uid, clone } from '../util.js';
import { S, update, newSession, sessionLabel, emit, autoWarehouse } from '../store.js';
import { chipSelect, formDlg, confirmDlg, choiceDlg, openModal, toast } from '../ui.js';
import { autoLunch, dative } from '../generators.js';
import { contactsDlg } from './settings.js';

let cardOpen = null;
const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function field(label, input, hint) {
  const id = 'i' + uid();
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
}

function textInput(get, set, opts = {}) {
  const i = h('input', { class: 'input', type: opts.type || 'text', placeholder: opts.placeholder || '', inputmode: opts.inputmode, list: opts.list });
  i.value = get() ?? '';
  i.addEventListener('input', () => update(() => set(i.value), { silent: true }));
  if (opts.rerender) i.addEventListener('change', emit);
  return i;
}

const ENVELOPE_LISTS = ['hr', 'accountants', 'legal'];

export async function addContact(listKey, title, withRegion = true) {
  const env = ENVELOPE_LISTS.includes(listKey);
  const v = await formDlg(title, [
    { key: 'name', label: 'Фамилия Имя' },
    { key: 'phone', label: 'Телефон', type: 'tel', inputmode: 'tel' },
    ...(withRegion ? [{ key: 'region', label: 'Регион (необязательно)', value: S.session.region }] : []),
    ...(env ? [{ key: 'address', label: 'Куда на конверте (можно в две строки)', multiline: true, placeholder: listKey === 'hr' ? (S.session.warehouse || 'РЦ …') + '\nВ отдел кадров' : 'г. Томск, ул. …' }] : []),
  ]);
  if (!v || !v.name) return null;
  update((s) => { s.lists[listKey].push({ name: v.name, phone: v.phone, region: v.region || '', address: v.address || '', dative: env ? dative(v.name) : '' }); });
  return v.name;
}

function lunchDlg() {
  const s = S.session;
  const staff = s.staff.filter((p) => p.fio);
  const rows = staff.map((p, i) => {
    const cur = (p.lunch && p.lunch.some(Boolean)) ? p.lunch.slice() : autoLunch(i);
    const inputs = [0, 1, 2, 3].map((k) => { const x = h('input', { class: 'input', 'aria-label': `${p.fio}: перерыв ${k + 1}` }); x.value = cur[k] || ''; return x; });
    return { p, inputs };
  });
  const mgr = h('input', { class: 'input', 'aria-label': 'Обед управляющего' }); mgr.value = s.lunchMgr || '15:00-16:00';
  openModal({
    title: 'График перерывов на обед', wide: true,
    body: h('div', { class: 'form' },
      h('p', { class: 'cap' }, 'По умолчанию время расставлено со сдвигом: 10:30, 11:00, 11:30 и далее каждые 3 часа по 30 минут. Исправьте, если нужно.'),
      h('div', { class: 'field' }, h('label', null, 'Управляющий: ' + (s.manager.fio || '—')), mgr),
      ...rows.map((r) => h('div', { class: 'field' }, h('label', null, r.p.fio), h('div', { class: 'grid-4' }, r.inputs))),
      staff.length ? null : h('p', { class: 'empty' }, 'Сначала добавьте сотрудников.'),
    ),
    actions: [
      { label: 'Сбросить', kind: 'ghost', onClick: () => update(() => { staff.forEach((p) => { p.lunch = null; }); }) },
      { label: 'Сохранить', kind: 'primary', onClick: () => update(() => { s.lunchMgr = mgr.value.trim(); rows.forEach((r) => { r.p.lunch = r.inputs.map((x) => x.value.trim()); }); }) },
    ],
  });
}

function contactChips(listKey, sessionKey, title, multi = false) {
  const list = S.lists[listKey];
  // сначала свои для региона
  const reg = S.session.region;
  const opts = list.slice().sort((a, b) => (b.region === reg) - (a.region === reg));
  return chipSelect({
    options: opts,
    multi,
    value: S.session[sessionKey],
    keyOf: (o) => o.name,
    labelOf: (o) => o.name + (o.region && o.region !== reg ? ` · ${o.region}` : ''),
    onChange: (v) => update((s) => { s.session[sessionKey] = v; }),
    onAdd: async () => {
      const name = await addContact(listKey, 'Добавить: ' + title.toLowerCase());
      if (name) update((s) => { s.session[sessionKey] = multi ? [...(s.session[sessionKey] || []), name] : name; });
    },
  });
}

export function renderSessionCard() {
  const s = S.session;
  const open = cardOpen ?? (!s.city || !s.osp);
  const expired = s.until && s.until < todayISO();

  const staffList = h('div', { class: 'staff' });
  function drawStaff() {
    staffList.innerHTML = '';
    s.staff.forEach((p, i) => {
      const role = h('select', { class: 'input', 'aria-label': 'Функционал' }, [h('option', { value: '' }, 'Функционал…'), ...S.lists.roles.map((r) => h('option', { value: r, selected: p.role === r }, r))]);
      role.addEventListener('change', () => update(() => { p.role = role.value; }, { silent: true }));
      const shift = h('select', { class: 'input', 'aria-label': 'Смена' }, [['', 'Смена'], ['1', 'Смена 1'], ['2', 'Смена 2']].map(([v, l]) => h('option', { value: v, selected: String(p.shift || '') === v }, l)));
      shift.addEventListener('change', () => update(() => { p.shift = shift.value; }, { silent: true }));
      const fio = textInput(() => p.fio, (v) => (p.fio = v), { placeholder: 'Фамилия Имя Отчество' });
      fio.setAttribute('aria-label', 'ФИО сотрудника ' + (i + 1));
      const pos = textInput(() => p.position, (v) => (p.position = v), { placeholder: 'Должность' });
      pos.setAttribute('aria-label', 'Должность');
      staffList.appendChild(h('div', { class: 'staff-row' }, fio, pos, role, shift,
        h('button', { class: 'icon-btn', 'aria-label': 'Удалить сотрудника', onClick: () => { update(() => { s.staff.splice(i, 1); }, { silent: true }); drawStaff(); } }, icon('trash'))));
    });
  }
  drawStaff();

  const perCash = h('div', { class: 'grid-2' });
  function drawCash() {
    perCash.innerHTML = '';
    const n = Number(s.money.cashCount) || 0;
    for (let i = 0; i < n; i++) {
      perCash.appendChild(field(`Касса ${i + 1}, ₽`, textInput(() => s.money.perCash[i], (v) => (s.money.perCash[i] = v), { type: 'number', inputmode: 'decimal' })));
    }
  }
  drawCash();
  const cashCount = textInput(() => s.money.cashCount, (v) => { s.money.cashCount = v; }, { type: 'number', inputmode: 'numeric' });
  cashCount.addEventListener('input', drawCash);

  const citiesList = h('datalist', { id: 'cities-list' }, S.lists.cities.map((c) => h('option', { value: c })));

  const body = h('div', { class: 'session-body' },
    h('div', { class: 'grid-2' },
      field('Город', textInput(() => s.city, (v) => { s.city = v; autoWarehouse(S); S.selection.memos = undefined; }, { list: 'cities-list', rerender: true })),
      field('ОСП (код магазина)', textInput(() => s.osp, (v) => { s.osp = v; autoWarehouse(S); S.selection.memos = undefined; }, { rerender: true, placeholder: 'например, АБ12' })),
      field('Адрес магазина', textInput(() => s.address, (v) => (s.address = v), { placeholder: 'пр-т Победы, 302' }), 'Без города: он подставится сам'),
      field('Работаем до', textInput(() => s.until, (v) => (s.until = v), { type: 'date', rerender: true }), 'Это срок сеанса: командировка или период запуска'),
    ),
    citiesList,

    h('h3', { class: 'sub-h' }, 'Регион и склад'),
    chipSelect({
      options: S.lists.regions, value: s.region,
      onChange: (v) => update((st) => {
        st.session.region = v;
        const wh = st.lists.warehouses.find((w) => w.region === v);
        if (wh) st.session.warehouse = wh.name;
        autoWarehouse(st);
        st.selection.memos = undefined;
      }),
      onAdd: async () => { const v = await formDlg('Новый регион', [{ key: 'name', label: 'Название, например ПФО' }]); if (v && v.name) update((st) => { st.lists.regions.push(v.name); st.session.region = v.name; }); },
    }),
    chipSelect({
      options: S.lists.warehouses, value: s.warehouse, keyOf: (o) => o.name, labelOf: (o) => o.name + (o.region ? ` · ${o.region}` : ''),
      onChange: (v) => update((st) => { st.session.warehouse = v; st.selection.memos = undefined; }),
      onAdd: async () => {
        const v = await formDlg('Новый склад', [{ key: 'name', label: 'Название РЦ' }, { key: 'region', label: 'Регион', value: s.region }]);
        if (v && v.name) update((st) => { st.lists.warehouses.push({ name: v.name, region: v.region }); st.session.warehouse = v.name; });
      },
    }),

    h('h3', { class: 'sub-h' }, 'Кадровики'),
    contactChips('hr', 'hr', 'Кадровик', true),
    h('p', { class: 'cap' }, 'На конверт кадровику печатается свой лист для каждого выбранного.'),
    h('div', { class: 'row-actions' },
      h('span', { class: 'cap' }, 'Бухгалтер: ' + (((S.lists.accountants || [])[0] || {}).name || 'не указан') + ' · Юрист: ' + (((S.lists.legal || [])[0] || {}).name || 'не указан')),
      h('button', { class: 'btn ghost sm', onClick: contactsDlg }, 'Справочник контактов'),
    ),

    h('h3', { class: 'sub-h' }, 'Пожарная безопасность'),
    h('p', { class: 'cap' }, 'Главный специалист'), contactChips('pbMain', 'pbMain', 'Главный специалист ПБ'),
    h('p', { class: 'cap' }, 'Региональный специалист'), contactChips('pbRegional', 'pbRegional', 'Региональный специалист ПБ'),

    h('h3', { class: 'sub-h' }, 'Служба безопасности'),
    h('p', { class: 'cap' }, 'Начальник СБ'), contactChips('sbHead', 'sbHead', 'Начальник СБ'),
    h('p', { class: 'cap' }, 'Региональный специалист'), contactChips('sbRegional', 'sbRegional', 'Региональный специалист СБ'),

    h('h3', { class: 'sub-h' }, 'Управляющий магазином'),
    h('div', { class: 'grid-2' },
      field('ФИО', textInput(() => s.manager.fio, (v) => (s.manager.fio = v))),
      field('Телефон', textInput(() => s.manager.phone, (v) => (s.manager.phone = v), { type: 'tel', inputmode: 'tel' })),
    ),

    h('h3', { class: 'sub-h' }, 'Сотрудники'),
    h('p', { class: 'cap' }, 'Функционал и смена нужны для сервисного графика. Обычно по два человека на функционал в разных сменах.'),
    staffList,
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn ghost sm', onClick: () => { update(() => { s.staff.push({ id: uid(), fio: '', position: '', role: '', shift: '' }); }, { silent: true }); drawStaff(); } }, icon('plus'), 'Сотрудник'),
      h('button', { class: 'btn ghost sm', onClick: lunchDlg }, 'Обеды…'),
    ),

    h('details', { class: 'opt' },
      h('summary', null, 'Размен и инкассация (необязательно)'),
      h('p', { class: 'cap' }, 'Пустые поля останутся в памятках линиями для ручного заполнения.'),
      h('div', { class: 'grid-2' },
        field('Размен на 1 ККМ, ₽', textInput(() => s.money.perKkm, (v) => (s.money.perKkm = v), { type: 'number', inputmode: 'decimal' })),
        field('Количество касс (ККМ)', cashCount),
        field('Сумма размена, всего ₽', textInput(() => s.money.total, (v) => (s.money.total = v), { type: 'number', inputmode: 'decimal', placeholder: 'посчитается: размен × ККМ' })),
        field('Максимум в магазине после инкассации, ₽', textInput(() => s.money.rest, (v) => (s.money.rest = v), { type: 'number', inputmode: 'decimal' })),
        field('Договор на инкассацию', textInput(() => s.money.contract, (v) => (s.money.contract = v), { placeholder: '№ … от …' })),
        field('Контроль возлагается на', textInput(() => s.money.controllers, (v) => (s.money.controllers = v), { placeholder: 'Иванову И.И., Петрову П.П.' })),
      ),
      perCash,
      h('button', { class: 'btn ghost sm', onClick: () => {
        const n = Number(s.money.cashCount), t = Number(s.money.total);
        if (!n || !t) { toast('Укажите сумму и количество касс'); return; }
        update(() => { s.money.perCash = Array.from({ length: n }, () => String(Math.round(t / n))); }, { silent: true });
        drawCash();
      } }, 'Разделить поровну'),
      h('p', { class: 'cap' }, 'Дни инкассации'),
      chipSelect({ options: DAYS, multi: true, value: s.money.days, onChange: (v) => update(() => { s.money.days = DAYS.filter((d) => v.includes(d)); }, { silent: true }) }),
      field('Примечание', textInput(() => s.money.note, (v) => (s.money.note = v))),
    ),
  );

  const det = h('details', { class: 'card glass session-card', open },
    h('summary', null,
      h('div', null,
        h('span', { class: 'eyebrow' }, 'Вводные сеанса'),
        h('strong', null, sessionLabel(s)),
        h('small', null, [s.warehouse, s.until ? 'до ' + fmtDate(s.until) : ''].filter(Boolean).join(' · ') || 'Заполните, чтобы памятки собрались под этот магазин'),
      ),
      h('span', { class: 'chev', 'aria-hidden': 'true' }, icon('down')),
    ),
    body,
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn ghost sm', onClick: startNewSession }, 'Новый сеанс'),
      S.sessions.length ? h('button', { class: 'btn ghost sm', onClick: pastSessions }, 'Прошлые сеансы') : null,
    ),
  );

  det.addEventListener('toggle', () => { cardOpen = det.open; });

  const banner = expired ? h('div', { class: 'banner stale' },
    h('strong', null, `Срок сеанса истёк ${fmtDate(s.until)}`),
    h('span', null, 'Продлите срок или начните новый сеанс для другого магазина.'),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn ghost sm', onClick: () => det.open = true }, 'Продлить'),
      h('button', { class: 'btn primary sm', onClick: startNewSession }, 'Новый сеанс'),
    )) : null;

  return h('div', null, banner, det);
}

export async function startNewSession() {
  const how = await choiceDlg('Новый сеанс', 'Текущий сеанс сохранится в «Прошлые сеансы».', [
    { label: 'Отмена', value: null },
    { label: 'Скопировать контакты', value: 'copy' },
    { label: 'С нуля', value: 'empty', kind: 'primary' },
  ]);
  if (!how) return;
  const v = await formDlg('Где работаем', [
    { key: 'city', label: 'Город' },
    { key: 'osp', label: 'ОСП' },
    { key: 'until', label: 'Работаем до', type: 'date' },
  ], 'Начать');
  if (!v) return;
  update((st) => {
    if (st.session.city || st.session.osp) st.sessions.unshift(st.session);
    const cur = st.session;
    const prefill = how === 'copy' ? {
      region: cur.region, warehouse: cur.warehouse, hr: clone(cur.hr), pbMain: cur.pbMain, pbRegional: cur.pbRegional, sbHead: cur.sbHead, sbRegional: cur.sbRegional,
    } : {};
    st.session = newSession({ ...prefill, city: v.city, osp: v.osp, until: v.until });
    const dflt = (st.settings.sessionDefaults || {}).money || {};
    for (const [k, val] of Object.entries(dflt)) if (!st.session.money[k]) st.session.money[k] = val;
    autoWarehouse(st);
    st.selection.memos = undefined;
    if (v.city && !st.lists.cities.includes(v.city)) st.lists.cities.push(v.city);
  });
  toast('Новый сеанс начат');
}

async function pastSessions() {
  const list = h('div', { class: 'menu-list' }, S.sessions.map((ss, i) => h('button', {
    class: 'menu-item',
    onClick: async () => {
      m.close();
      if (!(await confirmDlg('Открыть сеанс?', `${sessionLabel(ss)}. Текущий сохранится в прошлых.`, 'Открыть'))) return;
      update((st) => {
        const cur = st.session;
        st.session = st.sessions.splice(i, 1)[0];
        if (cur.city || cur.osp) st.sessions.unshift(cur);
      });
    },
  }, h('span', null, sessionLabel(ss)), h('small', null, `начат ${fmtDate(ss.startedAt)}${ss.until ? ' · до ' + fmtDate(ss.until) : ''}`))));
  const m = openModal({ title: 'Прошлые сеансы', body: list });
}

export async function onboarding() {
  const v = await formDlg('С чего начнём?', [
    { key: 'city', label: 'В каком городе работаем?' },
    { key: 'osp', label: 'Для какого ОСП?' },
    { key: 'until', label: 'До какого числа командировка или работа?', type: 'date' },
  ], 'Начать');
  if (!v) return;
  update((st) => {
    Object.assign(st.session, v);
    if (v.city && !st.lists.cities.includes(v.city)) st.lists.cities.push(v.city);
  });
}
