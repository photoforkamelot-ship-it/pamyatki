// Настройки: вкладки (порядок, объединение, скрытие), отображение, печать, Google Диск, данные.
import { h, icon, fmtSize, fmtDateTime, uid } from '../util.js';
import { S, update, replaceState, tabById, makeTab, CONTACT_LISTS } from '../store.js';
import { applyStarter } from '../starter.js';
import { dative } from '../generators.js';
import { openModal, confirmDlg, choiceDlg, promptDlg, toggle, toast, withBusy, formDlg, pickFiles } from '../ui.js';
import { storageInfo, requestPersist, fileKeys, fileGet, filePut } from '../db.js';
import { ping, pullState, pushState, driveOn, uploadFile, syncStatus } from '../drive.js';
import { inTelegram, tgUser } from '../tg.js';
import { bytesToBase64, base64ToBytes } from '../util.js';

const KIND_NAMES = { people: 'Контакты по регионам', memos: 'Памятки и вводные', docs: 'Список документов', schedule: 'Сервисный график', plan: 'Опорный план', contracts: 'Договора', shelves: 'Деления', materials: 'Материалы из Google Диска' };
const isDocs = (t) => t.kind === 'docs' || t.kind === 'memos';

export function tabSettingsDlg(tab) {
  const body = h('div', { class: 'form' });
  const name = h('input', { class: 'input', id: 'tabName' });
  name.value = tab.title;
  body.append(h('div', { class: 'field' }, h('label', { for: 'tabName' }, 'Название вкладки'), name));
  const st = { ...tab.settings };
  if (isDocs(tab) || tab.kind === 'contracts') {
    body.append(
      h('p', { class: 'cap' }, 'Печать'),
      h('div', { class: 'seg' }, [['duplex', 'Двусторонняя'], ['simplex', 'Односторонняя']].map(([v, l]) => {
        const b = h('button', { class: 'seg-btn' + (st.printMode === v ? ' on' : ''), onClick: () => { st.printMode = v; b.parentNode.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b)); } }, l);
        return b;
      })),
      h('small', { class: 'hint' }, 'Двусторонняя: каждый документ добивается пустой страницей до чётного числа, переворот по длинному краю.'),
    );
  }
  if (isDocs(tab)) {
    body.append(
      toggle('Титульный лист и содержание', st.cover, (v) => (st.cover = v), 'Первые две страницы общего файла'),
      toggle('Кнопка печати у каждого документа', st.perItemPrint, (v) => (st.perItemPrint = v)),
      toggle('Спрашивать о непечатавшихся при входе', st.staleMode === 'ask', (v) => (st.staleMode = v ? 'ask' : 'badge'), 'Иначе — красная плашка «просрочен»'),
    );
  }
  openModal({
    title: 'Вкладка', body,
    actions: [
      !tab.builtin ? { label: 'Удалить', kind: 'danger', onClick: async () => { if (await deleteTab(tab)) return true; return false; } } : { label: 'Скрыть', kind: 'ghost', onClick: () => update(() => { tab.hidden = true; S.activeTab = S.tabs.find((t) => !t.hidden).id; }) },
      { label: 'Сохранить', kind: 'primary', onClick: () => update(() => { tab.title = name.value.trim() || tab.title; tab.settings = st; }) },
    ],
  });
}

async function deleteTab(tab) {
  if (!(await confirmDlg('Удалить вкладку?', `«${tab.title}» и все её документы.`, 'Удалить', 'Отмена', true))) return false;
  update((s) => {
    for (const sec of tab.sections) for (const id of sec.items) delete s.docs[id];
    s.tabs = s.tabs.filter((t) => t !== tab);
    if (s.activeTab === tab.id) s.activeTab = s.tabs[0].id;
  });
  return true;
}

export async function createTab() {
  const name = await promptDlg('Новая вкладка', { label: 'Название', placeholder: 'Например: Охрана труда' });
  if (!name) return null;
  const t = makeTab('docs', name);
  update((s) => { s.tabs.push(t); s.activeTab = t.id; });
  return t;
}

