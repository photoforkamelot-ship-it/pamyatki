// Вкладка со списком документов: Инструкции, наборные вкладки, часть «Памяток».
import { h, icon, fmtDate, fmtSize, pages as pagesWord, plural, baseName, uid } from '../util.js';
import { S, update, activeFile, setActiveFile, makeDoc, dependValue, DEPENDS, sessionLabel } from '../store.js';
import { openModal, confirmDlg, choiceDlg, promptDlg, pickFiles, toast, withBusy, menu, toggle } from '../ui.js';
import { analyze, storeAnalyzed, getBytes, dropFile } from '../files.js';
import { buildPrint, renderThumbs, diffText, blocksToPdf } from '../pdf.js';
import { deliver } from '../output.js';
import { GENERATORS, baseValues, templateRuns } from '../generators.js';
import { fillDocx, isDocx } from '../docx.js';
import { renderBlocks } from '../pages.js';
import { tabSettingsDlg } from './settings.js';

// ---------- вспомогательное ----------
// «Не распечатан» — в текущей командировке; «просрочен» — с прошлой командировки
const sid = () => S.session.id;
const isNow = (d) => !!d.skippedSession && d.skippedSession === sid();
const isStale = (d) => !!d.skippedSession && d.skippedSession !== sid();
// Шаблонные памятки: исходный Word-файл пользователя, в котором меняется только текст
const genTplCap = (d) => d.generator && GENERATORS[d.generator] && GENERATORS[d.generator].tpl;
const genWord = (d) => d.generator && GENERATORS[d.generator] && GENERATORS[d.generator].word;
const genTpl = (d) => !!(genTplCap(d) && d.file && isDocx(d.file));
const wordFile = (d) => { const f = activeFile(d); return !d.generator && isDocx(f) ? f : null; };
const isWordDoc = (d) => !!(genTpl(d) || wordFile(d));
const hasContent = (d) => (genWord(d) ? !!d.file : !!(d.generator || activeFile(d)));
const sectionDuplex = (tab, sec) => (sec.printMode || tab.settings.printMode) === 'duplex';

export function tabDocs(tab) {
  const out = [];
  for (const sec of tab.sections) for (const id of sec.items) if (S.docs[id]) out.push({ doc: S.docs[id], sec });
  return out;
}

function getSel(tab) {
  if (!S.selection[tab.id]) {
    S.selection[tab.id] = tabDocs(tab).filter(({ doc }) => hasContent(doc) && !doc.skippedSession).map(({ doc }) => doc.id);
  }
  return new Set(S.selection[tab.id]);
}
function setSel(tab, set) { update((s) => { s.selection[tab.id] = [...set]; }); }

export function staleDocs(tab) {
  return tabDocs(tab).map((x) => x.doc).filter((d) => isStale(d) && !d.generator);
}

// ---------- отрисовка ----------
export function renderDocsTab(tab, root, { top } = {}) {
  const sel = getSel(tab);
  const all = tabDocs(tab);
  const printable = all.filter(({ doc }) => hasContent(doc));
  const selectedCount = printable.filter(({ doc }) => sel.has(doc.id)).length;
  const stale = staleDocs(tab);
  const duplexTab = tab.settings.printMode === 'duplex';

  const head = h('div', { class: 'tab-head glass' },
    h('div', { class: 'tab-head-row' },
      h('div', null,
        h('h1', { class: 'tab-title' }, tab.title),
        h('p', { class: 'tab-sub' }, `${all.length} ${plural(all.length, 'документ', 'документа', 'документов')} · ${duplexTab ? 'двусторонняя печать' : 'односторонняя печать'}`),
      ),
      h('button', { class: 'icon-btn glass-btn', 'aria-label': 'Настройки вкладки', onClick: () => tabSettingsDlg(tab) }, icon('gear')),
    ),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn ghost sm', onClick: () => {
        const allOn = printable.every(({ doc }) => sel.has(doc.id));
        const next = new Set(sel);
        printable.forEach(({ doc }) => (allOn ? next.delete(doc.id) : next.add(doc.id)));
        setSel(tab, next);
      } }, printable.length && printable.every(({ doc }) => sel.has(doc.id)) ? 'Снять все' : 'Выбрать все'),
      h('button', { class: 'btn ghost sm', onClick: () => addFiles(tab, tab.sections[tab.sections.length - 1] || null) }, icon('upload'), 'Добавить'),
      h('button', { class: 'btn primary sm grow', disabled: !selectedCount, onClick: () => printSelected(tab) }, icon('print'), `Печать${selectedCount ? ' · ' + selectedCount : ''}`),
    ),
  );

  const banner = stale.length && S.settings.showBadges
    ? h('button', { class: 'banner stale', onClick: () => runUpdateWizard(tab, stale) },
      h('strong', null, `${stale.length} ${plural(stale.length, 'документ просрочен', 'документа просрочены', 'документов просрочены')}`),
      h('span', null, 'Не печатались в прошлый раз. Нажмите, чтобы проверить и обновить по очереди.'))
    : null;

  const sections = tab.sections.map((sec) => renderSection(tab, sec, sel));

  const addSection = h('button', { class: 'btn ghost dashed', onClick: async () => {
    const name = await promptDlg('Новый раздел', { label: 'Название раздела' });
    if (name) update((s) => { s.tabs.find((t) => t.id === tab.id).sections.push({ id: uid(), title: name, items: [], printMode: '' }); });
  } }, icon('plus'), 'Раздел');

  root.append(...[head, top, banner, ...sections, addSection].filter(Boolean));

  if (tab.settings.staleMode === 'ask' && stale.length && S.staleAsked[tab.id] !== sid()) {
    S.staleAsked[tab.id] = sid();
    setTimeout(() => askStale(tab, stale), 250);
  }
}

