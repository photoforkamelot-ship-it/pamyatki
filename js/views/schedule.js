// Сервисный график: зоны по функционалам (пара сотрудников в двух сменах), директор дополнительно,
// печать в двух формах — «Зоны ответственности» и ЯЧЧП «Порядок!» с блоками времени.
import { h, icon, uid, shortFio, surname, fmtDate } from '../util.js';
import { S, update, sessionLabel, SCHEDULE_BLOCKS } from '../store.js';
import { openModal, promptDlg, confirmDlg, menu, toast, withBusy, formDlg, toggle } from '../ui.js';
import { blocksToPdf, buildPrint } from '../pdf.js';
import { deliver } from '../output.js';
import { driveOn, sendToChat } from '../drive.js';
import { inTelegram } from '../tg.js';
import { tabSettingsDlg } from './settings.js';
import { fillResponsibility, fillYach } from '../xlsx.js';
import { getBytes, analyze, storeAnalyzed } from '../files.js';
import { pickFiles } from '../ui.js';

const BLOCK_SHORT = { morning: 'утро', day: 'день', evening: 'вечер' };

// Цвет функционала: кассир — зелёный, пекарь — жёлтый, приёмщик — голубой (только в приложении, не в печати)
const ROLE_COLORS = { 'кассир': '#34c759', 'пекарь': '#ffcc00', 'приёмщик': '#32ade6', 'приемщик': '#32ade6' };
const EXTRA = ['#af52de', '#ff9500', '#ff2d55', '#5856d6'];
export function roleColor(role) {
  const k = String(role || '').toLowerCase();
  if (ROLE_COLORS[k]) return ROLE_COLORS[k];
  const i = S.lists.roles.indexOf(role);
  return EXTRA[(i < 0 ? 0 : i) % EXTRA.length];
}
const rc = (role) => `--rc:${roleColor(role)}`;
// зона нескольких функционалов — градиент из их цветов
function zoneStyle(z) {
  const o = ownersOf(z.id);
  if (!o.length) return '';
  if (o.length === 1) return rc(o[0]);
  return `--rc:${roleColor(o[0])};--grad:linear-gradient(90deg,${o.map(roleColor).join(',')})`;
}

function sched() {
  const sid = S.session.id;
  if (!S.schedule.bySession[sid]) {
    // общие зоны (вход, закасса, сигареты, прикасса, касса, КМ) сразу закреплены за всеми
    const common = S.schedule.zones.filter((z) => z.common).map((z) => z.id);
    S.schedule.bySession[sid] = { assign: Object.fromEntries(S.lists.roles.map((r) => [r, common.slice()])), director: [] };
  }
  const b = S.schedule.bySession[sid];
  if (!b.director) b.director = [];
  if (!b.yachOwner) b.yachOwner = {};
  return b;
}
const zones = () => S.schedule.zones;
const zoneById = (id) => zones().find((z) => z.id === id);
const staffOf = (role) => S.session.staff.filter((p) => p.role === role && p.fio);
const ownersOf = (zid) => S.lists.roles.filter((r) => (sched().assign[r] || []).includes(zid));
const isShared = (z) => !!(z.shared || z.common);
const dirName = () => (S.session.manager.fio ? surname(S.session.manager.fio) : 'директор');
const withDir = (z) => z.name + (sched().director.includes(z.id) ? ` (${dirName()})` : '');

function shiftPerson(role, shift) {
  const people = staffOf(role);
  const exact = (n) => people.find((p) => String(p.shift) === String(n));
  const noShift = people.filter((p) => !p.shift);
  const first = exact(1) || noShift[0];
  if (shift === 1) return first;
  return exact(2) || noShift.find((p) => p !== first);
}

function label(p, view) {
  if (!p) return '';
  if (view === 'position') return p.position || p.role;
  if (view === 'both') return `${shortFio(p.fio)} (${p.position || p.role})`;
  return shortFio(p.fio);
}