async function mergeTabs() {
  const docTabs = S.tabs.filter((t) => isDocs(t) && t.kind === 'docs');
  if (docTabs.length < 2) { toast('Объединять можно вкладки-списки документов, их нужно хотя бы две'); return; }
  const opts = docTabs.map((t) => ({ value: t.id, label: t.title }));
  const v = await formDlg('Объединить вкладки', [
    { key: 'a', label: 'Первая вкладка', options: opts, value: docTabs[0].id },
    { key: 'b', label: 'Вторая вкладка', options: opts, value: docTabs[1].id },
    { key: 'order', label: 'Какая будет выше', options: [{ value: 'a', label: 'Первая выше' }, { value: 'b', label: 'Вторая выше' }], value: 'a' },
  ], 'Объединить');
  if (!v || v.a === v.b) return;
  const top = tabById(v.order === 'a' ? v.a : v.b);
  const bottom = tabById(v.order === 'a' ? v.b : v.a);
  if (!(await confirmDlg('Объединить?', `Вкладка будет называться «${top.title}». Разделы «${bottom.title}» пойдут ниже отдельными разделами.`, 'Объединить'))) return;
  update((s) => {
    const sections = bottom.sections.map((sec) => ({ ...sec, title: bottom.sections.length === 1 ? bottom.title : `${bottom.title}: ${sec.title}` }));
    sections.forEach((sec) => sec.items.forEach((id) => { if (s.docs[id]) s.docs[id].tabId = top.id; }));
    top.sections.push(...sections);
    s.selection[top.id] = [...(s.selection[top.id] || []), ...(s.selection[bottom.id] || [])];
    s.tabs = s.tabs.filter((t) => t !== bottom);
    s.activeTab = top.id;
  });
  toast('Вкладки объединены');
}

