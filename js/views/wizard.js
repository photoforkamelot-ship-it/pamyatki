// Вводные сеанса — пошаговым опросником: один экран — одна тема, Enter ведёт дальше,
// незаполненное подсвечено, под полем — для каких документов оно нужно.
import { h, icon, uid, plural } from '../util.js';
import { S, update, emit, autoWarehouse } from '../store.js';
import { openModal, chipSelect, formDlg } from '../ui.js';
import { dative, genitive } from '../generators.js';
import { book, absorbLegacy, isHidden } from '../contactbook.js';
import { addPerson, editPerson } from './people.js';

const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const POSITION = 'продавец-кассир';
const low = (x) => String(x || '').trim().toLowerCase();
const filled = (v) => (Array.isArray(v) ? v.length > 0 : String(v ?? '').trim() !== '');

// Что нужно заполнить и для чего — по шагам
export const STEPS = [
  { id: 'shop', title: 'Магазин', check: (s) => [s.city, s.osp, s.address] },
  { id: 'region', title: 'Регион и склад', check: (s) => [s.region, s.warehouse] },
  { id: 'manager', title: 'Управляющий', check: (s) => [s.manager.fio, s.manager.phone] },
  { id: 'staff', title: 'Сотрудники', check: (s) => [(s.staff || []).filter((p) => p.fio)] },
  { id: 'hr', title: 'Кадровики', check: (s) => [s.hr] },
  { id: 'contacts', title: 'Контакты по отделам', check: (s) => [s.region], optional: true },
  { id: 'money', title: 'Размен и инкассация', check: (s) => [s.money.perKkm, s.money.cashCount, s.money.rest, s.money.days], optional: true },
];
export function stepStatus(step, s = S.session) {
  const vals = step.check(s);
  const n = vals.filter(filled).length;
  return { done: n === vals.length, empty: vals.length - n };
}

// ---------- поля ----------
function input(get, set, { placeholder = '', type = 'text', inputmode, required = false, list } = {}) {
  const el = h('input', { class: 'input', type, placeholder, inputmode, list, enterkeyhint: 'next' });
  el.value = get() ?? '';
  const mark = () => el.classList.toggle('need', required && !el.value.trim());
  mark();
  el.addEventListener('input', () => { update(() => set(el.value), { silent: true }); mark(); });
  return el;
}
function fieldBox(label, control, forDocs, hint) {
  return h('div', { class: 'field wz-field' },
    h('label', null, label),
    control,
    forDocs ? h('small', { class: 'for' }, 'Нужно для: ' + forDocs) : null,
    hint ? h('small', { class: 'hint' }, hint) : null,
  );
}

// ---------- шаги ----------
function stepShop(s) {
  const cities = h('datalist', { id: 'wz-cities' }, S.lists.cities.map((c) => h('option', { value: c })));
  return [
    cities,
    fieldBox('Город', input(() => s.city, (v) => { s.city = v; autoWarehouse(S); }, { placeholder: 'Например: Пермь', required: true, list: 'wz-cities' }),
      'конверты, таблички, наклейки, расписка, КИЦ в памятке директору'),
    fieldBox('Код ОСП', input(() => s.osp, (v) => { s.osp = v.toUpperCase(); autoWarehouse(S); }, { placeholder: 'Например: ПР22', required: true }),
      'всё: в начале имени каждого файла, на табличках и наклейках'),
    fieldBox('Адрес магазина (без города)', input(() => s.address, (v) => { s.address = v; }, { placeholder: 'Например: ул. Ленина, 5', required: true }),
      'конверты, таблички возврата, наклейки, расписка'),
    fieldBox('Работаем до', input(() => s.until, (v) => { s.until = v; }, { type: 'date' }),
      'срок сеанса: после него приложение напомнит начать новый'),
  ];
}

