// Контактная книга по регионам.
// • Шаблон — S.directory[регион] (из стартового пакета, «Контакты сотрудников»).
// • Рабочая книга региона — S.contactBook[регион]: при первом обращении копируется из шаблона,
//   дальше хранит все правки, порядок и добавленных людей. Новый объект в том же регионе
//   открывается с ней — «как в последний раз».
// • Скрыть строку можно только на текущий объект: S.session.hiddenContacts (id строк).
// • Подсказки по фамилии — из всех людей, которых приложение когда-либо видело.
import { uid, clone, formatPhone } from './util.js';
import { S, update } from './store.js';

const low = (x) => String(x || '').trim().toLowerCase().replace(/ё/g, 'е');
const CAP = /^[А-ЯЁA-Z][а-яёa-z-]+$/;

// «Наталья Фёдоровна Конохова» → «Конохова Наталья Фёдоровна» (в шаблоне фамилия в конце)
export function surnameFirst(name) {
  const w = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (w.length < 2 || w.length > 3 || !w.every((x) => CAP.test(x))) return String(name || '').trim();
  if (w.length === 3 && /(вич|вна|ична|чна)$/i.test(w[1])) return [w[2], w[0], w[1]].join(' ');
  if (w.length === 2 && looksLikeFirstName(w[0]) && !looksLikeFirstName(w[1])) return [w[1], w[0]].join(' ');
  return w.join(' ');
}
const FIRST = new Set(('александр алексей анатолий андрей антон артём артем борис вадим валентин валерий василий виктор виталий владимир владислав вячеслав геннадий георгий глеб григорий денис дмитрий евгений егор иван игорь илья кирилл константин леонид максим марк михаил никита николай олег павел пётр петр роман руслан сергей станислав степан тимофей тимур фёдор федор юрий ярослав ' +
  'алёна алена алина алиса алла анастасия ангелина анна антонина валентина валерия вера вероника виктория галина дарья диана ева евгения екатерина елена елизавета жанна зоя инна ирина карина кира кристина ксения лариса лидия любовь людмила маргарита марина мария надежда наталья наталия нина оксана олеся ольга полина раиса светлана софия софья тамара татьяна ульяна юлия яна').split(' '));
function looksLikeFirstName(w) { return FIRST.has(low(w)); }

// Разделы: «Отделы ОТ, ГОиЧС, ПБ» делим на «Охрана труда», «ПБ, ГО и ЧС», «ОПС»; ЕГАИС — отдельно
const OT = 'Охрана труда', PB = 'ПБ, ГО и ЧС', OPS = 'ОПС (охранно-пожарная сигнализация)', EGAIS = 'Отдел ЕГАИС';
function splitSections(rows) {
  const out = [];
  const extra = { [OT]: [], [PB]: [], [OPS]: [], [EGAIS]: [] };
  let sec = '', otAt = -1;
  for (const r of rows) {
    if (r.section) {
      sec = r.section;
      if (/ОТ.*(ГО|ПБ)|(ГО|ПБ).*ОТ/i.test(sec)) { otAt = out.length; continue; }
      out.push(r); continue;
    }
    if (otAt >= 0 && sec && /ОТ.*(ГО|ПБ)|(ГО|ПБ).*ОТ/i.test(sec)) {
      const d = low(r.dept);
      if (/охран[аы]? труда|охраны труда/.test(d)) extra[OT].push(r);
      else if (/охранно|опс|сигнализ/.test(d)) extra[OPS].push(r);
      else extra[PB].push(r);
      continue;
    }
    if (/егаис/.test(low(r.dept)) && !r.name) { extra[EGAIS].push(r); continue; }
    out.push(r);
  }
  // вставляем на место старого общего раздела (или в конец)
  const block = [];
  for (const s of [OT, PB, OPS]) block.push({ id: uid(), section: s }, ...extra[s]);
  if (extra[EGAIS].length) block.push({ id: uid(), section: EGAIS }, ...extra[EGAIS]);
  out.splice(otAt >= 0 ? otAt : out.length, 0, ...block);
  return out;
}

export function seedRows(reg) {
  const tpl = ((S.directory || {})[reg] || []).map((r) => (r.section ? { id: uid(), section: r.section.trim() } : { id: uid(), name: surnameFirst(r.name), dept: (r.dept || '').trim(), phone: r.phone || '', email: r.email || '' }));
  return splitSections(tpl);
}

export function regionsAll() {
  return [...new Set([...(S.lists.regions || []), ...Object.keys(S.directory || {}), ...Object.keys(S.contactBook || {})])].filter(Boolean);
}

// Рабочая книга региона (создаётся из шаблона при первом обращении)
export function book(reg) {
  if (!reg) return [];
  if (!S.contactBook) S.contactBook = {};
  if (!S.contactBook[reg]) S.contactBook[reg] = seedRows(reg);
  return S.contactBook[reg];
}
export function hasTemplate(reg) { return !!((S.directory || {})[reg] || []).length; }
export function resetToTemplate(reg) { update((st) => { if (!st.contactBook) st.contactBook = {}; st.contactBook[reg] = seedRows(reg); if (reg === st.session.region) st.session.hiddenContacts = []; }); }