function seg(options, value, onChange) {
  return h('div', { class: 'seg', role: 'group' }, options.map(([v, l]) => h('button', {
    class: 'seg-btn' + (v === value ? ' on' : ''), 'aria-pressed': v === value ? 'true' : 'false', onClick: () => onChange(v),
  }, l)));
}

export function renderSchedule(tab, root) {
  const zs = zones();
  const assigned = new Set(S.lists.roles.flatMap((r) => sched().assign[r] || []));
  const free = zs.filter((z) => !assigned.has(z.id));
  const unassignedStaff = S.session.staff.filter((p) => p.fio && !p.role);
  const groups = [...new Set(zs.map((z) => z.group || 'Без группы'))];

  root.append(
    h('div', { class: 'tab-head glass' },
      h('div', { class: 'tab-head-row' },
        h('div', null, h('h1', { class: 'tab-title' }, tab.title), h('p', { class: 'tab-sub' }, sessionLabel(S.session))),
        h('button', { class: 'icon-btn glass-btn', 'aria-label': 'Настройки вкладки', onClick: () => tabSettingsDlg(tab) }, icon('gear')),
      ),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn ghost sm', disabled: !zs.length, onClick: () => printResp() }, icon('print'), 'Зоны ответственности'),
        h('button', { class: 'btn ghost sm', disabled: !zs.length, onClick: () => printYach() }, icon('print'), 'ЯЧЧП'),
        h('button', { class: 'btn primary sm grow', disabled: !zs.length, onClick: () => printBoth() }, icon('print'), 'Оба'),
      ),
    ),

    // Распределение
    h('section', { class: 'card glass' },
      h('div', { class: 'card-head' }, h('h2', null, 'Распределение')),
      zs.length ? h('div', { class: 'status-line ' + (free.length ? 'warn' : 'ok') },
        free.length ? `Распределено ${zs.length - free.length} из ${zs.length}. Без ответственных: ${free.length}` : `Все ${zs.length} зон распределены`) : h('p', { class: 'empty' }, 'Сначала добавьте зоны ниже или загрузите стартовый пакет в настройках.'),
      free.length && zs.length ? h('details', { class: 'opt' }, h('summary', null, 'Какие зоны без ответственных'), h('div', { class: 'chips muted' }, free.map((z) => h('span', { class: 'chip static' }, z.name)))) : null,
      unassignedStaff.length ? h('p', { class: 'note warn' }, `Без функционала: ${unassignedStaff.map((p) => shortFio(p.fio)).join(', ')}. Укажите его во вводных на вкладке «Памятки».`) : null,
      !S.session.staff.length ? h('p', { class: 'note' }, 'Введите сотрудников во вводных на вкладке «Памятки»: ФИО, должность, функционал и смену. Пара одного функционала в двух сменах отвечает за одни и те же зоны.') : null,
      ...S.lists.roles.map((role) => roleBlock(role)),
      directorBlock(),
      zs.length ? h('div', { class: 'row-actions' }, h('button', { class: 'btn ghost sm', onClick: yachOwnersDlg }, 'Общие зоны в ЯЧЧП: кто в какое время')) : null,
    ),

    summaryCard(),

    // Зоны
    h('section', { class: 'card glass' },
      h('div', { class: 'card-head' }, h('h2', null, 'Зоны магазина', h('span', { class: 'pill' }, String(zs.length))),
        h('div', { class: 'card-actions' },
          h('button', { class: 'btn ghost sm', onClick: addZones }, icon('plus'), 'Списком'),
          h('button', { class: 'icon-btn', 'aria-label': 'Настройки времени ЯЧЧП', onClick: blocksDlg }, icon('gear')),
          h('button', { class: 'icon-btn', 'aria-label': 'Шаблоны Excel', onClick: () => menu('Шаблоны Excel', [
            { label: (tpls().resp ? 'Заменить' : 'Загрузить') + ' шаблон «Зоны ответственности»', onClick: () => uploadScheduleTpl('resp') },
            { label: (tpls().yach ? 'Заменить' : 'Загрузить') + ' шаблон ЯЧЧП', onClick: () => uploadScheduleTpl('yach') },
          ]) }, icon('file')),
        )),
      h('p', { class: 'cap' }, 'Одно название зоны печатается в обоих документах. Нажмите на зону, чтобы переименовать её, указать время в ЯЧЧП или сделать общей.'),
      ...groups.map((g) => h('div', { class: 'zone-group' },
        h('p', { class: 'cap strong' }, g),
        h('div', { class: 'chips' }, zs.filter((z) => (z.group || 'Без группы') === g).map((z) => h('button', { class: 'chip zchip' + (z.task ? ' task' : '') + (z.control ? ' ctrl' : '') + (ownersOf(z.id).length > 1 ? ' common' : ''), style: zoneStyle(z), onClick: () => editZone(z) },
          z.name, z.common ? h('small', { class: 'tag' }, 'всем') : z.shared ? h('small', { class: 'tag' }, 'общая') : null))),
      )),
    ),
  );
}