function renderSection(tab, sec, sel) {
  const duplex = sectionDuplex(tab, sec);
  const items = sec.items.map((id) => S.docs[id]).filter(Boolean);
  const list = h('div', { class: 'doc-list' }, items.length ? items.map((d) => renderRow(tab, sec, d, sel)) : h('p', { class: 'empty' }, 'Пока пусто. Добавьте PDF-файлы.'));
  return h('section', { class: 'card glass' },
    h('div', { class: 'card-head' },
      h('h2', null, sec.title, sec.printMode ? h('span', { class: 'pill' }, duplex ? 'двусторонняя' : 'односторонняя') : null),
      h('div', { class: 'card-actions' },
        (sec.collage || items.length > 2) && items.some(hasContent) ? h('button', { class: 'icon-btn', 'aria-label': 'Просмотр раздела', onClick: () => collage(tab, sec) }, icon('eye')) : null,
        h('button', { class: 'icon-btn', 'aria-label': 'Добавить файлы в раздел', onClick: () => addFiles(tab, sec) }, icon('plus')),
        h('button', { class: 'icon-btn', 'aria-label': 'Действия с разделом', onClick: () => sectionMenu(tab, sec) }, icon('more')),
      ),
    ),
    list,
  );
}

function renderRow(tab, sec, d, sel) {
  const file = activeFile(d);
  const content = hasContent(d);
  const duplex = sectionDuplex(tab, sec);
  const checkId = 'c' + d.id;
  let meta = [];
  let needs = null;
  if (genTplCap(d)) {
    if (d.file) meta.push('ваш Word-шаблон · меняются только ОСП, адрес, ФИО');
    else if (genWord(d)) needs = 'Загрузите Word-шаблон';
    else meta.push('шаблон не загружен — печатается упрощённая версия');
  }
  else if (d.generator) meta.push('собирается из вводных');
  else if (d.dependsOn && !dependValue(d.dependsOn)) needs = `Выберите во вводных: ${DEPENDS.find((x) => x.value === d.dependsOn).label.replace('От ', '').toLowerCase()}`;
  else if (!file) needs = d.dependsOn ? `Нет файла для «${dependValue(d.dependsOn)}»` : 'Нет файла';
  if (d.dependsOn && dependValue(d.dependsOn)) meta.unshift(dependValue(d.dependsOn));
  if (file && isDocx(file)) {
    meta.push('загружено ' + fmtDate(file.uploadedAt), 'Word' + (file.tags && file.tags.length ? ` · меток: ${file.tags.length}` : ''), fmtSize(file.size));
  } else if (file) {
    meta.push('загружено ' + fmtDate(file.uploadedAt));
    const pad = duplex && file.padEven !== false && file.pages % 2;
    meta.push(pagesWord(file.pages) + (pad ? ' (+1 пустая)' : ''));
    meta.push(fmtSize(file.size));
  }

  const badges = [];
  if (S.settings.showBadges) {
    if (isNow(d)) badges.push(h('span', { class: 'badge yellow' }, 'не распечатан'));
    if (isStale(d)) badges.push(h('button', { class: 'badge red', onClick: (e) => { e.stopPropagation(); runUpdateWizard(tab, [d]); } }, 'просрочен'));
  }

  const cb = h('input', { type: 'checkbox', id: checkId, class: 'check', disabled: !content });
  cb.checked = content && sel.has(d.id);
  cb.addEventListener('change', () => {
    const next = getSel(tab);
    cb.checked ? next.add(d.id) : next.delete(d.id);
    setSel(tab, next);
  });

  return h('div', { class: 'doc-row' + (isNow(d) ? ' is-skipped' : '') + (isStale(d) ? ' is-stale' : '') + (!content ? ' is-empty' : '') },
    h('label', { class: 'check-wrap', for: checkId }, cb, h('span', { class: 'check-box', 'aria-hidden': 'true' })),
    h('div', { class: 'doc-main' },
      h('div', { class: 'doc-title-row' },
        h('button', { class: 'doc-title', onClick: () => content ? preview(tab, d) : uploadInto(tab, d) }, d.title),
        S.settings.showPencil ? h('button', { class: 'pencil', 'aria-label': 'Переименовать', onClick: () => rename(d) }, icon('pencil')) : null,
        ...badges,
      ),
      needs ? h('button', { class: 'doc-needs', onClick: () => (d.dependsOn && !dependValue(d.dependsOn)) ? toast('Заполните вводные в начале вкладки «Памятки»') : uploadInto(tab, d) }, needs, d.dependsOn && !dependValue(d.dependsOn) ? null : ' · загрузить') : null,
      meta.length ? h('div', { class: 'doc-meta' }, meta.join(' · ')) : null,
    ),
    tab.settings.perItemPrint && content ? h('button', { class: 'icon-btn', 'aria-label': 'Печать документа', onClick: () => printDocs(tab, [{ doc: d, sec }], { single: true }) }, icon('print')) : null,
    h('button', { class: 'icon-btn', 'aria-label': 'Действия', onClick: () => docMenu(tab, sec, d) }, icon('more')),
  );
}

