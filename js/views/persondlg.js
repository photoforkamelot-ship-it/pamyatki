// Карточка человека для контактов: ФИО с подсказками по уже известным людям, телефон с кнопкой «Вставить»,
// разбор вставленного текста (имя + телефон + почта одним куском). Окно крепится к верху — не прыгает.
import { h } from '../util.js';
import { openModal, toast, confirmDlg } from '../ui.js';
import { suggest, surnameFirst, normPhones, parseText } from '../contactbook.js';

const id = () => 'pd' + Math.random().toString(36).slice(2, 7);

async function readClipboard() {
  try { if (navigator.clipboard && navigator.clipboard.readText) return await navigator.clipboard.readText(); } catch (e) { /* нет доступа */ }
  return null;
}

export function personDlg({ title, row = {}, reg = '', sections = null, section = '', canDelete = false }) {
  const f = {
    name: h('input', { class: 'input', id: id(), autocomplete: 'off', autocapitalize: 'words', placeholder: 'Фамилия Имя Отчество', enterkeyhint: 'next' }),
    dept: h('input', { class: 'input', id: id(), placeholder: 'Должность / направление', enterkeyhint: 'next' }),
    phone: h('input', { class: 'input', id: id(), type: 'tel', inputmode: 'tel', placeholder: '8-900-000-00-00', enterkeyhint: 'next' }),
    email: h('input', { class: 'input', id: id(), type: 'email', inputmode: 'email', autocapitalize: 'off', placeholder: 'name@ya-retail.ru', enterkeyhint: 'done' }),
  };
  f.name.value = row.name || ''; f.dept.value = row.dept || ''; f.phone.value = row.phone || ''; f.email.value = row.email || '';
  const sec = sections && sections.length ? h('select', { class: 'input', id: id() }, sections.map((s) => h('option', { value: s }, s))) : null;
  if (sec) sec.value = section || sections[0];

  const sugg = h('div', { class: 'pd-sugg', role: 'listbox' });
  const note = h('p', { class: 'pd-note' });
  const fill = (p) => {
    f.name.value = p.name;
    if (p.dept) f.dept.value = p.dept;
    if (p.phone) f.phone.value = p.phone;
    if (p.email) f.email.value = p.email;
    sugg.innerHTML = ''; showNote();
  };
  const showNote = () => {
    const v = f.name.value.trim(), n = surnameFirst(v);
    note.textContent = v && n !== v ? `Запишется как: ${n}` : '';
  };
  const drawSugg = () => {
    sugg.innerHTML = '';
    const v = f.name.value.trim();
    const list = suggest(v, reg).filter((p) => p.name.toLowerCase() !== v.toLowerCase());
    for (const p of list) {
      sugg.append(h('button', { type: 'button', role: 'option', onClick: () => fill(p) },
        p.name, h('small', null, [p.dept, p.region, p.phone].filter(Boolean).join(' · '))));
    }
  };
  f.name.addEventListener('input', () => { drawSugg(); showNote(); });
  // вставили в ФИО целый контакт (имя, телефон, почта) — раскладываем по полям
  f.name.addEventListener('paste', (e) => {
    const t = (e.clipboardData || window.clipboardData)?.getData('text') || '';
    if (!/\d{3}|@|\n/.test(t)) return;
    e.preventDefault();
    const p = parseText(t);
    f.name.value = p.name; if (p.dept) f.dept.value = p.dept; if (p.phone) f.phone.value = p.phone; if (p.email) f.email.value = p.email;
    drawSugg(); showNote();
  });
  f.phone.addEventListener('blur', () => { f.phone.value = normPhones(f.phone.value); });
  const pasteBtn = h('button', { type: 'button', class: 'btn ghost', onClick: async () => {
    const t = await readClipboard();
    if (t == null) { f.phone.focus(); toast('Нажмите в поле и удерживайте → «Вставить»'); return; }
    const p = parseText(t);
    f.phone.value = normPhones(p.phone || t);
    if (!f.name.value.trim() && p.name && !/\d/.test(p.name)) f.name.value = p.name;
    if (!f.email.value && p.email) f.email.value = p.email;
  } }, 'Вставить');

  const lab = (el, t) => h('label', { for: el.id }, t);
  const body = h('div', { class: 'form' },
    h('div', { class: 'field' }, lab(f.name, 'ФИО'), f.name, sugg, note),
    h('div', { class: 'field' }, lab(f.dept, 'Должность / направление'), f.dept),
    h('div', { class: 'field' }, lab(f.phone, 'Телефон (несколько — через запятую)'), h('div', { class: 'pd-phone' }, f.phone, pasteBtn)),
    h('div', { class: 'field' }, lab(f.email, 'Почта'), f.email),
    sec ? h('div', { class: 'field' }, lab(sec, 'Раздел'), sec) : null,
  );
  const order = [f.name, f.dept, f.phone, f.email];
  order.forEach((el, k) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sugg.innerHTML = ''; (order[k + 1] || el).focus(); if (!order[k + 1]) el.blur(); } }));

  const m = openModal({
    title, body, top: true,
    actions: [
      canDelete ? { label: 'Удалить', kind: 'ghost danger-text', onClick: async (close) => { if (await confirmDlg('Удалить из контактов?', row.name || '', 'Удалить', 'Отмена', true)) close('delete'); return false; } } : null,
      { label: 'Отмена', kind: 'ghost', value: null },
      { label: 'Сохранить', kind: 'primary', onClick: (close) => {
        const name = surnameFirst(f.name.value.trim());
        if (!name && !f.dept.value.trim() && !f.phone.value.trim()) { toast('Заполните ФИО или направление', 'warn'); return false; }
        close({ name, dept: f.dept.value.trim(), phone: normPhones(f.phone.value), email: f.email.value.trim(), section: sec ? sec.value : section });
        return false;
      } },
    ],
  });
  if (!row.name && window.matchMedia('(pointer: fine)').matches) setTimeout(() => f.name.focus(), 120);
  return m.promise.then((v) => v ?? null);
}