export const isHidden = (row) => (S.session.hiddenContacts || []).includes(row.id);
export function toggleHidden(row) {
  update((st) => {
    const h = st.session.hiddenContacts = st.session.hiddenContacts || [];
    const i = h.indexOf(row.id);
    if (i >= 0) h.splice(i, 1); else h.push(row.id);
  });
}

// строки для печати: без скрытых и без пустых разделов
export function printableRows(reg) {
  const rows = book(reg).filter((r) => r.section || (reg !== S.session.region || !isHidden(r)));
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.section) {
      const next = rows.slice(i + 1).findIndex((x) => x.section);
      const body = rows.slice(i + 1, next < 0 ? rows.length : i + 1 + next);
      if (!body.some((x) => x.name || x.dept || x.phone || x.email)) continue;
    } else if (!(r.name || r.dept || r.phone || r.email)) continue;
    out.push(r);
  }
  return out;
}

export function sectionsOf(reg) { return book(reg).filter((r) => r.section).map((r) => r.section); }
export function sectionOf(list, row) {
  for (let i = list.indexOf(row); i >= 0; i--) if (list[i].section) return list[i].section;
  return '';
}
export function insertInSection(list, section, row) {
  let i = list.findIndex((r) => r.section === section);
  if (i < 0) { list.push({ id: uid(), section }); list.push(row); return; }
  i++;
  while (i < list.length && !list[i].section) i++;
  list.splice(i, 0, row);
}
export function moveRow(list, row, dir) {
  const i = list.indexOf(row), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length || list[j].section) return false;
  [list[i], list[j]] = [list[j], list[i]];
  return true;
}

// Все известные люди: книги всех регионов, шаблоны, списки кадровиков/бухгалтеров/ПБ/СБ
export function knownPeople() {
  const map = new Map();
  const add = (p, region, section) => {
    if (!p || !p.name) return;
    const name = surnameFirst(p.name);
    const k = low(name);
    const cur = map.get(k);
    const item = { name, dept: p.dept || '', phone: p.phone || '', email: p.email || '', region: region || p.region || '', section: section || '' };
    if (!cur) map.set(k, item);
    else for (const f of ['dept', 'phone', 'email', 'region', 'section']) if (!cur[f] && item[f]) cur[f] = item[f];
  };
  for (const [reg, rows] of Object.entries(S.contactBook || {})) { let sec = ''; for (const r of rows) { if (r.section) sec = r.section; else add(r, reg, sec); } }
  for (const [reg, rows] of Object.entries(S.directory || {})) { let sec = ''; for (const r of rows) { if (r.section) sec = r.section; else add(r, reg, sec); } }
  for (const k of ['hr', 'accountants', 'legal', 'pbMain', 'pbRegional', 'sbHead', 'sbRegional', 'trainers', 'recruiters', 'other']) for (const c of S.lists[k] || []) add(c, c.region, '');
  return [...map.values()];
}

// Подсказки: совпадение с началом любого слова ФИО; свой регион — выше
export function suggest(q, reg, limit = 6) {
  const t = low(q);
  if (t.length < 2) return [];
  const words = t.split(/\s+/);
  return knownPeople()
    .filter((p) => { const n = low(p.name).split(/\s+/); return words.every((w) => n.some((x) => x.startsWith(w))); })
    .sort((a, b) => (b.region === reg) - (a.region === reg) || a.name.localeCompare(b.name, 'ru'))
    .slice(0, limit);
}

