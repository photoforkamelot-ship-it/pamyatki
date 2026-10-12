// Опорный план: разделы → темы → подпункты, отметки «изучено с директором» по каждому магазину.
import { h, icon, uid, fmtDate } from '../util.js';
import { S, update, sessionLabel } from '../store.js';
import { promptDlg, confirmDlg, menu, withBusy, formDlg } from '../ui.js';
import { blocksToPdf, buildPrint } from '../pdf.js';
import { deliver } from '../output.js';
import { tabSettingsDlg } from './settings.js';

let editMode = false;
const collapsed = new Set();

function doneSet() {
  const sid = S.session.id;
  if (!S.plan.done[sid]) S.plan.done[sid] = {};
  return S.plan.done[sid];
}

function flatten(items, level = 0, out = [], parent = null) {
  for (const it of items) {
    out.push({ it, level, parent });
    if (!collapsed.has(it.id)) flatten(it.children || [], level + 1, out, it);
  }
  return out;
}
function all(items, out = []) { for (const it of items) { out.push(it); all(it.children || [], out); } return out; }
const leaves = (it) => (it.children && it.children.length ? all(it.children).filter((d) => !d.divider && (!d.children || !d.children.length)) : it.divider ? [] : [it]);

function stateOf(it, done) {
  const ls = leaves(it);
  if (!ls.length) return 'none';
  const n = ls.filter((l) => done[l.id]).length;
  return n === 0 ? 'none' : n === ls.length ? 'all' : 'some';
}

export function renderPlan(tab, root) {
  const done = doneSet();
  const flat = flatten(S.plan.items);
  const allLeaves = all(S.plan.items).filter((x) => !x.divider && (!x.children || !x.children.length));
  const doneCount = allLeaves.filter((l) => done[l.id]).length;
  const pct = allLeaves.length ? Math.round((doneCount / allLeaves.length) * 100) : 0;
  const topics = all(S.plan.items).filter((x) => x.meta);

  root.append(
    h('div', { class: 'tab-head glass' },
      h('div', { class: 'tab-head-row' },
        h('div', null, h('h1', { class: 'tab-title' }, tab.title), h('p', { class: 'tab-sub' }, `${sessionLabel(S.session)} · изучено ${doneCount} из ${allLeaves.length}${topics.length ? ` · тем ${topics.length}` : ''}`)),
        h('button', { class: 'icon-btn glass-btn', 'aria-label': 'Настройки вкладки', onClick: () => tabSettingsDlg(tab) }, icon('gear')),
      ),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span', { style: { width: pct + '%' } })),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn ghost sm' + (editMode ? ' on' : ''), 'aria-pressed': editMode ? 'true' : 'false', onClick: () => { editMode = !editMode; update(() => {}); } }, icon('pencil'), editMode ? 'Готово' : 'Править'),
        h('button', { class: 'btn ghost sm', onClick: () => { const tops = all(S.plan.items).filter((x) => x.children && x.children.length && x.meta); const any = tops.some((x) => !collapsed.has(x.id)); tops.forEach((x) => (any ? collapsed.add(x.id) : collapsed.delete(x.id))); update(() => {}); } }, 'Свернуть / развернуть'),
        h('button', { class: 'btn ghost sm', onClick: importOutline }, 'Вставить списком'),
        h('button', { class: 'btn primary sm grow', disabled: !flat.length, onClick: printPlan }, icon('print'), 'PDF'),
      ),
    ),
    h('section', { class: 'card glass' },
      flat.length ? h('div', { class: 'tree' }, flat.map((x, idx) => row(x, idx, flat, done))) : h('p', { class: 'empty' }, 'План пуст. Загрузите стартовый пакет в настройках или вставьте план списком.'),
      editMode ? h('button', { class: 'btn ghost dashed', onClick: () => addItem(S.plan.items) }, icon('plus'), 'Раздел') : null,
    ),
  );
}