function stepRegion(s, redraw) {
  return [
    fieldBox('Регион', chipSelect({
      options: S.lists.regions, value: s.region,
      onChange: (v) => {
        update((st) => {
          st.session.region = v;
          const wh = st.lists.warehouses.find((w) => w.region === v);
          if (wh) st.session.warehouse = wh.name;
          autoWarehouse(st);
          // кадровики региона выбираются сами
          if (!st.session.hr.length) st.session.hr = (st.lists.hr || []).filter((c) => c.region === v).map((c) => c.name);
          st.selection.memos = undefined;
        }, { silent: true });
        redraw();
      },
    }), 'склад, контакты, журналы (электрощитовые — только ЦФО), шаблоны табличек'),
    fieldBox('Склад (РЦ)', chipSelect({
      options: S.lists.warehouses.filter((w) => !s.region || !w.region || w.region === s.region), value: s.warehouse,
      keyOf: (o) => o.name, labelOf: (o) => o.name,
      onChange: (v) => { update((st) => { st.session.warehouse = v; st.selection.memos = undefined; }, { silent: true }); redraw(); },
    }), 'памятки склад, бланк МОПов (Обухово), адрес на конверте кадровику',
    'Омск и коды ОСП на «О» — РЦ Омск ставится сам'),
  ];
}

function stepManager(s) {
  const prev = h('small', { class: 'hint' });
  const showPrev = () => { prev.textContent = s.manager.fio ? `На конвертах: «ОТ ${genitive(s.manager.fio).toUpperCase()}»` : ''; };
  showPrev();
  const fio = input(() => s.manager.fio, (v) => { s.manager.fio = v; showPrev(); }, { placeholder: 'Фамилия Имя Отчество: Чепкасова Анна Викторовна', required: true });
  return [
    fieldBox('ФИО управляющего полностью', fio, '«ОТ кого» на конвертах, расписка, табель, обеды'),
    prev,
    fieldBox('Телефон', input(() => s.manager.phone, (v) => { s.manager.phone = v; }, { type: 'tel', inputmode: 'tel', placeholder: '8-900-000-00-00', required: true }),
      'конверты (строка «ТЕЛ.»)', 'Дефисы ставятся сами'),
  ];
}

function stepStaff(s, redraw) {
  const roles = S.lists.roles;
  const rows = (s.staff || []).map((p, i) => h('div', { class: 'wz-staff' },
    h('div', { class: 'wz-staff-top' },
      h('span', { class: 'wz-num' }, String(i + 1)),
      input(() => p.fio, (v) => { p.fio = v; }, { placeholder: 'Фамилия Имя Отчество', required: true }),
      h('button', { class: 'icon-btn', 'aria-label': 'Удалить сотрудника', onClick: () => { update(() => { s.staff.splice(i, 1); }, { silent: true }); redraw(); } }, icon('trash')),
    ),
    input(() => p.position || POSITION, (v) => { p.position = v; }, { placeholder: POSITION }),
    h('div', { class: 'wz-plates' },
      chipSelect({ options: roles, value: p.role, onChange: (v) => { update(() => { p.role = v; }, { silent: true }); } }),
      chipSelect({ options: ['1', '2'], value: String(p.shift || ''), labelOf: (o) => o + ' смена', onChange: (v) => { update(() => { p.shift = v; }, { silent: true }); } }),
    ),
  ));
  return [
    h('p', { class: 'cap' }, 'Нужно для: обеды, наклейки, сервисный график и ЯЧЧП, табель. Должность по умолчанию — «продавец-кассир».'),
    ...rows,
    h('button', { class: 'btn ghost dashed', onClick: () => {
      update(() => { s.staff.push({ id: uid(), fio: '', position: POSITION, role: '', shift: s.staff.length % 2 ? '2' : '1' }); }, { silent: true });
      redraw(() => { const all = document.querySelectorAll('.wz-staff .input'); const last = all[all.length - 2]; last && last.focus(); });
    } }, icon('plus'), 'Сотрудник'),
  ];
}