function roleBlock(role) {
  const people = staffOf(role);
  const mine = (sched().assign[role] || []).map(zoneById).filter(Boolean);
  return h('div', { class: 'role-block', style: rc(role) },
    h('div', { class: 'role-head' },
      h('span', { class: 'role-pill colored' }, role.toUpperCase()),
      h('div', { class: 'role-people' }, people.length
        ? people.map((p) => h('span', null, shortFio(p.fio), p.shift ? h('small', null, ' · смена ' + p.shift) : null))
        : h('span', { class: 'muted' }, 'нет сотрудников')),
      h('button', { class: 'btn ghost sm', disabled: !zones().length, onClick: () => assignDlg(role) }, mine.length ? `Зоны · ${mine.length}` : 'Назначить зоны'),
    ),
    people.length === 1 ? h('p', { class: 'cap' }, 'Второго сотрудника на этот функционал можно добавить во вводных.') : null,
    mine.length ? h('div', { class: 'chips small' }, mine.map((z) => h('span', { class: 'chip static zchip' + (ownersOf(z.id).length > 1 ? ' common' : ''), style: zoneStyle(z) }, withDir(z)))) : null,
  );
}

function directorBlock() {
  const mine = sched().director.map(zoneById).filter(Boolean);
  return h('div', { class: 'role-block' },
    h('div', { class: 'role-head' },
      h('span', { class: 'role-pill dir' }, 'ДИРЕКТОР'),
      h('div', { class: 'role-people' }, h('span', null, S.session.manager.fio ? shortFio(S.session.manager.fio) : 'управляющий не указан'), h('small', null, 'дополнительно к сотрудникам, в скобках')),
      h('button', { class: 'btn ghost sm', disabled: !zones().length, onClick: directorDlg }, mine.length ? `Зоны · ${mine.length}` : 'Добавить в зоны'),
    ),
    mine.length ? h('div', { class: 'chips small' }, mine.map((z) => h('span', { class: 'chip static' }, z.name))) : null,
  );
}

function zoneGrid(list, selected, role) {
  const groups = [...new Set(list.map((z) => z.group || 'Без группы'))];
  return h('div', null, groups.map((g) => h('div', { class: 'zone-group' },
    h('p', { class: 'cap strong' }, g),
    h('div', { class: 'zone-grid', style: role ? rc(role) : '--rc:#ff9500' }, list.filter((z) => (z.group || 'Без группы') === g).map((z) => {
      const id = 'z' + z.id + Math.random().toString(36).slice(2, 5);
      const cb = h('input', { type: 'checkbox', id, class: 'check' });
      cb.checked = selected.has(z.id);
      cb.addEventListener('change', () => (cb.checked ? selected.add(z.id) : selected.delete(z.id)));
      const others = ownersOf(z.id);
      const common = isShared(z) && others.length > 1;
      return h('label', { class: 'zone-cell' + (z.control ? ' ctrl' : '') + (isShared(z) ? ' common' : ''), for: id, style: common ? `--grad:linear-gradient(90deg,${others.map(roleColor).join(',')})` : null }, cb, h('span', { class: 'check-box', 'aria-hidden': 'true' }),
        h('span', null, z.name, others.length && isShared(z) ? h('small', null, ' · ' + others.join(', ')) : null));
    })),
  )));
}