export function renderSettings(root, close) {
  const tabsList = h('div', { class: 'settings-tabs' }, S.tabs.map((t, i) => h('div', { class: 'set-tab' + (t.hidden ? ' off' : '') },
    h('div', { class: 'set-tab-name' }, h('strong', null, t.title), h('small', null, KIND_NAMES[t.kind] + (t.hidden ? ' · скрыта' : ''))),
    h('button', { class: 'icon-btn', 'aria-label': 'Выше', disabled: i === 0, onClick: () => update((s) => { [s.tabs[i - 1], s.tabs[i]] = [s.tabs[i], s.tabs[i - 1]]; }) }, icon('up')),
    h('button', { class: 'icon-btn', 'aria-label': 'Ниже', disabled: i === S.tabs.length - 1, onClick: () => update((s) => { [s.tabs[i + 1], s.tabs[i]] = [s.tabs[i], s.tabs[i + 1]]; }) }, icon('down')),
    h('button', { class: 'icon-btn', 'aria-label': t.hidden ? 'Показать' : 'Скрыть', onClick: () => update(() => { t.hidden = !t.hidden; }) }, icon('eye')),
    h('button', { class: 'icon-btn', 'aria-label': 'Настройки вкладки', onClick: () => tabSettingsDlg(t) }, icon('gear')),
  )));

  const d = S.settings.drive;
  const urlIn = h('input', { class: 'input', id: 'drvUrl', placeholder: 'https://script.google.com/macros/s/…/exec', inputmode: 'url' });
  urlIn.value = d.url;
  const keyIn = h('input', { class: 'input', id: 'drvKey', placeholder: 'Ключ из настроек скрипта' });
  keyIn.value = d.key;
  const chatIn = h('input', { class: 'input', id: 'drvChat', placeholder: 'Необязательно', inputmode: 'numeric' });
  chatIn.value = d.chatId;
  const saveDrive = () => update(() => { d.url = urlIn.value.trim(); d.key = keyIn.value.trim(); d.chatId = chatIn.value.trim(); }, { silent: true });
  [urlIn, keyIn, chatIn].forEach((i) => i.addEventListener('input', saveDrive));

  const storageLine = h('p', { class: 'cap' }, 'Считаю…');
  storageInfo().then((info) => {
    storageLine.textContent = info ? `Занято на устройстве: ${fmtSize(info.usage)}${info.persisted ? ' · хранилище закреплено' : ''}` : 'Объём недоступен';
  });

  const user = tgUser();

  root.append(
    h('div', { class: 'tab-head glass' }, h('div', { class: 'tab-head-row' },
      h('h1', { class: 'tab-title' }, 'Настройки'),
      h('button', { class: 'icon-btn glass-btn', 'aria-label': 'Закрыть настройки', onClick: close }, icon('close')),
    )),

    h('section', { class: 'card glass' },
      h('div', { class: 'card-head' }, h('h2', null, 'Вкладки')),
      h('p', { class: 'cap' }, 'Порядок можно менять и здесь, и долгим нажатием на вкладку в нижней панели.'),
      tabsList,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn ghost sm', onClick: createTab }, icon('plus'), 'Новая вкладка'),
        h('button', { class: 'btn ghost sm', onClick: mergeTabs }, 'Объединить вкладки'),
      ),
    ),

    h('section', { class: 'card glass' },
      h('div', { class: 'card-head' }, h('h2', null, 'Отображение')),
      toggle('Плашки «снят с печати» и «просрочен»', S.settings.showBadges, (v) => update(() => { S.settings.showBadges = v; })),
      toggle('Напоминания об обновлении после печати', S.settings.showReminders, (v) => update(() => { S.settings.showReminders = v; })),
      toggle('Карандаши у названий', S.settings.showPencil, (v) => update(() => { S.settings.showPencil = v; }), 'Быстрое переименование'),
      toggle('Упрощённое стекло', S.settings.lowGlass, (v) => update(() => { S.settings.lowGlass = v; }), 'Без размытия — быстрее на слабых телефонах'),
    ),

    h('section', { class: 'card glass' },
      h('div', { class: 'card-head' }, h('h2', null, 'Файлы и печать')),
      h('div', { class: 'field' }, h('label', { for: 'compDef' }, 'Сжатие при загрузке PDF'), (() => {
        const sel = h('select', { class: 'input', id: 'compDef' }, [['auto', 'Автоматически'], ['light', 'Бережное, без потери качества'], ['strong', 'Сильное, 200 dpi'], ['none', 'Без сжатия']].map(([v, l]) => h('option', { value: v, selected: S.settings.compression === v }, l)));
        sel.addEventListener('change', () => update(() => { S.settings.compression = sel.value; }, { silent: true }));
        return sel;
      })(), h('small', { class: 'hint' }, 'Автоматически: тяжёлые сканы переводятся в 200 dpi — для печати этого достаточно, текстовые файлы сжимаются без потерь.')),
      h('div', { class: 'field' }, h('label', { for: 'pmDef' }, 'Печать в новых вкладках'), (() => {
        const sel = h('select', { class: 'input', id: 'pmDef' }, [['duplex', 'Двусторонняя'], ['simplex', 'Односторонняя']].map(([v, l]) => h('option', { value: v, selected: S.settings.defaultPrintMode === v }, l)));
        sel.addEventListener('change', () => update(() => { S.settings.defaultPrintMode = sel.value; }, { silent: true }));
        return sel;
      })()),
    ),

    h('section', { class: 'card glass' },
      h('div', { class: 'card-head' }, h('h2', null, 'Google Диск и Telegram'), driveOn() ? h('span', { class: 'pill on' }, 'подключён') : null),
      h('p', { class: 'cap' }, 'Через ваш скрипт Apps Script файлы хранятся на Google Диске, синхронизируются между телефоном и компьютером, а готовые PDF приходят в чат с ботом. Как настроить — в файле README.'),
      h('div', { class: 'field' }, h('label', { for: 'drvUrl' }, 'Адрес веб-приложения Apps Script'), urlIn),
      h('div', { class: 'field' }, h('label', { for: 'drvKey' }, 'Ключ доступа'), keyIn),
      h('div', { class: 'field' }, h('label', { for: 'drvChat' }, 'ID чата для файлов'), chatIn, h('small', { class: 'hint' }, user ? `В Telegram берётся автоматически: ${user.id}` : 'Нужен, если открываете приложение в браузере, а файлы хотите получать в Telegram')),
      toggle('Автосинхронизация', d.autoSync, (v) => update(() => { d.autoSync = v; }, { silent: true }), 'Копировать файлы и изменения на Диск'),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn ghost sm', onClick: async () => {
          saveDrive();
          try { const r = await withBusy('Проверяю…', ping); toast('Связь есть: ' + (r.folder || 'Диск')); } catch (e) { toast('Нет связи: ' + e.message, 'warn'); }
        } }, 'Проверить'),
        h('button', { class: 'btn ghost sm', disabled: !driveOn(), onClick: uploadAll }, icon('cloud'), 'Сохранить всё на Диск'),
        h('button', { class: 'btn ghost sm', disabled: !driveOn(), onClick: restoreFromDrive }, 'Загрузить с Диска'),
      ),
      syncStatus.last || syncStatus.error ? h('p', { class: 'cap' + (syncStatus.error ? ' warn' : '') }, syncStatus.error ? 'Ошибка синхронизации: ' + syncStatus.error : 'Последняя синхронизация: ' + fmtDateTime(syncStatus.last)) : null,
    ),

    h('section', { class: 'card glass' },
      h('div', { class: 'card-head' }, h('h2', null, 'Данные')),
      storageLine,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn primary sm', onClick: importStarter }, 'Загрузить стартовый пакет'),
        h('button', { class: 'btn ghost sm', onClick: contactsDlg }, 'Справочник контактов'),
        h('button', { class: 'btn ghost sm', onClick: orgDlg }, 'Реквизиты организации'),
      ),
      h('p', { class: 'cap' }, 'Стартовый пакет — файл с вашими контактами, делениями, опорным планом, зонами и шаблонами. Он не хранится в открытом коде приложения.'),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn ghost sm', onClick: async () => { const ok = await requestPersist(); toast(ok ? 'Браузер не будет очищать данные приложения' : 'Браузер не разрешил закрепить хранилище'); } }, 'Закрепить хранилище'),
        h('button', { class: 'btn ghost sm', onClick: exportBackup }, 'Резервная копия'),
        h('button', { class: 'btn ghost sm', onClick: importBackup }, 'Восстановить из копии'),
      ),
      h('p', { class: 'cap' }, inTelegram ? 'Открыто в Telegram.' : 'Открыто в браузере.'),
    ),
  );
}