// ---------- печать: Excel по образцу «Контакты сотрудников» + PDF на 1 лист ----------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export async function contactsXlsx(reg, title) {
  const JSZip = window.JSZip || (await import('./docx.js').then((m) => m.loadZip()));
  const tpl = await fetch(new URL('../tpl/contacts.xlsx', import.meta.url)).then((r) => { if (!r.ok) throw new Error('нет шаблона контактов'); return r.arrayBuffer(); });
  const zip = await JSZip.loadAsync(tpl);
  const path = 'xl/worksheets/sheet1.xml';
  let xml = await zip.file(path).async('string');
  const styleOf = (ref) => (xml.match(new RegExp(`<c r="${ref}" s="(\\d+)"`)) || [])[1] || '0';
  const st = { head: ['A1', 'B1', 'C1', 'D1'].map(styleOf), sec: ['A2', 'B2', 'C2', 'D2'].map(styleOf), row: ['A3', 'B3', 'C3', 'D3'].map(styleOf) };
  const widths = [...xml.matchAll(/<col [^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
  const cell = (ref, s, v) => (v ? `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>` : `<c r="${ref}" s="${s}"/>`);
  const COLS = ['A', 'B', 'C', 'D'];
  const rows = [], merges = [];
  let n = 1;
  rows.push(`<row r="1">${['ФИО', 'Направление', 'Телефон', 'Электронная почта'].map((t, i) => cell(COLS[i] + 1, st.head[i], t)).join('')}</row>`);
  for (const r of printableRows(reg)) {
    n++;
    if (r.section) {
      rows.push(`<row r="${n}">${COLS.map((c, i) => cell(c + n, st.sec[i], i ? '' : r.section)).join('')}</row>`);
      merges.push(`<mergeCell ref="A${n}:D${n}"/>`);
      continue;
    }
    const vals = [r.name, r.dept, (r.phone || '').replace(/,\s*/g, '\n'), r.email];
    // высота строки по самому длинному столбцу (перенос по словам)
    const lines = Math.max(1, ...vals.map((v, i) => String(v || '').split('\n').reduce((a, part) => a + Math.max(1, Math.ceil(part.length / Math.max(8, (widths[i] || 20) * 1.05))), 0)));
    rows.push(`<row r="${n}"${lines > 1 ? ` ht="${lines * 15}" customHeight="1"` : ''}>${vals.map((v, i) => cell(COLS[i] + n, st.row[i], v)).join('')}</row>`);
  }
  xml = xml.replace(/<sheetData>[\s\S]*<\/sheetData>/, `<sheetData>${rows.join('')}</sheetData>`)
    .replace(/<mergeCells[\s\S]*?<\/mergeCells>/, merges.length ? `<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>` : '')
    .replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:D${n}"/>`);
  zip.file(path, xml);
  if (title) {
    const wbp = 'xl/workbook.xml';
    const wb = await zip.file(wbp).async('string');
    zip.file(wbp, wb.replace(/<sheet name="[^"]*"/, `<sheet name="${esc(title).slice(0, 31)}"`));
  }
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

// Объединить людей из старых списков ПБ/СБ в книгу региона (один раз), чтобы введённые раньше не потерялись
export function absorbLegacy(reg) {
  if (!reg) return;
  const list = book(reg);
  const have = new Set(list.filter((r) => !r.section).map((r) => low(r.name)));
  const put = (key, section, dept) => {
    for (const c of S.lists[key] || []) {
      if (c.region !== reg || !c.name || have.has(low(surnameFirst(c.name)))) continue;
      insertInSection(list, section, { id: uid(), name: surnameFirst(c.name), dept, phone: normPhones(c.phone || ''), email: '' });
      have.add(low(surnameFirst(c.name)));
    }
  };
  put('pbMain', PB, 'главный специалист ПБ');
  put('pbRegional', PB, 'региональный специалист ПБ');
  put('sbHead', 'Служба экономической безопасности', 'начальник СБ');
  put('sbRegional', 'Служба экономической безопасности', 'региональный специалист СБ');
}

// ---------- разбор телефона / вставленного текста / файла контакта ----------
// Каждый номер — в вид 8-923-900-90-90, «+7» меняется на 8; добавочные и городские оставляем как есть
export function normPhones(str) {
  return String(str || '').split(/\s*[,;]\s*/).map((p) => {
    const d = p.replace(/\D/g, '');
    if (/доп/i.test(p) || d.length < 10 || d.length > 11) return p.trim();
    if (d.length === 10 && d[0] !== '9') return p.trim();
    return formatPhone(d);
  }).filter(Boolean).join(', ');
}

export function parseVcf(text) {
  const out = [];
  for (const card of String(text).split(/BEGIN:VCARD/i).slice(1)) {
    const lines = card.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
    const get = (re) => lines.filter((l) => re.test(l)).map((l) => l.slice(l.indexOf(':') + 1).trim());
    const fn = get(/^FN[;:]/i)[0] || (get(/^N[;:]/i)[0] || '').split(';').filter(Boolean).reverse().join(' ');
    out.push({ name: fn, phone: normPhones(get(/^(item\d+\.)?TEL[;:]/i).join(', ')), email: get(/^(item\d+\.)?EMAIL[;:]/i)[0] || '', dept: [get(/^TITLE[;:]/i)[0], get(/^ORG[;:]/i)[0]].filter(Boolean).join(', ').replace(/;+/g, ' ').trim() });
  }
  return out.filter((c) => c.name || c.phone);
}

export function parseText(text) {
  const t = String(text || '');
  const phones = t.match(/(\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g) || [];
  const email = (t.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0];
  let rest = t; phones.forEach((p) => { rest = rest.replace(p, ' '); }); rest = rest.replace(email, ' ');
  const words = rest.split(/\n|,|;|\t/).map((x) => x.trim()).filter((x) => x.length > 1);
  return { name: words[0] || '', dept: words.slice(1).join(', '), phone: normPhones(phones.join(', ')), email };
}


export { OT, PB, OPS, EGAIS, clone };

