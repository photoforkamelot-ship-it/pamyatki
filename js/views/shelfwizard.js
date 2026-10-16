// Мастер делений: высоты → усиление → правки делений (карусель) → выбор и печать.
// Правки сохраняются в версию региона сеанса (УФО/ЦФО/СФО); пока правок нет — общий шаблон.
import { h, icon, clone, plural } from '../util.js';
import { S, update, emit } from '../store.js';
import { openModal, toast, choiceDlg } from '../ui.js';
import { effVariants, printShelves } from './shelves.js';

const cur = () => S.shelves.current;
const pick = (id) => cur().items[id] || (cur().items[id] = { v: 0, width: '', reinforced: false, on: true });
const cat = () => S.shelves.groupsOrder.flatMap((g) => S.shelves.catalog.filter((it) => it.group === g));
const hasNums = (it) => effVariants(it).some((v) => Object.keys(v.levels || {}).length);
const twoHeights = (it) => effVariants(it).length > 1 && hasNums(it);
const rackLike = (it) => ['rack', 'super'].includes(it.kind) && hasNums(it);
const low = (x) => String(x || '').toLowerCase();

// Список с галочками и поиском
function checklist(items, selected, { sub } = {}) {
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Поиск категории' });
  const list = h('div', { class: 'sw-list' });
  const count = h('small', { class: 'cap' });
  const draw = () => {
    list.innerHTML = '';
    const f = low(q.value);
    for (const it of items.filter((x) => !f || low(x.name + ' ' + (x.sub || '')).includes(f))) {
      const on = selected.has(it.id);
      list.append(h('button', { class: 'sw-item' + (on ? ' on' : ''), onClick: () => { on ? selected.delete(it.id) : selected.add(it.id); draw(); } },
        h('span', { class: 'sw-check' }, on ? '✓' : ''), h('span', null, it.name, it.sub ? ` (${it.sub})` : '', sub ? h('small', null, sub(it)) : null)));
    }
    count.textContent = `Отмечено: ${selected.size} из ${items.length}`;
  };
  q.addEventListener('input', draw);
  draw();
  return h('div', { class: 'sw-wrap' }, q,
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn ghost sm', onClick: () => { items.forEach((x) => selected.add(x.id)); draw(); } }, 'Все'),
      h('button', { class: 'btn ghost sm', onClick: () => { selected.clear(); draw(); } }, 'Ничего'),
      count),
    list);
}

// Сохранение делений одной категории — в версию региона (или в общий шаблон без региона)
function saveLevels(it, vi, levels) {
  const region = S.session.region;
  update((st) => {
    if (region) {
      st.shelves.regional = st.shelves.regional || {};
      const r = st.shelves.regional[region] = st.shelves.regional[region] || {};
      const vs = clone(r[it.id] || it.variants);
      vs[vi] = { ...vs[vi], levels };
      r[it.id] = vs;
    } else {
      const t = st.shelves.catalog.find((x) => x.id === it.id);
      t.variants[vi] = { ...t.variants[vi], levels };
    }
  }, { silent: true });
}

