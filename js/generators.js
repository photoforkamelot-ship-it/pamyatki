// Листы, которые собираются из вводных сеанса. Вёрстка повторяет образцы пользователя.
import { S, sessionLabel } from './store.js';
import { shortFio, money, fmtDate } from './util.js';

// ---------- помощники ----------
const up = (s) => String(s || '').toLocaleUpperCase('ru-RU');

export function contact(listKey, name) {
  return (S.lists[listKey] || []).find((x) => x.name === name) || null;
}

function cityLine(s) {
  const a = (s.address || '').trim();
  if (!s.city) return a;
  if (/^г\.?\s/i.test(a) || a.toLowerCase().includes(s.city.toLowerCase())) return a;
  return `г. ${s.city}, ${a}`.replace(/,\s*$/, '');
}

// Имя в дательном падеже: «Иванова Анна» → «Ивановой Анне». Можно переопределить в карточке контакта.
export function dative(fio) {
  const parts = String(fio || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const [sur, name = '', pat = ''] = parts;
  const female = /[ая]$/i.test(name) || /(ова|ева|ина|ына|ская|цкая)$/i.test(sur);
  const fixSur = (w) => {
    if (female) {
      if (/(ова|ева|ёва|ина|ына)$/i.test(w)) return w.slice(0, -1) + 'ой';
      if (/(ская|цкая|ая)$/i.test(w)) return w.slice(0, -2) + 'ой';
      return w;
    }
    if (/(ов|ев|ин|ын)$/i.test(w)) return w + 'у';
    if (/(их|ых|ко)$/i.test(w)) return w;
    if (/(ский|цкий|ий|ый|ой)$/i.test(w)) return w.slice(0, -2) + 'ому';
    if (/[бвгджзклмнпрстфхцчшщ]$/i.test(w)) return w + 'у';
    return w;
  };
  const fixName = (w) => {
    if (!w) return w;
    if (/ия$/i.test(w)) return w.slice(0, -1) + 'и';
    if (/[ая]$/i.test(w)) return w.slice(0, -1) + 'е';
    if (/ь$/i.test(w)) return female ? w.slice(0, -1) + 'и' : w.slice(0, -1) + 'ю';
    if (/й$/i.test(w)) return w.slice(0, -1) + 'ю';
    if (/[бвгджзклмнпрстфхцчшщ]$/i.test(w)) return w + 'у';
    return w;
  };
  const fixPat = (w) => (!w ? w : /на$/i.test(w) ? w.slice(0, -1) + 'е' : /ич$/i.test(w) ? w + 'у' : w);
  return [fixSur(sur), fixName(name), fixPat(pat)].filter(Boolean).join(' ');
}

// «От кого»: фамилия в родительном падеже + инициалы: «Чепкасова Анна Викторовна» → «Чепкасовой А.В.»
export function genitive(fio) {
  const parts = String(fio || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const [sur, name = '', pat = ''] = parts;
  const female = /вна$/i.test(pat) || (!pat && /[ая]$/i.test(name)) || (!name && /(ова|ева|ёва|ина|ына|ская|цкая|ая)$/i.test(sur));
  let g = sur;
  if (female) {
    if (/(ова|ева|ёва|ина|ына)$/i.test(sur)) g = sur.slice(0, -1) + 'ой';
    else if (/(ская|цкая|ая)$/i.test(sur)) g = sur.slice(0, -2) + 'ой';
  } else if (!/(их|ых|ко|[еиоуэюы])$/i.test(sur)) {
    if (/(ский|цкий|ий|ый|ой)$/i.test(sur)) g = sur.slice(0, -2) + 'ого';
    else if (/[ьй]$/i.test(sur)) g = sur.slice(0, -1) + 'я';
    else if (/[бвгджзклмнпрстфхцчшщ]$/i.test(sur)) g = sur + 'а';
  }
  const ini = [name, pat].filter(Boolean).map((w) => w[0].toUpperCase() + '.').join('');
  return [g, ini].filter(Boolean).join(' ');
}

function sender(s) {
  const lines = [];
  if (s.manager.fio) lines.push('ОТ ' + up(genitive(s.manager.fio)));
  if (s.manager.phone) lines.push('ТЕЛ.:' + s.manager.phone);
  return lines;
}

// Надпись на конверт: шапка ОСП, крупный адресат, отправитель
function envelope(s, kindWords, c, fallbackAddr) {
  const who = c ? (c.dative || dative(c.name)) : '______________________';
  const addr = c && c.address ? c.address : fallbackAddr || '';
  const big = [...kindWords, ...up(who).split(/\s+/)].filter(Boolean);
  return [
    { t: 'center', text: 'ОСП ' + up(s.osp || '____'), size: 15, italic: true, gap: 0 },
    { t: 'center', text: up(cityLine(s)) || '______________________', size: 13, italic: true, gap: 34 },
    ...big.map((w, i) => ({ t: 'center', text: w, size: 40, bold: true, underline: true, gap: i === big.length - 1 ? 14 : 0, lh: 1.42 })),
    ...up(addr).split('\n').filter(Boolean).map((l) => ({ t: 'center', text: l, size: 22, bold: true, gap: 0 })),
    { t: 'gap', h: 50 },
    ...sender(s).map((l) => ({ t: 'center', text: l, size: 16, italic: true, gap: 0 })),
  ];
}

function withPageBreaks(list) {
  const out = [];
  list.forEach((blocks, i) => { if (i) out.push({ t: 'pagebreak' }); out.push(...blocks); });
  return out;
}

function orgHeader(compact = false) {
  const o = S.settings.org || {};
  const out = [];
  if (o.name) out.push({ t: 'center', text: o.name, size: compact ? 11 : 12, bold: true, gap: 0 });
  if (o.short && compact) out.push({ t: 'center', text: `(${o.short})`, size: 11, bold: true, gap: 0 });
  if (o.details && !compact) o.details.split('\n').forEach((l) => out.push({ t: 'center', text: l, size: 8.5, gap: 0 }));
  return out;
}

// Время обедов по умолчанию: три сдвига (10:30, 11:00, 11:30), по 30 минут, каждые 3 часа
export function autoLunch(i) {
  const starts = [11 * 60 + 30, 11 * 60, 10 * 60 + 30];
  const st = starts[i % 3];
  const f = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return [0, 1, 2, 3].map((k) => `${f(st + k * 180)}-${f(st + k * 180 + 30)}`);
}

export const GENERATORS = {
  tabel: {
    excel: true,
    label: 'Табель учёта рабочего времени',
    build() { return [{ t: 'p', text: 'Табель печатается файлом Excel по вашему бланку. Перед печатью выберите число строк и вариант: пустой или заполненный.' }]; },
  },
  envHr: {
    tpl: true,
    label: 'Конверт кадровику',
    build(s) {
      const list = s.hr.length ? s.hr.map((n) => contact('hr', n) || { name: n }) : [null];
      return withPageBreaks(list.map((c) => envelope(s, ['КАДРОВЫЕ', 'ДОКУМЕНТЫ'], c, s.warehouse ? `${s.warehouse}\nВ отдел кадров` : 'В отдел кадров')));
    },
  },
  envAcc: {
    tpl: true,
    label: 'Конверт бухгалтеру — документы',
    build(s) { return envelope(s, ['ДОКУМЕНТЫ'], (S.lists.accountants || [])[0] || null); },
  },
  envGph: {
    tpl: true,
    label: 'Конверт бухгалтеру — ГПХ документы',
    build(s) { return envelope(s, ['ГПХ', 'ДОКУМЕНТЫ'], (S.lists.accountants || [])[0] || null); },
  },
  envLegal: {
    tpl: true,
    label: 'Конверт юристу',
    build(s) { return envelope(s, ['ДОКУМЕНТЫ'], (S.lists.legal || [])[0] || null); },
  },

  returnLabels: {
    tpl: true,
    label: 'Таблички возврата',
    build(s) {
      const n = Math.max(1, Number((S.settings.org || {}).returnCopies) || 4);
      const head = () => [
        { t: 'gap', h: 60 },
        { t: 'center', text: up(s.osp || '____'), size: 96, bold: true, gap: 6, lh: 1.1 },
        { t: 'center', text: up(cityLine(s)), size: 17, bold: true, color: '#777', gap: 34 },
      ];
      const pages = [];
      for (let i = 0; i < n; i++) {
        pages.push([...head(),
          { t: 'center', text: 'МОПы___шт  КОВЁР___шт', size: 29, bold: true, gap: 22 },
          { t: 'center', text: 'ЯЩИК___шт  КРЫШКА___шт', size: 29, bold: true, gap: 22 },
          { t: 'center', text: 'ВОЗВРАТ______________', size: 29, bold: true, gap: 0 }]);
        pages.push([...head(), { t: 'gap', h: 20 },
          { t: 'center', text: 'ВОЗВРАТ', size: 38, bold: true, gap: 8 },
          { t: 'center', text: 'ПОДКОНТРОЛЬНОЙ', size: 38, bold: true, gap: 8 },
          { t: 'center', text: 'ПРОДУКЦИИ', size: 38, bold: true, gap: 0 }]);
      }
      return withPageBreaks(pages);
    },
  },

  receipt: {
    tpl: true,
    label: 'Расписка о размене',
    opts: { serif: true },
    build(s) {
      const m = s.money || {};
      const kkm = Number(m.cashCount) || 0;
      const per = Number(m.perKkm) || (Number(m.total) && kkm ? Math.round(Number(m.total) / kkm) : 0);
      const total = Number(m.total) || (per && kkm ? per * kkm : 0);
      const num = (v) => (v ? Number(v).toLocaleString('ru-RU').replace(/ /g, ' ') : '________');
      const days = (m.daysLong || (m.days || []).map((d) => ({ Пн: 'Понедельник', Вт: 'Вторник', Ср: 'Среда', Чт: 'Четверг', Пт: 'Пятница', Сб: 'Суббота', Вс: 'Воскресенье' })[d] || d).join(', ')) || '______________________';
      const R = (t, b, i) => ({ t, b, i });
      return [
        ...orgHeader(false),
        { t: 'rule', before: 4, after: 30, w: 1.4 },
        { t: 'center', text: 'Р А С П И С К А', size: 12, bold: true, gap: 26 },
        { t: 'rich', size: 11, runs: [R('Обособленное структурное подразделение (магазин) № ', true, true), R(s.osp || '______', true, true)], gap: 0 },
        { t: 'rich', size: 11, runs: [R('по адресу: ', true, true), R(cityLine(s) || '______________________', true, true)], gap: 0 },
        { t: 'rich', size: 11, runs: [R('В целях соблюдения кассовой дисциплины и во исполнение Положения о порядке ведения кассовых операций в подразделениях ' + ((S.settings.org || {}).short || '____') + ', утвержденного ' + ((S.settings.org || {}).order || 'приказом № ____ от ________') + ', утверждено:')], gap: 6 },
        { t: 'rich', size: 11, firstIndent: 22, runs: [R('1. Размен в размере '), R(num(per) + ' руб.', true, true), R(' на 1 ККМ, '), R('количество ККМ - ' + (kkm || '__') + '; итого ' + num(total) + ' руб.', true, true)], gap: 2 },
        { t: 'rich', size: 11, firstIndent: 22, runs: [R('2. Максимальный размер денежных средств в магазине (с учетом размена) после инкассации '), R(num(m.rest), true, true), R(' руб.,')], gap: 2 },
        { t: 'rich', size: 11, firstIndent: 22, runs: [R('3. Инкассация денежных средств обязательна по графику, установленному Договором на инкассацию денежной наличности ' + (m.contract || '№ ________ от __________') + ' в следующие дни: '), R(days, true, true)], gap: 2 },
        { t: 'rich', size: 11, firstIndent: 22, runs: [R('4. Ответственный за соблюдение лимита остатка денежных средств и графика инкассации денежных средств является Управляющий магазином')], gap: 0 },
        { t: 'rich', size: 11, runs: [R(s.manager.fio || '______________________________', true, true)], gap: 2 },
        { t: 'rich', size: 11, firstIndent: 22, runs: [R('5. Контроль за исполнением возлагается на ' + String(m.controllers || '______________________').replace(/\.+$/, '') + '.')], gap: 40 },
        { t: 'left', text: 'С лимитом остатка денежных средств и графиком инкассации денежных средств', size: 10, gap: 10 },
        { t: 'xtable', noBorder: true, cols: [1.1, 2, 0.3, 2, 2], gap: 0, pad: 1, rows: [
          [{ t: 'ознакомлен', size: 10 }, { t: '________________________', size: 10 }, '', { t: '________________________', size: 10 }, ''],
          ['', { t: '(подпись)', size: 8, align: 'center' }, '', { t: '(Дата)', size: 8, align: 'center' }, ''],
        ] },
      ];
    },
  },

  lunch: {
    tpl: true,
    label: 'График перерывов на обед',
    opts: { serif: true, landscape: true },
    build(s) {
      const o = S.settings.org || {};
      const staff = (s.staff || []).filter((p) => p.fio);
      const head = [
        [{ t: '№', bold: true, align: 'center' }, { t: 'ФИО сотрудника', bold: true }, { t: 'Перерывы на обед', bold: true, span: 4, align: 'center' }, { t: 'Отметка об ознакомлении', bold: true, align: 'center' }, { t: 'Подпись', bold: true, align: 'center' }, { t: 'Дата', bold: true, align: 'center' }],
      ];
      const rows = [];
      const dash = '----------------';
      if (s.manager.fio) rows.push([{ t: '1', align: 'center' }, { t: shortFio(s.manager.fio), bold: true }, s.lunchMgr || '15:00-16:00', dash, dash, dash, '', '', '']);
      staff.forEach((p, i) => {
        const l = (p.lunch && p.lunch.some(Boolean)) ? p.lunch : autoLunch(i);
        rows.push([{ t: String(rows.length + 1), align: 'center' }, { t: shortFio(p.fio), bold: true }, ...[0, 1, 2, 3].map((k) => ({ t: l[k] || '', bold: true })), '', '', '']);
      });
      while (rows.length < 7) rows.push([{ t: String(rows.length + 1), align: 'center' }, '', '', '', '', '', '', '', '']);
      return [
        ...(o.name ? [{ t: 'center', text: o.name, size: 11, bold: true, gap: 0 }] : []),
        ...(o.short ? [{ t: 'center', text: `(${o.short})`, size: 11, bold: true, gap: 6 }] : []),
        { t: 'center', text: `ГРАФИК ПЕРЕРЫВОВ НА ОБЕД НА ${new Date().getFullYear()} Г.`, size: 11, bold: true, gap: 4 },
        { t: 'center', text: `ОСП ${s.city || '______'} Магазин № ${s.osp || '____'} Адрес ОСП: ${cityLine(s) || '______________'}`, size: 11, bold: true, gap: 10 },
        { t: 'xtable', size: 10, cols: [0.35, 2.1, 1.15, 1.15, 1.15, 1.15, 1.3, 1, 0.9], rows: [...head, ...rows], headRows: 1, minRowH: 15, pad: 3 },
        { t: 'gap', h: 14 },
        { t: 'left', text: `Согласовано: Управляющий магазином ${s.manager.fio || '______________________'}    _________`, size: 11, bold: true },
      ];
    },
  },

  contacts: {
    label: 'Контакты для директора',
    build(s) {
      const line = (k, n) => { const c = contact(k, n); return c ? [c.name, c.phone].filter(Boolean).join(', ') : n || ''; };
      // таблица контактов региона (вкладка «Контакты») — в вашем виде
      const dir = (S.directory || {})[s.region] || [];
      if (dir.length) {
        const rows = [['ФИО', 'Направление', 'Телефон', 'Почта / примечание'].map((t) => ({ t, bold: true, fill: '#efefef' }))];
        for (const r of dir) {
          if (r.section) rows.push([{ t: r.section, bold: true, fill: '#f6f6f6', span: 4 }]);
          else rows.push([{ t: r.name, bold: true }, r.dept || '', (r.phone || '').replace(/,\s*/g, '\n'), r.email || '']);
        }
        return [
          { t: 'center', text: 'Контакты · ' + s.region, size: 15, bold: true, gap: 0 },
          { t: 'center', text: [sessionLabel(s), s.address, s.manager.fio ? 'Управляющий: ' + [s.manager.fio, s.manager.phone].filter(Boolean).join(', ') : ''].filter(Boolean).join(' · '), size: 9, color: '#555', gap: 8 },
          { t: 'xtable', cols: [1.5, 2.1, 1.3, 1.6], rows, headRows: 1, size: 8.5, pad: 3 },
        ];
      }
      return [
        { t: 'h1', text: 'Контакты', sub: [sessionLabel(s), s.address].filter(Boolean).join(' · ') },
        { t: 'kv', rows: [['Город', s.city], ['ОСП', s.osp], ['Адрес', s.address], ['Управляющий', [s.manager.fio, s.manager.phone].filter(Boolean).join(', ')], ['Регион', s.region], ['Склад (РЦ)', s.warehouse]] },
        { t: 'h2', text: 'Кадры' },
        { t: 'kv', rows: (s.hr.length ? s.hr : ['']).map((n, i) => [i ? '' : 'Кадровик', line('hr', n)]) },
        { t: 'h2', text: 'Бухгалтерия и юристы' },
        { t: 'kv', rows: [['Бухгалтер', ((S.lists.accountants || [])[0] || {}).name || ''], ['Юрист', ((S.lists.legal || [])[0] || {}).name || '']] },
        { t: 'h2', text: 'Пожарная безопасность' },
        { t: 'kv', rows: [['Главный специалист', line('pbMain', s.pbMain)], ['Региональный специалист', line('pbRegional', s.pbRegional)]] },
        { t: 'h2', text: 'Служба безопасности' },
        { t: 'kv', rows: [['Начальник СБ', line('sbHead', s.sbHead)], ['Региональный специалист', line('sbRegional', s.sbRegional)]] },
        { t: 'h2', text: 'Дополнительно' },
        { t: 'kv', rows: [['', ''], ['', ''], ['', '']] },
      ];
    },
  },

  cash: {
    label: 'Размен и инкассация',
    build(s) {
      const m = s.money || {};
      const n = Number(m.cashCount) || Math.max((m.perCash || []).length, 3);
      const rows = [];
      for (let i = 0; i < n; i++) rows.push([`Касса ${i + 1}`, m.perCash && m.perCash[i] ? money(m.perCash[i]) : (m.perKkm ? money(m.perKkm) : '')]);
      return [
        { t: 'h1', text: 'Размен и инкассация', sub: [sessionLabel(s), s.address].filter(Boolean).join(' · ') },
        { t: 'kv', rows: [['Сумма размена, всего', money(m.total)], ['Остаток после инкассации', money(m.rest)], ['Дни инкассации', (m.days || []).join(', ')], ['Договор инкассации', m.contract || '']] },
        { t: 'h2', text: 'Размен по кассам' },
        { t: 'table', cols: [{ label: 'Касса', w: 1 }, { label: 'Сумма', w: 1 }], rows, minRowH: 24 },
        m.note ? { t: 'p', text: m.note } : { t: 'kv', rows: [['Примечание', '']] },
      ];
    },
  },

  stickersDocx: {
    label: 'Наклейки (Word)',
    tpl: true,
    word: true,
    build() { return [{ t: 'p', text: 'Наклейки собираются в Word-файл по загруженному шаблону.' }]; },
  },
};

// Значения для подстановки в Word-шаблоны
export function docxValues(s) {
  const staff = (s.staff || []).filter((p) => p.fio);
  const people = [s.manager.fio, ...staff.map((p) => p.fio)].filter(Boolean);
  const nameUp = (f) => up(String(f).trim().split(/\s+/).slice(0, 2).join(' '));
  const v = {
    OSP: s.osp || '', CITY: s.city || '', ADDRESS: s.city ? `г.${s.city},${(s.address || '').trim()}` : (s.address || ''), MGR: up(shortFio(s.manager.fio)), PHONE: s.manager.phone || '',
    WAREHOUSE: s.warehouse || '', REGION: s.region || '', DATE: fmtDate(new Date()),
  };
  for (let i = 1; i <= 12; i++) v['N' + i] = people[i - 1] ? nameUp(people[i - 1]) : '';
  const ru = { ОСП: v.OSP, ГОРОД: v.CITY, АДРЕС: v.ADDRESS, УПРАВЛЯЮЩИЙ: v.MGR, ТЕЛЕФОН: v.PHONE, СКЛАД: v.WAREHOUSE, РЕГИОН: v.REGION, ДАТА: v.DATE };
  for (let i = 1; i <= 12; i++) ru['СОТРУДНИК' + i] = v['N' + i];
  return { ...v, ...ru };
}


// ---------- значения для шаблонов Word ----------
const DAY_LONG = { Пн: 'Понедельник', Вт: 'Вторник', Ср: 'Среда', Чт: 'Четверг', Пт: 'Пятница', Сб: 'Суббота', Вс: 'Воскресенье' };

// Порядок сотрудников в графике обедов: по сменам, внутри — по функционалам; время по функционалу
export function lunchPeople(s) {
  const roles = S.lists.roles;
  const staff = (s.staff || []).filter((p) => p.fio);
  const key = (p) => [Number(p.shift) || 9, roles.indexOf(p.role) < 0 ? 9 : roles.indexOf(p.role)];
  return staff.slice().sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1]; })
    .map((p) => ({ p, lunch: (p.lunch && p.lunch.some(Boolean)) ? p.lunch : autoLunch(Math.max(0, roles.indexOf(p.role))) }));
}