// ---------- меню ----------
function docMenu(tab, sec, d) {
  const file = activeFile(d);
  menu(d.title, [
    !d.generator ? { label: file ? 'Обновить файл' : 'Загрузить файл', onClick: () => (file ? runUpdateWizard(tab, [d]) : uploadInto(tab, d)) } : null,
    hasContent(d) ? { label: 'Просмотр', onClick: () => preview(tab, d) } : null,
    { label: 'Переименовать', onClick: () => rename(d) },
    !d.generator ? { label: 'Зависимость от вводных: ' + DEPENDS.find((x) => x.value === (d.dependsOn || '')).label.toLowerCase(), onClick: () => setDepends(d) } : null,
    file && sectionDuplex(tab, sec) && file.pages % 2 ? { label: file.padEven === false ? 'Добавлять пустую страницу до чётного' : 'Не добавлять пустую страницу', onClick: () => update(() => { file.padEven = file.padEven === false; }) } : null,
    tab.sections.length > 1 ? { label: 'Переместить в другой раздел', onClick: () => moveDoc(tab, sec, d) } : null,
    { label: 'Выше', onClick: () => moveInSection(tab, sec, d, -1) },
    { label: 'Ниже', onClick: () => moveInSection(tab, sec, d, 1) },
    isStale(d) || isNow(d) ? { label: 'Отметить как актуальный', onClick: () => update(() => { d.skippedSession = null; }) } : null,
    { label: 'Удалить', danger: true, onClick: () => removeDoc(tab, sec, d) },
  ]);
}

function sectionMenu(tab, sec) {
  menu(sec.title, [
    { label: 'Переименовать раздел', onClick: async () => { const n = await promptDlg('Название раздела', { value: sec.title }); if (n) update(() => { sec.title = n; }); } },
    { label: 'Печать раздела: ' + (sec.printMode === 'duplex' ? 'двусторонняя' : sec.printMode === 'simplex' ? 'односторонняя' : 'как у вкладки'), onClick: async () => {
      const v = await choiceDlg('Печать раздела', 'Двусторонняя добивает каждый документ до чётного числа страниц.', [
        { label: 'Как у вкладки', value: '' }, { label: 'Односторонняя', value: 'simplex' }, { label: 'Двусторонняя', value: 'duplex', kind: 'primary' },
      ]);
      if (v !== undefined) update(() => { sec.printMode = v; });
    } },
    { label: 'Добавить пустой пункт', onClick: async () => {
      const n = await promptDlg('Новый пункт', { label: 'Название (файл можно загрузить позже)' });
      if (n) update((s) => { const d = makeDoc(tab.id, n); s.docs[d.id] = d; sec.items.push(d.id); });
    } },
    { label: 'Напечатать раздел', onClick: () => printDocs(tab, sec.items.map((id) => ({ doc: S.docs[id], sec })).filter((x) => x.doc && hasContent(x.doc)), { title: sec.title }) },
    { label: 'Раздел выше', onClick: () => moveSection(tab, sec, -1) },
    { label: 'Раздел ниже', onClick: () => moveSection(tab, sec, 1) },
    { label: 'Удалить раздел', danger: true, onClick: async () => {
      if (!(await confirmDlg('Удалить раздел?', `«${sec.title}» и ${sec.items.length} ${plural(sec.items.length, 'документ', 'документа', 'документов')} в нём.`, 'Удалить', 'Отмена', true))) return;
      for (const id of sec.items) { const d = S.docs[id]; if (d) { await dropAll(d); } }
      update((s) => { sec.items.forEach((id) => delete s.docs[id]); tab.sections = tab.sections.filter((x) => x !== sec); });
    } },
  ]);
}