function assignDlg(role) {
  const a = sched().assign;
  const mine = new Set(a[role] || []);
  // зоны, закреплённые за другими функционалами, скрыты — кроме общих
  const avail = zones().filter((z) => { const o = ownersOf(z.id); return !o.length || o.includes(role) || isShared(z); });
  const freeN = avail.filter((z) => !ownersOf(z.id).length).length;
  const people = staffOf(role).map((p) => shortFio(p.fio)).join(' и ');
  openModal({
    title: `Зоны: ${role}`, wide: true,
    body: h('div', null,
      h('p', { class: 'muted-p' }, (people ? people + '. ' : '') + `Свободных зон: ${freeN}. Закреплённые за другими скрыты, общие (КМ, ФРОВ, вход…) видны всем.`),
      avail.length ? zoneGrid(avail, mine, role) : h('p', { class: 'empty' }, 'Все зоны уже распределены.'),
    ),
    actions: [
      { label: 'Отмена', kind: 'ghost' },
      { label: 'Сохранить', kind: 'primary', onClick: () => update(() => { a[role] = zones().filter((z) => mine.has(z.id)).map((z) => z.id); }) },
    ],
  });
}

function directorDlg() {
  const b = sched();
  const sel = new Set(b.director);
  openModal({
    title: 'Директор дополнительно', wide: true,
    body: h('div', null, h('p', { class: 'muted-p' }, `Фамилия директора добавится в скобках к выбранным зонам: «ФРОВ (${dirName()})».`), zoneGrid(zones(), sel)),
    actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Сохранить', kind: 'primary', onClick: () => update(() => { b.director = zones().filter((z) => sel.has(z.id)).map((z) => z.id); }) }],
  });
}

async function addZones() {
  const text = await promptDlg('Добавить зоны', { label: 'По одной зоне на строку', multiline: true, placeholder: 'Торговый зал: вход\nКассовая зона\nСклад: приёмка' });
  if (!text) return;
  const names = text.split('\n').map((x) => x.trim()).filter(Boolean);
  update((s) => {
    const have = new Set(s.schedule.zones.map((z) => z.name.toLowerCase()));
    names.forEach((n) => { if (!have.has(n.toLowerCase())) s.schedule.zones.push({ id: uid(), name: n, group: 'Новые', task: false, control: false, blocks: ['day'], yach: true, resp: true, shared: false }); });
  });
}

async function editZone(z) {
  const groups = [...new Set(zones().map((x) => x.group).filter(Boolean))];
  const body = h('div', { class: 'form' });
  const name = h('input', { class: 'input', id: 'zn' }); name.value = z.name;
  const group = h('input', { class: 'input', id: 'zg', list: 'zgroups' }); group.value = z.group || '';
  const st = { ...z, blocks: [...(z.blocks || [])] };
  body.append(
    h('div', { class: 'field' }, h('label', { for: 'zn' }, 'Название (одно для обоих документов)'), name),
    h('div', { class: 'field' }, h('label', { for: 'zg' }, 'Группа'), group, h('datalist', { id: 'zgroups' }, groups.map((g) => h('option', { value: g })))),
    h('p', { class: 'cap' }, 'Время в ЯЧЧП'),
    h('div', { class: 'chips' }, S.schedule.blocks.map((b) => {
      const btn = h('button', { class: 'chip' + (st.blocks.includes(b.id) ? ' on' : ''), onClick: () => { st.blocks.includes(b.id) ? st.blocks.splice(st.blocks.indexOf(b.id), 1) : st.blocks.push(b.id); btn.classList.toggle('on'); } }, b.label.replace('Зоны с ', ''));
      return btn;
    })),
    toggle('Печатать в ЯЧЧП', st.yach !== false, (v) => (st.yach = v)),
    toggle('Печатать в «Зонах ответственности»', st.resp !== false, (v) => (st.resp = v)),
    toggle('Общая для всех', !!st.common, (v) => { st.common = v; }, 'Сразу закреплена за всеми функционалами (вход, закасса, КМ)'),
    toggle('Можно нескольким', !!st.shared, (v) => { st.shared = v; }, 'Видна всем при назначении (например, ФРОВ)'),
    toggle('Особый контроль', !!st.control, (v) => (st.control = v), 'Сроки годности, блочность — выделяется на печати'),
    toggle('Это задача, а не товарная зона', !!st.task, (v) => (st.task = v)),
  );
  openModal({
    title: 'Зона', body,
    actions: [
      { label: 'Удалить', kind: 'danger', onClick: async () => {
        if (!(await confirmDlg('Удалить зону?', z.name, 'Удалить', 'Отмена', true))) return false;
        update((s) => {
          s.schedule.zones = s.schedule.zones.filter((x) => x.id !== z.id);
          for (const b of Object.values(s.schedule.bySession)) { for (const r of Object.keys(b.assign)) b.assign[r] = b.assign[r].filter((id) => id !== z.id); if (b.director) b.director = b.director.filter((id) => id !== z.id); }
        });
      } },
      { label: 'Сохранить', kind: 'primary', onClick: () => update(() => { Object.assign(z, { ...st, name: name.value.trim() || z.name, group: group.value.trim() }); }) },
    ],
  });
}