export function baseValues(s) {
  const m = s.money || {};
  const kkm = Number(m.cashCount) || 0;
  const per = Number(m.perKkm) || (Number(m.total) && kkm ? Math.round(Number(m.total) / kkm) : 0);
  const total = Number(m.total) || (per && kkm ? per * kkm : 0);
  const v = {
    ОСП: s.osp || '', ГОРОД: s.city || '', АДРЕС: s.address || '',
    АДРЕС_ВЕРХ: up(cityLine(s)), АДРЕС_ПОЛН: cityLine(s),
    АДРЕС_КОМП: up(s.city ? `г.${s.city}, ${(s.address || '').trim()}`.replace(/,\s*$/, '') : (s.address || '')),
    ОТ: up(genitive(s.manager.fio)), ТЕЛ: s.manager.phone || '',
    УПРАВЛЯЮЩИЙ: s.manager.fio || '', УПР_КРАТКО: shortFio(s.manager.fio), УПР_ОБЕД: s.lunchMgr || '15:00-16:00',
    ГОД: String(new Date().getFullYear()), ДАТА: fmtDate(new Date()),
    СКЛАД: s.warehouse || '', РЕГИОН: s.region || '',
    РАЗМЕН_ККМ: per ? String(per) : '______', ККМ: kkm ? String(kkm) : '__', РАЗМЕН_ИТОГО: total ? String(total) : '______',
    ЛИМИТ: m.rest ? String(m.rest) : '______', ДОГОВОР: m.contract || '№ ______ от ________',
    ДНИ: (m.days || []).map((d) => DAY_LONG[d] || d).join(', ') || '______________',
    КОНТРОЛЬ: String(m.controllers || '______________').replace(/\.+$/, '') + '.',
  };
  lunchPeople(s).slice(0, 6).forEach(({ p, lunch }, i) => {
    v[`С${i + 1}_ФИО`] = shortFio(p.fio);
    lunch.forEach((t, k) => { v[`С${i + 1}_${k + 1}`] = t || ''; });
  });
  for (let i = 1; i <= 6; i++) { if (!(`С${i}_ФИО` in v)) { v[`С${i}_ФИО`] = ''; for (let k = 1; k <= 4; k++) v[`С${i}_${k}`] = ''; } }
  return { ...docxValues(s), ...v };
}

export function envelopeValues(s, c) {
  const who = c ? (c.dative || dative(c.name)) : '';
  const [f = '', i = ''] = up(who).split(/\s+/);
  const addr = up(c && c.address ? c.address : '').split('\n').map((x) => x.trim()).filter(Boolean);
  return { ...baseValues(s), КОМУ_Ф: f, КОМУ_И: i, КУДА_1: addr[0] || '', КУДА_2: addr.slice(1).join(' ') || '' };
}

// Сколько файлов даёт шаблон: конверт кадровику — по одному на каждого выбранного
export function templateRuns(gen, s) {
  if (gen === 'envHr') return (s.hr.length ? s.hr : ['']).map((n) => { const c = contact('hr', n) || (n ? { name: n } : null); return { suffix: c ? (c.dative || dative(c.name)).split(/\s+/)[0] : '', values: envelopeValues(s, c) }; });
  if (gen === 'envAcc' || gen === 'envGph') return [{ suffix: '', values: envelopeValues(s, (S.lists.accountants || [])[0]) }];
  if (gen === 'envLegal') return [{ suffix: '', values: envelopeValues(s, (S.lists.legal || [])[0]) }];
  return [{ suffix: '', values: baseValues(s) }];
}