function row({ it, level, parent }, idx, flat, done) {
  if (it.divider) {
    return h('div', { class: 'tree-divider', style: { paddingLeft: 6 + level * 18 + 'px' } }, it.title,
      editMode ? h('button', { class: 'icon-btn', 'aria-label': 'Действия', onClick: () => itemMenu(it, parent) }, icon('more')) : null);
  }
  const st = stateOf(it, done);
  const id = 'pl' + it.id;
  const cb = h('input', { type: 'checkbox', id, class: 'check' });
  cb.checked = st === 'all';
  cb.indeterminate = st === 'some';
  cb.addEventListener('change', () => update(() => {
    for (const l of leaves(it)) { if (cb.checked) done[l.id] = new Date().toISOString(); else delete done[l.id]; }
  }));
  const hasKids = it.children && it.children.length;
  const when = !hasKids && done[it.id] ? fmtDate(done[it.id]) : '';
  const m = it.meta;
  const metaLine = m ? [m.num ? '№ ' + m.num : '', m.when, m.printed, m.video].filter(Boolean).join(' · ') : '';
  return h('div', { class: 'tree-row lvl' + Math.min(level, 3) + (hasKids ? ' parent' : '') + (st === 'all' ? ' done' : '') + (m ? ' topic' : ''), style: { paddingLeft: 6 + level * 18 + 'px' } },
    h('label', { class: 'check-wrap', for: id }, cb, h('span', { class: 'check-box', 'aria-hidden': 'true' })),
    h('label', { for: id, class: 'tree-text' }, it.title, metaLine ? h('small', { class: 'meta' }, metaLine) : null, when ? h('small', null, 'изучено ' + when) : null),
    hasKids && level > 0 ? h('button', { class: 'chain-btn', 'aria-label': collapsed.has(it.id) ? 'Развернуть' : 'Свернуть', onClick: () => { collapsed.has(it.id) ? collapsed.delete(it.id) : collapsed.add(it.id); update(() => {}); } }, collapsed.has(it.id) ? '▸' : '▾') : null,
    !editMode && !hasKids ? h('button', { class: 'chain-btn', title: 'Отметить всё до этого пункта', 'aria-label': 'Отметить всё до этого пункта', onClick: () => markUpTo(idx, flat, done) }, '↧') : null,
    editMode ? h('button', { class: 'icon-btn', 'aria-label': 'Действия', onClick: () => itemMenu(it, parent) }, icon('more')) : null,
  );
}

function markUpTo(idx, flat, done) {
  update(() => {
    flat.slice(0, idx + 1).forEach(({ it }) => { if (!it.divider && (!it.children || !it.children.length)) done[it.id] = done[it.id] || new Date().toISOString(); });
  });
}

async function addItem(list) {
  const t = await promptDlg('Новый пункт', { label: 'Название' });
  if (t) update(() => { list.push({ id: uid(), title: t, children: [] }); });
}

function itemMenu(it, parent) {
  const siblings = parent ? parent.children : S.plan.items;
  menu(it.title, [
    { label: 'Переименовать', onClick: async () => { const t = await promptDlg('Пункт', { value: it.title, multiline: it.title.length > 60 }); if (t) update(() => { it.title = t; }); } },
    it.meta ? { label: 'Материалы и срок', onClick: async () => {
      const v = await formDlg('Тема', [{ key: 'num', label: '№', value: it.meta.num }, { key: 'printed', label: 'Печатные материалы', value: it.meta.printed }, { key: 'video', label: 'Видеоматериал', value: it.meta.video }, { key: 'when', label: 'Когда', value: it.meta.when }]);
      if (v) update(() => { Object.assign(it.meta, v); });
    } } : { label: 'Сделать темой (материалы, срок)', onClick: () => update(() => { it.meta = { num: '', printed: '', video: '', when: '' }; }) },
    { label: 'Добавить подпункт', onClick: () => addItem(it.children = it.children || []) },
    { label: 'Выше', onClick: () => update(() => { const i = siblings.indexOf(it); if (i > 0) [siblings[i - 1], siblings[i]] = [siblings[i], siblings[i - 1]]; }) },
    { label: 'Ниже', onClick: () => update(() => { const i = siblings.indexOf(it); if (i < siblings.length - 1) [siblings[i + 1], siblings[i]] = [siblings[i], siblings[i + 1]]; }) },
    { label: 'Удалить', danger: true, onClick: async () => {
      if (await confirmDlg('Удалить пункт?', it.title + (it.children && it.children.length ? ' и все подпункты' : ''), 'Удалить', 'Отмена', true)) update(() => { siblings.splice(siblings.indexOf(it), 1); });
    } },
  ]);
}