function yachOwnersDlg() {
  const b = sched();
  const roles = S.lists.roles;
  const list = zones().filter((z) => z.yach !== false && ownersOf(z.id).length > 1);
  const body = h('div', { class: 'form' },
    h('p', { class: 'cap' }, 'Общие зоны закреплены за несколькими функционалами. Выберите, кто отвечает за каждую в своём блоке времени ЯЧЧП. «Все» — печатается «все».'),
    ...(list.length ? list.map((z) => h('div', { class: 'field' }, h('label', null, z.name),
      h('div', { class: 'grid-4' }, (z.blocks || []).map((bid) => {
        const blk = S.schedule.blocks.find((x) => x.id === bid);
        const sel = h('select', { class: 'input', 'aria-label': `${z.name}: ${blk ? blk.label : bid}` }, [h('option', { value: '' }, `${BLOCK_SHORT[bid] || bid}: все`), ...ownersOf(z.id).map((r) => h('option', { value: r, selected: (b.yachOwner[z.id] || {})[bid] === r }, `${BLOCK_SHORT[bid] || bid}: ${r}`))]);
        sel.addEventListener('change', () => update(() => { (b.yachOwner[z.id] = b.yachOwner[z.id] || {})[bid] = sel.value; }, { silent: true }));
        return sel;
      })))) : [h('p', { class: 'empty' }, 'Общих зон с несколькими ответственными пока нет.')]),
  );
  void roles;
  openModal({ title: 'ЯЧЧП: общие зоны', body, wide: true, actions: [{ label: 'Готово', kind: 'primary', onClick: () => update(() => {}) }] });
}

async function blocksDlg() {
  const fields = S.schedule.blocks.map((b) => ({ key: b.id, label: `Блок «${BLOCK_SHORT[b.id] || b.id}»`, value: b.label }));
  fields.push({ key: 'peak', label: 'Часы пик (в заголовке ЯЧЧП)', value: S.schedule.peak });
  fields.push({ key: 'rules', label: 'Что входит в зону (подпись ЯЧЧП)', value: S.schedule.rules, multiline: true });
  const v = await formDlg('ЯЧЧП: время и подписи', fields);
  if (!v) return;
  update((s) => { s.schedule.blocks.forEach((b) => { b.label = v[b.id] || b.label; }); s.schedule.peak = v.peak; s.schedule.rules = v.rules; });
}

// ---------- сводная таблица на экране ----------
function summaryData(view) {
  const roles = S.lists.roles;
  const a = sched().assign;
  return {
    head: ['', ...roles],
    rows: [
      ['Смена 1', ...roles.map((r) => label(shiftPerson(r, 1), view))],
      ['Смена 2', ...roles.map((r) => label(shiftPerson(r, 2), view))],
      ['Зоны', ...roles.map((r) => (a[r] || []).map(zoneById).filter(Boolean).map(withDir).join('\n'))],
    ],
  };
}

