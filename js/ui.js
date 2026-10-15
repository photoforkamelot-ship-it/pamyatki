// Модальные окна, подтверждения, выбор файлов, уведомления.
import { h, icon } from './util.js';
import { tg } from './tg.js';

const stack = [];
const backHandlers = [];

export function pushBack(fn) {
  backHandlers.push(fn);
  syncBack();
}
export function popBack(fn) {
  const i = backHandlers.lastIndexOf(fn);
  if (i >= 0) backHandlers.splice(i, 1);
  syncBack();
}
function syncBack() {
  if (!tg) return;
  if (backHandlers.length) tg.BackButton.show();
  else tg.BackButton.hide();
}
if (tg) {
  tg.BackButton.onClick(() => {
    const fn = backHandlers[backHandlers.length - 1];
    if (fn) fn();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) {
    const top = stack[stack.length - 1];
    if (top.dismissable) top.close(undefined);
  }
});

export function openModal({ title, body, actions = [], dismissable = true, wide = false, onClose }) {
  let resolveFn;
  const promise = new Promise((r) => (resolveFn = r));
  const root = h('div', { class: 'modal-root' });
  const sheet = h('div', { class: 'sheet' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Окно' });
  const entry = { dismissable, close: null };

  let closed = false;
  function close(value) {
    if (closed) return;
    closed = true;
    root.classList.add('leaving');
    setTimeout(() => root.remove(), 160);
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    popBack(backFn);
    if (!stack.length) document.body.classList.remove('no-scroll');
    onClose && onClose(value);
    resolveFn(value);
  }
  entry.close = close;
  const backFn = () => dismissable && close(undefined);

  const head = h('div', { class: 'sheet-head' },
    h('h2', { class: 'sheet-title' }, title || ''),
    dismissable ? h('button', { class: 'icon-btn', 'aria-label': 'Закрыть', onClick: () => close(undefined) }, icon('close')) : null,
  );
  const content = h('div', { class: 'sheet-body' });
  const bodyNode = typeof body === 'function' ? body(close) : body;
  if (bodyNode) content.appendChild(bodyNode);
  const foot = h('div', { class: 'sheet-foot' });
  function renderActions(list) {
    foot.innerHTML = '';
    for (const a of list) {
      if (!a) continue;
      foot.appendChild(h('button', {
        class: 'btn ' + (a.kind || 'ghost'),
        disabled: a.disabled,
        onClick: async () => {
          if (a.onClick) {
            const r = await a.onClick(close);
            if (r === false) return;
          }
          if (!a.keepOpen) close(a.value);
        },
      }, a.label));
    }
    foot.style.display = list.filter(Boolean).length ? '' : 'none';
  }
  renderActions(actions);
  sheet.append(head, content, foot);
  root.appendChild(sheet);
  root.addEventListener('mousedown', (e) => { if (e.target === root && dismissable) close(undefined); });
  document.body.appendChild(root);
  document.body.classList.add('no-scroll');
  stack.push(entry);
  pushBack(backFn);
  requestAnimationFrame(() => root.classList.add('shown'));
  return { close, promise, root, content, setActions: renderActions, setTitle: (t) => (head.firstChild.textContent = t) };
}

export function confirmDlg(title, text, okLabel = 'Да', cancelLabel = 'Отмена', danger = false) {
  return openModal({
    title,
    body: text ? h('p', { class: 'muted-p' }, text) : null,
    actions: [
      { label: cancelLabel, kind: 'ghost', value: false },
      { label: okLabel, kind: danger ? 'danger' : 'primary', value: true },
    ],
  }).promise.then((v) => v === true);
}

export function alertDlg(title, text) {
  return openModal({ title, body: h('p', { class: 'muted-p' }, text), actions: [{ label: 'Понятно', kind: 'primary', value: true }] }).promise;
}

export function choiceDlg(title, text, options) {
  return openModal({
    title,
    body: text ? (text instanceof Node ? text : h('p', { class: 'muted-p' }, text)) : null,
    actions: options.map((o) => ({ label: o.label, kind: o.kind || 'ghost', value: o.value })),
  }).promise;
}

export function promptDlg(title, { label, value = '', placeholder = '', multiline = false, okLabel = 'Сохранить', type = 'text' } = {}) {
  const input = multiline
    ? h('textarea', { class: 'input', rows: 8, placeholder })
    : h('input', { class: 'input', type, placeholder });
  input.value = value;
  const id = 'p' + Math.random().toString(36).slice(2, 7);
  input.id = id;
  const m = openModal({
    title,
    body: h('div', { class: 'field' }, label ? h('label', { for: id }, label) : null, input),
    actions: [
      { label: 'Отмена', kind: 'ghost', value: null },
      { label: okLabel, kind: 'primary', onClick: (close) => { close(input.value.trim()); return false; } },
    ],
  });
  if (!multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.close(input.value.trim()); });
  setTimeout(() => input.focus(), 120);
  return m.promise.then((v) => (v === undefined ? null : v));
}

// Форма из нескольких полей: fields = [{key, label, value, type, placeholder, options}]
export function formDlg(title, fields, okLabel = 'Сохранить') {
  const inputs = {};
  const body = h('div', { class: 'form' }, fields.map((f) => {
    const id = 'f' + Math.random().toString(36).slice(2, 7);
    let input;
    if (f.options) {
      input = h('select', { class: 'input', id }, f.options.map((o) => h('option', { value: o.value }, o.label)));
    } else if (f.multiline) {
      input = h('textarea', { class: 'input', id, rows: 4, placeholder: f.placeholder || '' });
    } else {
      input = h('input', { class: 'input', id, type: f.type || 'text', placeholder: f.placeholder || (f.type === 'tel' ? '8-900-000-00-00' : ''), inputmode: f.inputmode });
    }
    if (!f.options || f.value != null) input.value = f.value ?? '';
    inputs[f.key] = input;
    return h('div', { class: 'field' }, h('label', { for: id }, f.label), input);
  }));
  return openModal({
    title,
    body,
    actions: [
      { label: 'Отмена', kind: 'ghost', value: null },
      { label: okLabel, kind: 'primary', onClick: (close) => {
        const out = {};
        for (const [k, i] of Object.entries(inputs)) out[k] = i.value.trim();
        close(out);
        return false;
      } },
    ],
  }).promise.then((v) => v || null);
}

export function pickFiles({ accept = 'application/pdf', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { position: 'fixed', left: '-9999px' } });
    if (multiple) input.multiple = true;
    let done = false;
    input.addEventListener('change', () => {
      done = true;
      resolve(Array.from(input.files || []));
      input.remove();
    });
    // Если окно выбора закрыли без файла
    window.addEventListener('focus', () => setTimeout(() => { if (!done) { resolve([]); input.remove(); } }, 1200), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

let toastTimer;
export function toast(msg, kind = '') {
  let t = document.querySelector('.toast');
  if (!t) {
    t = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

export async function withBusy(text, fn) {
  const label = h('div', { class: 'busy-text' }, text);
  const el = h('div', { class: 'busy' }, h('div', { class: 'spinner' }), label);
  document.body.appendChild(el);
  try {
    return await fn((t) => (label.textContent = t));
  } finally {
    el.remove();
  }
}

// Чипы с одиночным/множественным выбором и кнопкой «+»
export function chipSelect({ options, value, multi = false, onChange, onAdd, labelOf = (o) => o, keyOf = (o) => o }) {
  const wrap = h('div', { class: 'chips' });
  const sel = new Set(multi ? (value || []) : (value ? [value] : []));
  function render() {
    wrap.innerHTML = '';
    for (const o of options) {
      const k = keyOf(o);
      const on = sel.has(k);
      wrap.appendChild(h('button', {
        class: 'chip' + (on ? ' on' : ''),
        'aria-pressed': on ? 'true' : 'false',
        onClick: () => {
          if (multi) { on ? sel.delete(k) : sel.add(k); onChange([...sel]); }
          else { sel.clear(); if (!on) sel.add(k); onChange(on ? '' : k); }
          render();
        },
      }, labelOf(o)));
    }
    if (onAdd) wrap.appendChild(h('button', { class: 'chip add', 'aria-label': 'Добавить вариант', onClick: onAdd }, icon('plus')));
  }
  render();
  return wrap;
}

export function toggle(label, checked, onChange, hint) {
  const id = 't' + Math.random().toString(36).slice(2, 7);
  const input = h('input', { type: 'checkbox', id, class: 'switch-input' });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('div', { class: 'toggle-row' },
    h('label', { for: id, class: 'toggle-label' }, h('span', null, label), hint ? h('small', null, hint) : null),
    h('span', { class: 'switch' }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' })),
  );
}

export function menu(anchor, items) {
  const list = h('div', { class: 'menu-list' }, items.filter(Boolean).map((it) => h('button', {
    class: 'menu-item' + (it.danger ? ' danger' : ''),
    onClick: () => { m.close(); it.onClick(); },
  }, it.label)));
  const m = openModal({ title: anchor || 'Действия', body: list, actions: [] });
  return m;
}