async function uploadAll() {
  try {
    await withBusy('Сохраняю на Диск…', async (step) => {
      const metas = [];
      for (const d of Object.values(S.docs)) {
        if (d.file) metas.push([d, d.file]);
        for (const v of Object.values(d.variants || {})) if (v) metas.push([d, v]);
      }
      let i = 0;
      for (const [doc, meta] of metas) {
        i++;
        if (meta.driveId) continue;
        step(`Файл ${i} из ${metas.length}`);
        const b = await fileGet(meta.key);
        if (!b) continue;
        const tab = tabById(doc.tabId);
        meta.driveId = await uploadFile(b, meta.name || doc.title + '.pdf', tab ? tab.title : 'Файлы');
      }
      step('Сохраняю настройки…');
      await pushState();
    });
    update(() => {});
    toast('Всё сохранено на Google Диск');
  } catch (e) { toast('Ошибка: ' + e.message, 'warn'); }
}

async function restoreFromDrive() {
  if (!(await confirmDlg('Загрузить с Диска?', 'Данные на этом устройстве заменятся сохранёнными на Диске. Файлы подгрузятся при первом открытии.', 'Загрузить'))) return;
  try {
    const st = await withBusy('Загружаю…', pullState);
    if (!st) { toast('На Диске ещё нет сохранённых данных'); return; }
    st.settings.drive = { ...st.settings.drive, ...S.settings.drive };
    await replaceState(st);
    toast('Данные загружены');
  } catch (e) { toast('Ошибка: ' + e.message, 'warn'); }
}

async function exportBackup() {
  const files = {};
  await withBusy('Готовлю копию…', async () => {
    for (const k of await fileKeys()) files[k] = bytesToBase64(await fileGet(k));
  });
  const blob = new Blob([JSON.stringify({ app: 'pamyatki-osp', state: S, files })], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `pamyatki-backup-${new Date().toISOString().slice(0, 10)}.json`, style: { display: 'none' } });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  if (inTelegram) toast('Если файл не скачался, используйте «Сохранить всё на Диск»');
}

async function importBackup() {
  const [f] = await pickFiles({ accept: 'application/json,.json' });
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'pamyatki-osp') throw new Error('Это не резервная копия приложения');
    if (!(await confirmDlg('Восстановить?', 'Текущие данные заменятся данными из копии.', 'Восстановить'))) return;
    await withBusy('Восстанавливаю…', async () => {
      for (const [k, b64] of Object.entries(data.files || {})) await filePut(k, base64ToBytes(b64));
      await replaceState(data.state);
    });
    toast('Восстановлено');
  } catch (e) { toast('Ошибка: ' + e.message, 'warn'); }
}