// Разбор списка: отступы (2 пробела / таб), «-», или нумерация 1.2.3
export function parseOutline(text) {
  const root = [];
  const stack = [{ level: -1, children: root }];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    const indent = raw.replace(/\t/g, '    ').match(/^ */)[0].length;
    let line = raw.trim();
    let level = Math.floor(indent / 2);
    const num = line.match(/^(\d+(?:\.\d+)*)[.)]?\s+/);
    if (num) { level = num[1].split('.').filter(Boolean).length - 1; }
    else if (/^[-–•*]\s+/.test(line)) { line = line.replace(/^[-–•*]\s+/, ''); level = Math.max(level, 1); }
    const node = { id: uid(), title: line, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push({ level, children: node.children });
  }
  return root;
}

async function importOutline() {
  const text = await promptDlg('Вставить план списком', { multiline: true, label: 'Каждый пункт с новой строки. Подпункты — с отступом, через «-» или с номером 1.1', placeholder: '1. Касса\n1.1 Открытие смены\n1.2 Инкассация\n2. Склад\n- Приёмка' });
  if (!text) return;
  const items = parseOutline(text);
  if (S.plan.items.length && !(await confirmDlg('Заменить текущий план?', 'Отметки «изучено» у старых пунктов пропадут. «Нет» — добавить в конец.', 'Заменить', 'Нет'))) {
    update(() => { S.plan.items.push(...items); });
    return;
  }
  update(() => { S.plan.items = items; });
}

async function printPlan() {
  const done = doneSet();
  const mark = (it) => (stateOf(it, done) === 'all' ? '✓ ' + (fmtDate(leaves(it).map((l) => done[l.id]).sort().pop()) || '') : stateOf(it, done) === 'some' ? 'частично' : '');
  const rows = [[
    { t: '№', bold: true, align: 'center', fill: '#efefef' }, { t: 'Тема обучения', bold: true, fill: '#efefef' }, { t: 'Материалы', bold: true, fill: '#efefef' },
    { t: 'Практическая работа', bold: true, fill: '#efefef' }, { t: 'Срок', bold: true, fill: '#efefef' }, { t: 'Изучено', bold: true, align: 'center', fill: '#efefef' },
  ]];
  const walk = (items, level) => {
    for (const it of items) {
      if (it.divider) { rows.push([{ t: it.title, span: 6, italic: true, align: 'center', fill: '#f6f6f6', size: 8.5 }]); continue; }
      if (it.meta) {
        const sub = (it.children || []).map((c) => (done[c.id] ? '☑ ' : '☐ ') + c.title).join('\n');
        rows.push([{ t: it.meta.num || '', align: 'center' }, { t: it.title, bold: true }, [it.meta.printed, it.meta.video].filter(Boolean).join('; '), { t: sub, size: 7.5 }, { t: it.meta.when || '', size: 8 }, { t: mark(it), align: 'center', size: 8 }]);
      } else if (it.children && it.children.length && level === 0) {
        rows.push([{ t: it.title, span: 6, bold: true, fill: '#e8e8e8' }]);
        walk(it.children, level + 1);
      } else {
        rows.push(['', { t: it.title, bold: level === 0 }, '', { t: (it.children || []).map((c) => (done[c.id] ? '☑ ' : '☐ ') + c.title).join('\n'), size: 7.5 }, '', { t: mark(it), align: 'center', size: 8 }]);
      }
    }
  };
  walk(S.plan.items, 0);
  const blocks = [
    { t: 'center', text: 'Опорный план', size: 15, bold: true, gap: 0 },
    { t: 'center', text: `${sessionLabel(S.session)} · ${fmtDate(new Date())}`, size: 9, color: '#555', gap: 8 },
    { t: 'xtable', cols: [0.35, 1.7, 1.2, 3.2, 1, 0.8], rows, headRows: 1, size: 8.5, pad: 3 },
    { t: 'sign', items: ['Управляющий магазином', 'Наставник'] },
  ];
  const bytes = await withBusy('Собираю PDF…', async () => {
    const { pngs, size } = await blocksToPdf(blocks, { landscape: true, footer: 'Опорный план · ' + sessionLabel(S.session) });
    return buildPrint({ parts: [{ title: 'Опорный план', pngs, size, duplex: false }] });
  });
  deliver(bytes, `Опорный план — ${sessionLabel(S.session)}`);
}