// Карусель правки делений: по одной категории
function carousel(box, items, done) {
  let k = 0;
  const draw = () => {
    const it = items[k];
    const p = pick(it.id);
    const vs = clone(effVariants(it));
    let vi = Math.min(p.v || 0, vs.length - 1);
    const body = h('div', { class: 'sw-car' });
    const fill = () => {
      body.innerHTML = '';
      const lv = { ...(vs[vi].levels || {}) };
      const top = Math.max(7, ...Object.keys(lv).map(Number));
      const inputs = {};
      const grid = h('div', { class: 'sw-levels' });
      // снизу вверх: «Делений между 1 и 2 полкой», «между 2 и 3»…
      for (let n = 1; n <= top; n++) {
        const inp = h('input', { class: 'input', placeholder: '—', enterkeyhint: 'next', autocomplete: 'off' });
        inp.value = lv[String(n)] || '';
        inputs[n] = inp;
        grid.append(h('label', { class: 'sw-lv' }, h('span', null, `Делений между ${n} и ${n + 1} полкой`), inp));
      }
      const ins = Object.values(inputs);
      ins.forEach((el, i) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); (ins[i + 1] || ins[i]).focus(); } }));
      body.append(
        vs.length > 1 ? h('div', { class: 'seg' }, vs.map((v, i) => h('button', { class: 'seg-btn' + (i === vi ? ' on' : ''), onClick: () => { vi = i; fill(); } }, v.label))) : null,
        h('p', { class: 'cap' }, 'Заполняйте снизу вверх, Enter — к следующей. Можно писать текст: «подтоварка», «2(ср.угол)».'),
        grid,
        h('button', { class: 'btn ghost sm', onClick: () => { lv[String(top + 1)] = ''; vs[vi] = { ...vs[vi], levels: { ...collect(), [String(top + 1)]: '' } }; fill(); } }, icon('plus'), 'Ещё ряд сверху'),
      );
      body._collect = collect;
      function collect() { const o = {}; for (const [n, el] of Object.entries(inputs)) if (el.value.trim()) o[n] = el.value.trim(); return o; }
    };
    fill();
    box.innerHTML = '';
    box.append(h('div', { class: 'sw-car-head' }, h('span', { class: 'pill' }, `${k + 1} из ${items.length}`), h('h3', null, it.name)), body);
    box._actions([
      { label: k ? 'Предыдущая' : 'Назад', kind: 'ghost', keepOpen: true, onClick: () => { if (k) { k--; draw(); } else done(false); } },
      { label: k < items.length - 1 ? 'Сохранить и дальше' : 'Сохранить', kind: 'primary', keepOpen: true, onClick: () => {
        saveLevels(it, vi, body._collect());
        update(() => { pick(it.id).v = vi; }, { silent: true });
        if (k < items.length - 1) { k++; draw(); } else done(true);
      } },
    ]);
  };
  draw();
}