async function dropAll(d) {
  await dropFile(d.file);
  for (const v of Object.values(d.variants || {})) await dropFile(v);
}

async function rename(d) {
  const n = await promptDlg('Название', { value: d.title });
  if (n) update(() => { d.title = n; });
}

async function setDepends(d) {
  const v = await choiceDlg('Зависимость от вводных', 'Для каждого значения (например, для каждого склада) хранится свой файл. При печати берётся файл для текущего сеанса.', DEPENDS.map((x) => ({ label: x.label, value: x.value, kind: x.value === (d.dependsOn || '') ? 'primary' : 'ghost' })));
  if (v === undefined) return;
  update(() => {
    if (!d.dependsOn && v && d.file) { const cur = dependValue(v); if (cur) d.variants[cur] = d.file; d.file = null; }
    d.dependsOn = v;
  });
}

async function moveDoc(tab, sec, d) {
  const target = await choiceDlg('Переместить в раздел', null, tab.sections.filter((x) => x !== sec).map((x) => ({ label: x.title, value: x.id })));
  if (!target) return;
  update(() => {
    sec.items = sec.items.filter((id) => id !== d.id);
    tab.sections.find((x) => x.id === target).items.push(d.id);
  });
}

function moveInSection(tab, sec, d, dir) {
  update(() => {
    const i = sec.items.indexOf(d.id), j = i + dir;
    if (j < 0 || j >= sec.items.length) return;
    [sec.items[i], sec.items[j]] = [sec.items[j], sec.items[i]];
  });
}

function moveSection(tab, sec, dir) {
  update(() => {
    const i = tab.sections.indexOf(sec), j = i + dir;
    if (j < 0 || j >= tab.sections.length) return;
    [tab.sections[i], tab.sections[j]] = [tab.sections[j], tab.sections[i]];
  });
}

async function removeDoc(tab, sec, d) {
  if (!(await confirmDlg('Удалить документ?', `«${d.title}» будет удалён вместе с файлом.`, 'Удалить', 'Отмена', true))) return;
  await dropAll(d);
  update((s) => { sec.items = sec.items.filter((id) => id !== d.id); delete s.docs[d.id]; });
}

// ---------- загрузка ----------
async function oddChoice(count, duplex) {
  if (!duplex || !count) return true;
  const v = await choiceDlg(
    count === 1 ? 'Нечётное число страниц' : `${count} ${plural(count, 'файл', 'файла', 'файлов')} с нечётным числом страниц`,
    'Добавить пустую страницу до чётного? Тогда при двусторонней печати следующий документ начнётся с нового листа.',
    [{ label: 'Не добавлять', value: false }, { label: 'Добавить', value: true, kind: 'primary' }],
  );
  return v !== false;
}