function summaryCard() {
  const view = S.schedule.view;
  const d = summaryData(view);
  return h('section', { class: 'card glass' },
    h('div', { class: 'card-head' }, h('h2', null, 'Сводная таблица'),
      h('div', { class: 'card-actions' }, h('button', { class: 'btn ghost sm', disabled: !yachRows().some((b) => b.rows.length), onClick: exportCsv }, 'ЯЧЧП в Excel'))),
    seg([['fio', 'ФИО'], ['position', 'Должности'], ['both', 'ФИО + должность']], view, (v) => update((s) => { s.schedule.view = v; })),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, d.head.map((c, i) => h('th', { class: i ? 'rc-head' : null, style: i ? rc(c) : null }, c)))),
      h('tbody', null, d.rows.map((r) => h('tr', null, r.map((c, i) => (i === 0 ? h('th', { scope: 'row' }, c) : h('td', { class: 'rc-cell', style: rc(S.lists.roles[i - 1]) + ';white-space:pre-line' }, c)))))),
    )),
    yachPreview(),
  );
}

// ЯЧЧП в приложении: фамилии и зоны в цвете функционала, общие — градиентом
function yachPreview() {
  const blocks = yachRows().filter((b) => b.rows.length);
  if (!blocks.length) return null;
  const roles = S.lists.roles;
  return h('details', { class: 'opt yach-prev' }, h('summary', null, 'ЯЧЧП — как распределено'),
    blocks.map((b) => h('div', { class: 'yach-block' }, h('p', { class: 'cap strong' }, b.label),
      h('div', { class: 'yach-rows' }, b.rows.map((r) => {
        const style = r.role >= 0 ? rc(roles[r.role]) : '';
        return h('div', { class: 'yach-row' + (r.common ? ' common-tag' : '') + (r.free ? ' free' : ''), style },
          h('span', { class: 'yz' }, r.zone), h('span', { class: 'yp' }, [...new Set([r.s1, r.s2].filter(Boolean))].join(' / ') || '—'));
      })))));
}

// ---------- печатные формы ----------
const GREY = '#d9d9d9';

function respBlocks() {
  const roles = S.lists.roles;
  const a = sched().assign;
  const zs = zones().filter((z) => z.resp !== false);
  const common = zs.filter((z) => roles.length > 1 && roles.every((r) => (a[r] || []).includes(z.id)));
  const cols = roles.map((r) => zs.filter((z) => (a[r] || []).includes(z.id) && !common.includes(z)));
  const n = Math.max(0, ...cols.map((c) => c.length));
  const cell = (z) => (z ? { t: withDir(z), fill: z.control ? GREY : null, size: 9.5 } : '');
  const rows = [
    roles.map((r) => ({ t: r, bold: true, align: 'center', fill: '#efefef' })),
    roles.map((r) => ({ t: label(shiftPerson(r, 1), 'fio') || '—', bold: true, align: 'center' })),
    roles.map((r) => ({ t: label(shiftPerson(r, 2), 'fio') || '—', bold: true, align: 'center' })),
    ...common.map((z) => roles.map(() => cell(z))),
  ];
  for (let i = 0; i < n; i++) rows.push(cols.map((c) => cell(c[i])));
  return [
    { t: 'center', text: 'Распределение зон индивидуальной ответственности между действующими сотрудниками', size: 12, bold: true, gap: 2 },
    { t: 'center', text: `${sessionLabel(S.session)} · ${fmtDate(new Date())}`, size: 9, color: '#555', gap: 8 },
    { t: 'xtable', cols: roles.map(() => 1), rows, headRows: 3, size: 9.5, pad: 3 },
    { t: 'xtable', cols: [0.05, 1], noBorder: true, rows: [[{ t: '', fill: GREY }, { t: 'выделенные цветом категории — зоны особого контроля с ограниченными сроками годности и нюансами выкладки (блочность)', size: 8.5, italic: true }]] },
    { t: 'sign', items: ['Управляющий магазином'] },
  ];
}