function stepHr(s, redraw) {
  const reg = s.region;
  const opts = (S.lists.hr || []).slice().sort((a, b) => (b.region === reg) - (a.region === reg));
  const chosen = (s.hr || []).map((n) => (S.lists.hr || []).find((c) => c.name === n) || { name: n });
  return [
    fieldBox('Кому конверт с кадровыми документами', chipSelect({
      options: opts, multi: true, value: s.hr, keyOf: (o) => o.name,
      labelOf: (o) => o.name + (o.region && o.region !== reg ? ` · ${o.region}` : ''),
      onChange: (v) => { update(() => { s.hr = v; }, { silent: true }); redraw(); },
      onAdd: async () => {
        const v = await formDlg('Новый кадровик', [
          { key: 'name', label: 'Фамилия Имя', placeholder: 'Лысова Алёна' },
          { key: 'phone', label: 'Телефон', type: 'tel', inputmode: 'tel' },
          { key: 'address', label: 'Куда на конверте', multiline: true, value: (s.warehouse || 'РЦ …') + '\nВ отдел кадров' },
        ]);
        if (!v || !v.name) return;
        update((st) => { st.lists.hr.push({ name: v.name, phone: v.phone, region: s.region || '', address: v.address, dative: dative(v.name) }); st.session.hr = [...(st.session.hr || []), v.name]; }, { silent: true });
        redraw();
      },
    }), 'конверт кадровику — свой лист на каждого выбранного'),
    chosen.length ? h('div', { class: 'wz-preview' }, chosen.map((c) => h('div', null, '✉ КОМУ: ', h('strong', null, (c.dative || dative(c.name)).toUpperCase())))) : null,
  ];
}

// Контакты региона по отделам: с первого объекта — из шаблона, дальше — как в последний раз в этом регионе
let openSec = '';
function stepContacts(s, redraw) {
  if (!s.region) return [h('p', { class: 'cap' }, 'Сначала выберите регион на шаге 2 — контакты у каждого региона свои.')];
  absorbLegacy(s.region);
  const list = book(s.region);
  const out = [h('p', { class: 'cap' }, `Контакты ${s.region}. Добавляйте людей в нужный отдел — начните вводить фамилию, и знакомые подставятся сами. Всё сохранится для следующих объектов в ${s.region}.`)];
  // разделы свёрнуты: в заголовке — кто уже есть; раскрыть — править и добавлять
  const secs = [];
  list.forEach((r, i) => { if (r.section) secs.push({ r, i, people: [] }); else if (secs.length) secs[secs.length - 1].people.push(r); });
  for (const sec of secs) {
    const names = sec.people.map((p) => (p.name ? p.name.split(' ').slice(0, 2).join(' ') : !p.phone && !p.email ? '' : p.dept)).filter(Boolean);
    const box = h('div', { class: 'cb-list' }, sec.people.map((r) => h('div', { class: 'cb-row' + (isHidden(r) ? ' off' : '') },
      h('button', { class: 'cb-main', onClick: async () => { await editPerson(s.region, r); redraw(); } },
        h('div', { class: 'cb-name' }, r.name || r.dept || '—'),
        h('div', { class: 'cb-meta' }, [r.name ? r.dept : '', (r.phone || '').split(/,\s*/)[0]].filter(Boolean).join(' · ') || ' ')))));
    const d = h('details', { class: 'card glass wz-cb' },
      h('summary', null, h('b', null, sec.r.section), h('span', null, names.length ? names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '') : 'добавить')),
      box,
      h('button', { class: 'cb-add', onClick: async () => { openSec = sec.r.section; await addPerson(s.region, sec.i); redraw(); } }, '+ добавить в «' + sec.r.section + '»'));
    if (openSec === sec.r.section) d.open = true;
    d.addEventListener('toggle', () => { if (d.open) openSec = sec.r.section; });
    out.push(d);
  }
  return out;
}