export async function addFiles(tab, sec) {
  if (!sec) {
    update((s) => { tab.sections.push({ id: uid(), title: 'Документы', items: [], printMode: '' }); });
    sec = tab.sections[tab.sections.length - 1];
  }
  const files = await pickFiles({ multiple: true, accept: 'application/pdf,.pdf,.docx' });
  if (!files.length) return;
  const infos = [];
  await withBusy('Разбираю файлы…', async (step) => {
    for (const [i, f] of files.entries()) {
      step(`Файл ${i + 1} из ${files.length}: ${f.name}`);
      try { infos.push(await analyze(f)); } catch (e) { toast(`«${f.name}» не открылся как PDF`, 'warn'); }
    }
  });
  if (!infos.length) return;
  const pad = await oddChoice(infos.filter((x) => x.pages % 2).length, sectionDuplex(tab, sec));
  let before = 0, after = 0;
  const created = [];
  await withBusy('Сохраняю…', async (step) => {
    for (const [i, info] of infos.entries()) {
      const meta = await storeAnalyzed(info, { padEven: pad, tabId: tab.id, onStep: (t) => step(`${i + 1}/${infos.length}: ${t}`) });
      before += meta.origSize; after += meta.size;
      const d = makeDoc(tab.id, baseName(info.name), { file: meta });
      created.push(d);
    }
  });
  update((s) => {
    for (const d of created) { s.docs[d.id] = d; sec.items.push(d.id); }
    const set = new Set(s.selection[tab.id] || []);
    created.forEach((d) => set.add(d.id));
    s.selection[tab.id] = [...set];
  });
  toast(after < before * 0.95 ? `Добавлено: ${created.length}. Сжато ${fmtSize(before)} → ${fmtSize(after)}` : `Добавлено: ${created.length}`);
}

async function uploadInto(tab, d) {
  if (genTplCap(d)) return uploadTemplate(tab, d);
  if (d.dependsOn && !dependValue(d.dependsOn)) { toast('Сначала заполните вводные в начале вкладки «Памятки»', 'warn'); return; }
  const [f] = await pickFiles();
  if (!f) return;
  const sec = tab.sections.find((s) => s.items.includes(d.id));
  let info;
  try { info = await withBusy('Читаю файл…', (step) => analyze(f, step)); } catch (e) { toast('Файл не открылся как PDF', 'warn'); return; }
  const pad = await oddChoice(info.pages % 2 ? 1 : 0, sectionDuplex(tab, sec));
  const meta = await withBusy('Сохраняю…', (step) => storeAnalyzed(info, { padEven: pad, tabId: tab.id, onStep: step }));
  update((s) => {
    setActiveFile(d, meta);
    d.skippedSession = null;
    const set = new Set(s.selection[tab.id] || []); set.add(d.id); s.selection[tab.id] = [...set];
  });
  toast('Файл загружен');
}

// ---------- печать ----------
// Шаблон Word для «Наклеек»
async function uploadTemplate(tab, d) {
  const [f] = await pickFiles({ accept: '.docx' });
  if (!f) return;
  if (!/\.docx$/i.test(f.name)) { toast('Нужен файл Word (.docx)', 'warn'); return; }
  const info = await withBusy('Читаю шаблон…', (step) => analyze(f, step));
  const meta = await withBusy('Сохраняю…', (step) => storeAnalyzed(info, { tabId: tab.id, onStep: step }));
  const prev = d.file;
  update((st) => { d.file = meta; d.skippedSession = null; const set = new Set(st.selection[tab.id] || []); set.add(d.id); st.selection[tab.id] = [...set]; });
  if (prev) dropFile(prev);
  toast(info.tags && info.tags.length ? `Шаблон загружен, меток: ${info.tags.length}` : 'Шаблон загружен, но меток {{…}} в нём не найдено', info.tags && info.tags.length ? '' : 'warn');
}

// Все заполненные Word-файлы документа (для конверта кадровику — по одному на кадровика)
async function wordOutputs(doc) {
  const tpl = genTpl(doc);
  const file = tpl ? doc.file : activeFile(doc);
  const bytes = await getBytes(file);
  const runs = tpl ? templateRuns(doc.generator, S.session) : [{ suffix: '', values: baseValues(S.session) }];
  const out = [];
  for (const r of runs) {
    const f = await fillDocx(bytes, r.values);
    out.push({ name: [doc.title, r.suffix].filter(Boolean).join(' — '), bytes: f.bytes, missing: f.missing });
  }
  return out;
}

// Несколько файлов — одним архивом
async function deliverFiles(files, archiveName) {
  if (!files.length) return;
  if (files.length === 1) {
    const f = files[0];
    return deliver(f.bytes, `${f.name} — ${sessionLabel(S.session)}`, { word: true, note: f.missing && f.missing.length ? 'Не заполнены метки: ' + f.missing.join(', ') : '' });
  }
  const JSZip = await ensureZip();
  const zip = new JSZip();
  const used = new Set();
  for (const f of files) {
    let n = f.name.replace(/[\\/:*?"<>|]+/g, ' ').trim();
    while (used.has(n)) n += ' (2)';
    used.add(n);
    zip.file(n + '.docx', f.bytes);
  }
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return deliver(bytes, archiveName, { zip: true, note: `В архиве ${files.length} файлов Word.` });
}
async function ensureZip() {
  if (window.JSZip) return window.JSZip;
  await new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = new URL('../../vendor/jszip.min.js', import.meta.url).href; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); });
  return window.JSZip;
}