export function shelvesWizard() {
  const items = cat();
  const box = h('div', { class: 'wizard sw' });
  const m = openModal({ title: 'Мастер делений', body: box, wide: true, onClose: () => emit() });
  box._actions = m.setActions;
  const region = S.session.region;

  // 1. Высоты
  let markHigh = true;
  const hh = items.filter(twoHeights);
  const highSel = new Set(hh.filter((it) => (pick(it.id).v || 0) === 0).map((it) => it.id));
  function step1() {
    box.innerHTML = '';
    const sel = markHigh ? highSel : new Set(hh.filter((it) => !highSel.has(it.id)).map((it) => it.id));
    box.append(
      h('h3', { class: 'wz-title' }, '1. Высота стеллажей'),
      h('div', { class: 'seg' }, [[true, 'Отмечаю высокие 2,20'], [false, 'Отмечаю низкие 1,80']].map(([v, l]) => h('button', { class: 'seg-btn' + (markHigh === v ? ' on' : ''), onClick: () => { syncFrom(sel); markHigh = v; step1(); } }, l))),
      h('p', { class: 'cap' }, markHigh ? 'Остальные автоматически станут 1,80 (суперструктуры — стеллажом).' : 'Остальные автоматически станут 2,20 (суперструктурой).'),
      checklist(hh, sel, { sub: (it) => effVariants(it).map((v) => v.label).join(' / ') }),
    );
    m.setActions([{ label: 'Далее', kind: 'primary', keepOpen: true, onClick: () => { syncFrom(sel); step2(); } }]);
    function syncFrom(set) {
      highSel.clear();
      hh.forEach((it) => { const marked = set.has(it.id); if (marked === markHigh) highSel.add(it.id); });
    }
  }

  // 2. Усиление
  const racks = items.filter(rackLike);
  const reinf = new Set(racks.filter((it) => pick(it.id).reinforced).map((it) => it.id));
  function step2() {
    update(() => { hh.forEach((it) => { pick(it.id).v = highSel.has(it.id) ? 0 : 1; }); }, { silent: true });
    box.innerHTML = '';
    box.append(h('h3', { class: 'wz-title' }, '2. Усиленные стеллажи'), h('p', { class: 'cap' }, 'Отметьте усиленные (+1 деление). Остальные — обычные.'), checklist(racks, reinf));
    m.setActions([
      { label: 'Назад', kind: 'ghost', keepOpen: true, onClick: step1 },
      { label: 'Далее', kind: 'primary', keepOpen: true, onClick: () => { update(() => { racks.forEach((it) => { pick(it.id).reinforced = reinf.has(it.id); }); }, { silent: true }); step3(); } },
    ]);
  }

  // 3. Правки делений
  const toEdit = [];
  function step3() {
    box.innerHTML = '';
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Начните вводить название категории' });
    const sugg = h('div', { class: 'sw-sugg' });
    const chosen = h('div', { class: 'chips' });
    const drawChosen = () => { chosen.innerHTML = ''; toEdit.forEach((it, i) => chosen.append(h('button', { class: 'chip on', onClick: () => { toEdit.splice(i, 1); drawChosen(); } }, it.name, ' ✕'))); m.setActions(actions()); };
    q.addEventListener('input', () => {
      sugg.innerHTML = '';
      const f = low(q.value);
      if (!f) return;
      items.filter((it) => hasNums(it) && low(it.name + ' ' + (it.sub || '')).includes(f) && !toEdit.includes(it)).slice(0, 8)
        .forEach((it) => sugg.append(h('button', { class: 'sw-item', onClick: () => { toEdit.push(it); q.value = ''; sugg.innerHTML = ''; drawChosen(); q.focus(); } }, h('span', { class: 'sw-check' }, '+'), it.name)));
    });
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const b = sugg.querySelector('button'); if (b) b.click(); } });
    box.append(
      h('h3', { class: 'wz-title' }, '3. Есть изменения в делениях?'),
      h('p', { class: 'cap' }, region ? `Правки сохранятся в версию ${region}; общий шаблон не изменится.` : 'Регион не выбран — правки попадут в общий шаблон.'),
      q, sugg, chosen,
    );
    const actions = () => [
      { label: 'Назад', kind: 'ghost', keepOpen: true, onClick: step2 },
      { label: 'Нет изменений', kind: 'ghost', keepOpen: true, onClick: step4 },
      toEdit.length ? { label: `Править: ${toEdit.length}`, kind: 'primary', keepOpen: true, onClick: () => carousel(box, toEdit, (saved) => { if (saved) toast(`Сохранено: ${toEdit.length} ${plural(toEdit.length, 'категория', 'категории', 'категорий')}`); step4(); }) } : null,
    ];
    m.setActions(actions());
    setTimeout(() => q.focus(), 50);
  }

  // 4. Выбор и печать
  function step4() {
    const sel = new Set(items.filter((it) => pick(it.id).on !== false).map((it) => it.id));
    box.innerHTML = '';
    box.append(
      h('h3', { class: 'wz-title' }, '4. Что печатаем'),
      h('p', { class: 'cap' }, 'Все категории магазина или только нужные.'),
      checklist(items, sel, { sub: (it) => { const p = pick(it.id); const v = effVariants(it)[p.v || 0]; return [v && effVariants(it).length > 1 ? v.label : '', p.reinforced ? 'усиленный' : ''].filter(Boolean).join(' · '); } }),
    );
    m.setActions([
      { label: 'Назад', kind: 'ghost', keepOpen: true, onClick: step3 },
      { label: 'Сохранить без печати', kind: 'ghost', onClick: () => apply(sel) },
      { label: 'Печать', kind: 'primary', onClick: () => { apply(sel); setTimeout(printShelves, 200); } },
    ]);
  }
  function apply(sel) { update(() => { items.forEach((it) => { pick(it.id).on = sel.has(it.id); }); }); }

  step1();
  return m.promise;
}

// Двойной тап по категории: что поменять
export async function editOneShelf(it) {
  const p = pick(it.id);
  const vs = effVariants(it);
  const v = await choiceDlg(`Изменить «${it.name}»?`, 'Высота и усиление — только для этого магазина. Деления — в версию региона.', [
    vs.length > 1 ? { label: `Высота: сейчас ${vs[p.v || 0].label}`, value: 'h' } : null,
    rackLike(it) ? { label: p.reinforced ? 'Сделать обычным' : 'Сделать усиленным (+1)', value: 'r' } : null,
    hasNums(it) ? { label: 'Изменить деления', value: 'd', kind: 'primary' } : null,
  ].filter(Boolean));
  if (v === 'h') update(() => { p.v = (p.v || 0) ? 0 : 1; p.on = true; });
  if (v === 'r') update(() => { p.reinforced = !p.reinforced; p.on = true; });
  if (v === 'd') {
    const box = h('div', { class: 'wizard sw' });
    const m = openModal({ title: 'Деления', body: box, wide: true, onClose: () => emit() });
    box._actions = m.setActions;
    carousel(box, [it], () => m.close());
  }
}