function yachRows() {
  const roles = S.lists.roles;
  return S.schedule.blocks.map((b) => {
    const list = zones().filter((z) => z.yach !== false && (z.blocks || []).includes(b.id));
    const rows = [];
    for (const z of list) {
      let owners = roles.filter((r) => (sched().assign[r] || []).includes(z.id));
      const pick = (sched().yachOwner[z.id] || {})[b.id];
      if (pick && owners.includes(pick)) owners = [pick];
      const nm = (r, sh) => { const p = shiftPerson(r, sh); return p ? surname(p.fio) : ''; };
      if (owners.length > 1) {
        // общая зона — отдельной строкой у каждого функционала, с пометкой
        for (const r of owners) rows.push({ s1: nm(r, 1), s2: nm(r, 2), zone: withDir(z) + ' (общая зона)', control: z.control, free: false, role: roles.indexOf(r), common: true });
        continue;
      }
      rows.push({ s1: owners.length ? nm(owners[0], 1) : '', s2: owners.length ? nm(owners[0], 2) : '', zone: withDir(z), control: z.control, free: !owners.length, role: owners.length === 1 ? roles.indexOf(owners[0]) : -1 });
    }
    return { label: b.label, rows };
  });
}

function yachBlocks() {
  const blocks = yachRows();
  const n = Math.max(0, ...blocks.map((b) => b.rows.length));
  const head1 = blocks.flatMap((b) => [{ t: b.label, bold: true, align: 'center', span: 3, fill: '#efefef', size: 8.5 }]);
  const head2 = blocks.flatMap(() => [{ t: '1 смена', bold: true, size: 7, align: 'center' }, { t: '2 смена', bold: true, size: 7, align: 'center' }, { t: 'Отдел', bold: true, size: 7, align: 'center' }]);
  const rows = [head1, head2];
  for (let i = 0; i < n; i++) {
    rows.push(blocks.flatMap((b) => {
      const r = b.rows[i];
      if (!r) return ['', '', ''];
      const fill = r.free ? '#fff2a8' : r.control ? GREY : null;
      return [{ t: r.s1, size: 6.8, fill }, { t: r.s2, size: 6.8, fill }, { t: r.zone, size: 6.8, fill }];
    }));
  }
  return [
    { t: 'xtable', noBorder: true, cols: [3, 1], rows: [[{ t: 'Памятка «Порядок!»', bold: true, size: 13 }, { t: S.schedule.peak || '', bold: true, size: 11, align: 'right' }]], gap: 0 },
    { t: 'left', text: `${sessionLabel(S.session)} · ${S.schedule.rules || ''}`, size: 8, color: '#444', gap: 4 },
    { t: 'xtable', cols: blocks.flatMap(() => [0.8, 0.8, 2.2]), rows, headRows: 2, size: 6.8, pad: 1.6 },
    { t: 'left', text: 'Жёлтым — зоны без ответственных, серым — зоны особого контроля.', size: 7.5, color: '#555' },
  ];
}

// ---------- Excel по вашим шаблонам ----------
const tpls = () => (S.schedule.templates = S.schedule.templates || {});

function respData() {
  const roles = S.lists.roles.slice(0, 3);
  const a = sched().assign;
  const zs = zones().filter((z) => z.resp !== false);
  const common = zs.filter((z) => roles.length > 1 && roles.every((r) => (a[r] || []).includes(z.id)));
  return {
    names: roles.map((r) => [shiftPerson(r, 1), shiftPerson(r, 2)].map((p) => (p ? p.fio.split(/\s+/).slice(0, 2).join(' ') : ''))),
    common: common.map(withDir),
    cols: roles.map((r) => zs.filter((z) => (a[r] || []).includes(z.id) && !common.includes(z)).map((z) => ({ t: withDir(z), control: z.control }))),
    all: zs.map((z) => z.name),
  };
}