export function genBlocks(doc) {
  const g = GENERATORS[doc.generator];
  return { blocks: g.build(S.session), opts: g.opts || {} };
}

async function partsFor(tab, list) {
  const parts = [];
  for (const { doc, sec } of list) {
    const duplex = sectionDuplex(tab, sec);
    if (isWordDoc(doc)) continue;
    if (doc.generator) {
      const { blocks, opts } = genBlocks(doc);
      const { pngs, size } = await blocksToPdf(blocks, { footer: '', ...opts });
      parts.push({ title: doc.title, section: sec.title, pngs, size, duplex });
    } else {
      const file = activeFile(doc);
      const bytes = await getBytes(file);
      parts.push({ title: doc.title, section: sec.title, bytes, duplex: duplex && file.padEven !== false });
    }
  }
  return parts;
}

export async function printDocs(tab, list, { single = false, title } = {}) {
  if (!list.length) return null;
  const duplex = tab.settings.printMode === 'duplex';
  // Word-документы (ваши шаблоны) выдаются как есть, в формате Word; несколько — архивом
  const words = list.filter(({ doc }) => isWordDoc(doc));
  list = list.filter(({ doc }) => !isWordDoc(doc));
  if (words.length) {
    try {
      const files = await withBusy('Заполняю шаблоны Word…', async () => (await Promise.all(words.map(({ doc }) => wordOutputs(doc)))).flat());
      update(() => { words.forEach(({ doc }) => { doc.lastPrinted = new Date().toISOString(); doc.skippedSession = null; }); });
      await deliverFiles(files, `${title || tab.title} — Word — ${sessionLabel(S.session)}`);
    } catch (e) { toast('Word: ' + e.message, 'warn'); }
  }
  if (!list.length) return words.length ? true : null;
  try {
    const bytes = await withBusy('Собираю файл…', async (step) => {
      const parts = await partsFor(tab, list);
      const multiSection = new Set(list.map((x) => x.sec.id)).size > 1;
      if (!multiSection) parts.forEach((p) => (p.section = ''));
      return buildPrint({
        parts,
        cover: !single && tab.settings.cover ? { title: title || tab.title, subtitle: [sessionLabel(S.session), fmtDate(new Date())].filter(Boolean).join(' · ') } : null,
        duplexCover: duplex,
        onProgress: (i, n, t) => step(`Документ ${i} из ${n}: ${t}`),
      });
    });
    const name = single ? list[0].doc.title : `${title || tab.title} — ${sessionLabel(S.session)} — ${fmtDate(new Date())}`;
    update(() => { list.forEach(({ doc }) => { doc.lastPrinted = new Date().toISOString(); if (!single) doc.skippedSession = null; }); });
    await deliver(bytes, name, { duplex: list.some(({ sec }) => sectionDuplex(tab, sec)) });
    return bytes;
  } catch (e) {
    console.error(e);
    toast('Не удалось собрать файл: ' + e.message, 'warn');
    return null;
  }
}

async function printSelected(tab) {
  const sel = getSel(tab);
  const all = tabDocs(tab).filter(({ doc }) => hasContent(doc));
  const chosen = all.filter(({ doc }) => sel.has(doc.id));
  const skipped = all.filter(({ doc }) => !sel.has(doc.id) && !doc.generator).map(({ doc }) => doc);
  const res = await printDocs(tab, chosen);
  if (!res) return;
  update(() => { skipped.forEach((d) => { if (!isStale(d)) d.skippedSession = sid(); }); });
  if (skipped.length && S.settings.showReminders) {
    const go = await confirmDlg(
      `Не напечатано: ${skipped.length}`,
      'Эти документы сняты с печати и подсвечены жёлтым. Если они устарели, замените их сейчас по очереди. При следующем заходе у них появится плашка «просрочен».',
      'Обновить по очереди', 'Позже',
    );
    if (go) runUpdateWizard(tab, skipped);
  }
}

// ---------- просроченные ----------
async function askStale(tab, stale) {
  const list = h('ul', { class: 'plain-list' }, stale.map((d) => h('li', null, d.title)));
  const v = await choiceDlg('В прошлый раз не печатались', h('div', null,
    h('p', { class: 'muted-p' }, 'С ними всё в порядке или они потеряли актуальность и их нужно обновить?'), list),
  [
    { label: 'Позже', value: 'later' },
    { label: 'Всё в порядке', value: 'ok' },
    { label: 'Обновить', value: 'update', kind: 'primary' },
  ]);
  if (v === 'ok') {
    update((s) => {
      const set = new Set(s.selection[tab.id] || []);
      stale.forEach((d) => { d.skippedSession = null; set.add(d.id); });
      s.selection[tab.id] = [...set];
    });
    toast('Отмечены как актуальные');
  } else if (v === 'update') runUpdateWizard(tab, stale);
}