// ---------- Справочник контактов ----------
export function contactsDlg() {
  const body = h('div');
  let cur = 'hr';
  const m = openModal({ title: 'Справочник контактов', body, wide: true });
  function draw() {
    body.innerHTML = '';
    body.append(h('div', { class: 'chips' }, Object.entries(CONTACT_LISTS).map(([k, l]) => h('button', { class: 'chip' + (k === cur ? ' on' : ''), onClick: () => { cur = k; draw(); } }, l))));
    const list = S.lists[cur] || [];
    const env = ['hr', 'accountants', 'legal'].includes(cur);
    body.append(h('p', { class: 'cap' }, env ? 'Для конвертов: «Кому» — в дательном падеже (кому?), «Куда» — строки под именем.' : 'Выбираются во вводных сеанса.'));
    list.forEach((c, i) => {
      const f = (key, label, ph, multi) => {
        const id = 'c' + Math.random().toString(36).slice(2, 7);
        const inp = multi ? h('textarea', { class: 'input', id, rows: 2, placeholder: ph || '' }) : h('input', { class: 'input', id, placeholder: ph || '' });
        inp.value = c[key] || '';
        inp.addEventListener('input', () => update(() => { c[key] = inp.value; }, { silent: true }));
        return h('div', { class: 'field' }, h('label', { for: id }, label), inp);
      };
      body.append(h('div', { class: 'contact-card' },
        h('div', { class: 'grid-2' },
          f('name', 'Фамилия Имя'), f('phone', 'Телефон'),
          f('region', 'Регион'),
          env ? f('dative', 'Кому (на конверте)', dative(c.name)) : null,
        ),
        env ? f('address', 'Куда (на конверте)', '', true) : null,
        h('div', { class: 'row-actions' },
          env ? h('button', { class: 'btn ghost sm', onClick: () => { update(() => { c.dative = dative(c.name); }); draw(); } }, 'Склонить заново') : null,
          i > 0 ? h('button', { class: 'btn ghost sm', onClick: () => { update(() => { list.splice(i - 1, 0, list.splice(i, 1)[0]); }); draw(); } }, 'Выше') : null,
          h('button', { class: 'btn ghost sm', onClick: async () => { if (await confirmDlg('Удалить контакт?', c.name, 'Удалить', 'Отмена', true)) { update(() => { list.splice(i, 1); }); draw(); } } }, 'Удалить'),
        ),
      ));
    });
    body.append(h('button', { class: 'btn ghost dashed', onClick: () => { update(() => { (S.lists[cur] = S.lists[cur] || []).push({ name: '', phone: '', region: '', address: '', dative: '' }); }); draw(); } }, icon('plus'), 'Контакт'));
    if (['accountants', 'legal'].includes(cur)) body.append(h('p', { class: 'cap' }, 'На конверт идёт первый контакт в списке.'));
  }
  draw();
  return m;
}

// ---------- Реквизиты организации ----------
export async function orgDlg() {
  const o = S.settings.org;
  const v = await formDlg('Реквизиты для расписки и графика обедов', [
    { key: 'name', label: 'Полное название', value: o.name, placeholder: 'Общество с ограниченной ответственностью «…»' },
    { key: 'short', label: 'Краткое название', value: o.short, placeholder: 'ООО «…»' },
    { key: 'details', label: 'Адрес и коды (под названием)', value: o.details, multiline: true },
    { key: 'order', label: 'Положение о кассовых операциях утверждено', value: o.order, placeholder: 'приказом № … от …' },
    { key: 'returnCopies', label: 'Сколько комплектов табличек возврата печатать', value: String(o.returnCopies || 4), inputmode: 'numeric' },
  ]);
  if (v) update(() => { Object.assign(o, v, { returnCopies: Number(v.returnCopies) || 4 }); });
}

export async function importStarter() {
  const [f] = await pickFiles({ accept: 'application/json,.json' });
  if (!f) return;
  try {
    const pack = JSON.parse(await f.text());
    if (pack.app !== 'pamyatki-osp' || pack.kind !== 'starter') throw new Error('Это не стартовый пакет');
    const r = await withBusy('Загружаю стартовый пакет…', (step) => applyStarter(pack, step));
    toast(`Загружено: ${r.join(', ')}`);
  } catch (e) { toast('Ошибка: ' + e.message, 'warn'); }
}