function stepMoney(s) {
  const m = s.money;
  const total = h('small', { class: 'hint' });
  const calc = () => { const t = (Number(m.perKkm) || 0) * (Number(m.cashCount) || 0); total.textContent = t ? `Итого размен: ${t.toLocaleString('ru-RU')} ₽` : ''; };
  calc();
  return [
    fieldBox('Размен на 1 кассу, ₽', input(() => m.perKkm, (v) => { m.perKkm = v; calc(); }, { inputmode: 'numeric', placeholder: 'Например: 4000', required: true }), 'расписка о размене'),
    fieldBox('Количество касс', input(() => m.cashCount, (v) => { m.cashCount = v; calc(); }, { inputmode: 'numeric', placeholder: 'Например: 3', required: true }), 'расписка, покупюрник'),
    total,
    fieldBox('Максимум денег в магазине после инкассации, ₽', input(() => m.rest, (v) => { m.rest = v; }, { inputmode: 'numeric', placeholder: 'Например: 30000', required: true }), 'расписка о размене'),
    fieldBox('Дни инкассации', chipSelect({ options: DAYS, multi: true, value: m.days, onChange: (v) => update(() => { m.days = DAYS.filter((d) => v.includes(d)); }, { silent: true }) }), 'расписка о размене'),
    fieldBox('Договор на инкассацию', input(() => m.contract, (v) => { m.contract = v; }, { placeholder: '№ 16-01/149 от 16.08.2012 г' }), 'расписка о размене'),
    fieldBox('Контроль возлагается на', input(() => m.controllers, (v) => { m.controllers = v; }, { placeholder: 'Конохову Н.Ф., Вагнер Е.В' }), 'расписка о размене', 'В винительном падеже: «на кого»'),
  ];
}

const BUILD = { shop: stepShop, region: stepRegion, manager: stepManager, staff: stepStaff, hr: stepHr, contacts: stepContacts, money: stepMoney };

// ---------- окно ----------
export function sessionWizard(startId) {
  let i = Math.max(0, STEPS.findIndex((x) => x.id === startId));
  const s = S.session;
  const box = h('div', { class: 'wizard wz' });
  const m = openModal({ title: 'Вводные', body: box, wide: true, top: true, onClose: () => emit() });

  function draw(after) {
    const step = STEPS[i];
    box.innerHTML = '';
    const dots = h('div', { class: 'wz-dots' }, STEPS.map((st, k) => {
      const stt = stepStatus(st);
      return h('button', { class: 'wz-dot' + (k === i ? ' cur' : '') + (stt.done ? ' ok' : st.optional ? '' : ' need'), 'aria-label': st.title, onClick: () => { i = k; draw(); } }, String(k + 1));
    }));
    const body = h('div', { class: 'wz-body' }, ...BUILD[step.id](s, (cb) => { draw(cb); }).filter(Boolean));
    box.append(dots, h('h3', { class: 'wz-title' }, `${i + 1}. ${step.title}`, step.optional ? h('span', { class: 'pill' }, 'можно позже') : null), body);
    m.setTitle(`Вводные · ${i + 1} из ${STEPS.length}`);
    m.setActions([
      i > 0 ? { label: 'Назад', kind: 'ghost', keepOpen: true, onClick: () => { i--; draw(); } } : null,
      i < STEPS.length - 1
        ? { label: 'Далее', kind: 'primary', keepOpen: true, onClick: () => { i++; draw(); } }
        : { label: 'Готово', kind: 'primary', onClick: () => {} },
    ]);
    // Enter — к следующему полю, с последнего — к следующему шагу
    const inputs = [...body.querySelectorAll('input')];
    inputs.forEach((el, k) => el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const next = inputs[k + 1];
      if (next) next.focus();
      else if (i < STEPS.length - 1) { i++; draw(); } else m.close();
    }));
    if (after) after();
    else { const firstEmpty = inputs.find((el) => !el.value) || null; if (firstEmpty && window.matchMedia('(pointer: fine)').matches) firstEmpty.focus(); }
  }
  draw();
  return m.promise;
}

// Короткая сводка для вкладки «Памятки»: какие шаги заполнены
export function wizardSummary() {
  return h('div', { class: 'wz-summary' }, STEPS.map((st) => {
    const stt = stepStatus(st);
    return h('button', { class: 'wz-sum-row' + (stt.done ? ' ok' : st.optional ? ' opt' : ' need'), onClick: () => sessionWizard(st.id) },
      h('span', { class: 'wz-sum-ico' }, stt.done ? '✓' : st.optional ? '○' : '!'),
      h('span', { class: 'wz-sum-t' }, st.title),
      h('small', null, stt.done ? 'заполнено' : `не заполнено: ${stt.empty} ${plural(stt.empty, 'поле', 'поля', 'полей')}`),
    );
  }));
}