// ---------- мастер обновления ----------
export async function runUpdateWizard(tab, docs) {
  for (let i = 0; i < docs.length; i++) {
    const r = await updateOne(tab, docs[i], i + 1, docs.length);
    if (r === 'stop') break;
  }
}

function updateOne(tab, d, idx, total) {
  return new Promise((resolve) => {
    const sec = tab.sections.find((s) => s.items.includes(d.id)) || tab.sections[0];
    const duplex = sectionDuplex(tab, sec);
    const old = activeFile(d);
    const body = h('div', { class: 'wizard' });
    let info = null;
    let padEven = true;
    let comp = S.settings.compression;

    const m = openModal({ title: `Обновление ${idx} из ${total}`, body, wide: true, onClose: (v) => resolve(v || 'skip') });

    function step1() {
      body.innerHTML = '';
      body.append(
        h('h3', { class: 'wiz-doc' }, d.title),
        old ? h('p', { class: 'muted-p' }, `Сейчас: ${old.name || 'файл'} · загружен ${fmtDate(old.uploadedAt)} · ${pagesWord(old.pages)}`) : h('p', { class: 'muted-p' }, 'Файла пока нет.'),
        h('p', { class: 'note' }, 'Выберите новую версию PDF. Перед заменой покажу превью и что изменилось.'),
      );
      m.setActions([
        { label: 'Остановить', kind: 'ghost', value: 'stop' },
        { label: 'Пропустить', kind: 'ghost', value: 'skip' },
        old ? { label: 'Всё в порядке', kind: 'ghost', onClick: () => { update(() => { d.skippedSession = null; }); }, value: 'ok' } : null,
        { label: 'Выбрать файл', kind: 'primary', keepOpen: true, onClick: choose },
      ]);
    }

    async function choose() {
      const [f] = await pickFiles();
      if (!f) return;
      try {
        info = await withBusy('Сравниваю версии…', (step) => analyze(f, step));
      } catch (e) { toast('Файл не открылся как PDF', 'warn'); return; }
      padEven = true;
      await step2();
    }

    async function step2() {
      body.innerHTML = '';
      const thumbsNew = h('div', { class: 'thumbs' });
      const thumbsOld = h('div', { class: 'thumbs' });
      const diff = old ? diffText(old.text, info.text) : null;
      const rows = [
        ['Страниц', old ? `${old.pages} → ${info.pages}` : String(info.pages)],
        ['Размер', old ? `${fmtSize(old.size)} → ${fmtSize(info.original.length)} (до сжатия)` : fmtSize(info.original.length)],
      ];
      const summary = h('dl', { class: 'summary' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
      let diffNode = null;
      if (diff && diff.hasText) {
        const same = !diff.added.length && !diff.removed.length;
        diffNode = h('div', { class: 'diff' },
          h('p', { class: same ? 'note' : 'note strong' }, same ? 'Текст не изменился. Возможно, поменялось только оформление.' : `Новых строк: ${diff.added.length}, удалённых: ${diff.removed.length}`),
          diff.added.length ? h('details', null, h('summary', null, 'Что добавилось'), h('ul', { class: 'diff-list add' }, diff.added.slice(0, 15).map((l) => h('li', null, l)))) : null,
          diff.removed.length ? h('details', null, h('summary', null, 'Что убрали'), h('ul', { class: 'diff-list del' }, diff.removed.slice(0, 15).map((l) => h('li', null, l)))) : null,
        );
      } else if (old) {
        diffNode = h('p', { class: 'note' }, 'Текст в файле не распознаётся (скан или картинка). Сравните по превью.');
      }
      const padRow = duplex && info.pages % 2 ? toggle('Добавить пустую страницу до чётного', padEven, (v) => (padEven = v), 'Для двусторонней печати') : null;
      const compSel = h('select', { class: 'input', id: 'compSel' }, [
        ['auto', 'Автоматически'], ['light', 'Бережное (без потери качества)'], ['strong', 'Сильное (200 dpi)'], ['none', 'Без сжатия'],
      ].map(([v, l]) => h('option', { value: v, selected: v === comp }, l)));
      compSel.addEventListener('change', () => (comp = compSel.value));

      body.append(
        h('h3', { class: 'wiz-doc' }, d.title),
        h('div', { class: 'compare' },
          old ? h('div', null, h('p', { class: 'cap' }, 'Было'), thumbsOld) : null,
          h('div', null, h('p', { class: 'cap' }, old ? 'Станет' : 'Новый файл'), thumbsNew),
        ),
        summary, diffNode, padRow,
        h('div', { class: 'field' }, h('label', { for: 'compSel' }, 'Сжатие'), compSel),
      );
      m.setActions([
        { label: 'Пропустить', kind: 'ghost', value: 'skip' },
        { label: 'Другой файл', kind: 'ghost', keepOpen: true, onClick: choose },
        { label: 'Заменить', kind: 'primary', keepOpen: true, onClick: replace },
      ]);
      renderThumbs(info.original, { count: 2, width: 130 }).then((cs) => thumbsNew.append(...cs)).catch(() => {});
      if (old) getBytes(old).then((b) => renderThumbs(b, { count: 2, width: 130 })).then((cs) => thumbsOld.append(...cs)).catch(() => thumbsOld.append(h('p', { class: 'note' }, 'Старый файл недоступен')));
    }

    async function replace() {
      const ok = await confirmDlg('Заменить файл?', `«${d.title}» будет заменён новой версией. Старая версия удалится.`, 'Заменить');
      if (!ok) return;
      try {
        const meta = await withBusy('Сохраняю новую версию…', (step) => storeAnalyzed(info, { padEven, compression: comp, tabId: tab.id, onStep: step }));
        const prev = activeFile(d);
        update((s) => {
          setActiveFile(d, meta);
          d.skippedSession = null;
          const set = new Set(s.selection[tab.id] || []); set.add(d.id); s.selection[tab.id] = [...set];
        });
        if (prev) dropFile(prev);
        toast(meta.size < meta.origSize * 0.95 ? `Заменено. Сжато ${fmtSize(meta.origSize)} → ${fmtSize(meta.size)}` : 'Заменено');
        m.close('done');
      } catch (e) { toast('Ошибка: ' + e.message, 'warn'); }
    }

    step1();
  });
}

// ---------- просмотр ----------
async function docImages(d, width) {
  if (isWordDoc(d)) {
    const f = genTpl(d) ? d.file : activeFile(d);
    return [h('div', { class: 'note' }, 'Word-файл. Предпросмотр недоступен — нажмите «Печать», чтобы получить заполненный файл. ' + (f && f.tags && f.tags.length ? 'Метки: ' + f.tags.map((t) => '{{' + t + '}}').join(', ') : ''))];
  }
  if (d.generator) {
    const { blocks, opts } = genBlocks(d);
    const canv = await renderBlocks(blocks, opts);
    return canv.map((c) => { const img = h('img', { src: c.toDataURL('image/png'), alt: d.title, style: { width: width + 'px' } }); return img; });
  }
  const b = await getBytes(activeFile(d));
  return renderThumbs(b, { count: 12, width });
}

async function preview(tab, d) {
  const grid = h('div', { class: 'thumbs big' }, h('div', { class: 'spinner' }));
  const sec = tab.sections.find((s) => s.items.includes(d.id));
  openModal({
    title: d.title, body: grid, wide: true,
    actions: [{ label: 'Печать', kind: 'primary', onClick: () => printDocs(tab, [{ doc: d, sec }], { single: true }) }],
  });
  try {
    const imgs = await docImages(d, 170);
    grid.innerHTML = '';
    grid.append(...imgs);
  } catch (e) { grid.innerHTML = ''; grid.append(h('p', { class: 'note warn' }, e.message)); }
}

async function collage(tab, sec) {
  const docs = sec.items.map((id) => S.docs[id]).filter((d) => d && hasContent(d));
  const grid = h('div', { class: 'collage' });
  openModal({
    title: sec.title, body: grid, wide: true,
    actions: [{ label: 'Напечатать раздел', kind: 'primary', onClick: () => printDocs(tab, docs.map((doc) => ({ doc, sec })), { title: sec.title }) }],
  });
  for (const d of docs) {
    const cell = h('figure', { class: 'collage-cell' }, h('div', { class: 'spinner sm' }), h('figcaption', null, d.title));
    grid.appendChild(cell);
    docImages(d, 150).then((imgs) => { cell.firstChild.replaceWith(imgs[0] || h('span')); }).catch(() => cell.firstChild.remove());
  }
}