async function makeXlsx(which) {
  const out = [];
  if (which !== 'yach' && tpls().resp) out.push({ name: 'Зоны ответственности', bytes: await fillResponsibility(await getBytes(tpls().resp), respData()) });
  if (which !== 'resp' && tpls().yach) {
    // в печатную форму идут только зоны с ответственными
    const blocks = yachRows().map((b) => ({ ...b, rows: b.rows.filter((r) => !r.free) }));
    out.push({ name: 'ЯЧЧП', bytes: await fillYach(await getBytes(tpls().yach), { blocks }) });
  }
  return out;
}

async function uploadScheduleTpl(key) {
  const [f] = await pickFiles({ accept: '.xlsx' });
  if (!f) return;
  const info = { original: new Uint8Array(await f.arrayBuffer()), pages: 0, text: '', name: f.name, kind: 'xlsx' };
  const meta = await withBusy('Сохраняю шаблон…', () => storeAnalyzed(info, { tabId: 'schedule' }));
  update(() => { tpls()[key] = meta; });
  toast('Шаблон сохранён');
}

async function makePdf(which) {
  const parts = [];
  if (which !== 'yach') {
    const { pngs, size } = await blocksToPdf(respBlocks(), { footer: 'Зоны ответственности · ' + sessionLabel(S.session) });
    parts.push({ title: 'Зоны ответственности', pngs, size, duplex: false });
  }
  if (which !== 'resp') {
    const { pngs, size } = await blocksToPdf(yachBlocks(), { landscape: true, footer: 'ЯЧЧП · ' + sessionLabel(S.session) });
    parts.push({ title: 'ЯЧЧП', pngs, size, duplex: false });
  }
  return buildPrint({ parts });
}

const check = () => {
  if (!S.session.staff.some((p) => p.fio && p.role)) toast('Во вводных нет сотрудников с функционалом — фамилии будут пустыми', 'warn');
};
async function printWhich(which, title) {
  check();
  try {
    const files = await withBusy('Заполняю ваш шаблон…', () => makeXlsx(which));
    const needPdf = (which === 'resp' && !tpls().resp) || (which === 'yach' && !tpls().yach) || (which === 'both' && !files.length);
    if (needPdf) { const b = await withBusy('Собираю…', () => makePdf(which)); return deliver(b, `${title} — ${sessionLabel(S.session)}`, { note: 'Шаблон Excel не загружен — это упрощённая версия.' }); }
    if (files.length === 1) return deliver(files[0].bytes, `${files[0].name} — ${sessionLabel(S.session)}`, { excel: true });
    const JSZip = window.JSZip;
    const zip = new JSZip();
    files.forEach((f) => zip.file(`${f.name} — ${sessionLabel(S.session)}.xlsx`, f.bytes));
    deliver(await zip.generateAsync({ type: 'uint8array' }), `${title} — ${sessionLabel(S.session)}`, { zip: true, note: 'В архиве два файла Excel в ваших формах.' });
  } catch (e) { console.error(e); toast('Ошибка: ' + e.message, 'warn'); }
}
const printResp = () => printWhich('resp', 'Зоны ответственности');
const printYach = () => printWhich('yach', 'ЯЧЧП');
const printBoth = () => printWhich('both', 'Сервисный график');

async function exportCsv() {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Время', '1 смена Фамилия', '2 смена Фамилия', 'Отдел']];
  for (const b of yachRows()) for (const r of b.rows) lines.push([b.label, r.s1, r.s2, r.zone]);
  const csv = '﻿' + lines.map((r) => r.map(esc).join(';')).join('\r\n');
  const bytes = new TextEncoder().encode(csv);
  const name = `ЯЧЧП — ${sessionLabel(S.session)}.csv`;
  if (inTelegram && driveOn()) {
    try { await withBusy('Отправляю в чат…', () => sendToChat(bytes, name, 'ЯЧЧП')); toast('Файл отправлен в чат'); return; } catch (e) { toast(e.message, 'warn'); }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'text/csv' }));
  const link = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
