// Стартовый пакет: контакты, реквизиты, деления, опорный план, зоны и шаблоны пользователя.
// Хранится отдельным файлом, а не в коде, чтобы рабочие данные не попадали в открытый репозиторий.
import { S, update, makeDoc } from './store.js';
import { uid, base64ToBytes } from './util.js';
import { analyze, storeAnalyzed } from './files.js';
import { dative } from './generators.js';

function planTree(rows) {
  const out = [];
  let section = null;
  for (const r of rows) {
    if (r.section) { section = { id: uid(), title: r.section, children: [] }; out.push(section); continue; }
    if (r.divider) { (section ? section.children : out).push({ id: uid(), title: r.divider, divider: true, children: [] }); continue; }
    const node = {
      id: uid(), title: r.title, children: (r.practice || []).map((t) => ({ id: uid(), title: t, children: [] })),
      meta: { num: r.num, printed: r.printed, video: r.video, when: r.when },
    };
    (section ? section.children : out).push(node);
  }
  return out;
}

export async function applyStarter(pack, step = () => {}) {
  const done = [];
  const files = [];
  // файлы готовим до изменения состояния
  for (const f of pack.files || []) {
    step('Файл: ' + f.name);
    const bytes = base64ToBytes(f.base64);
    const file = new File([bytes], f.name);
    const info = /\.xlsx$/i.test(f.name) ? { original: bytes, pages: 0, text: '', name: f.name, kind: 'xlsx' } : await analyze(file);
    const meta = await storeAnalyzed(info, { compression: f.compression || 'light', tabId: 'memos', padEven: f.padEven !== false });
    files.push({ f, meta });
  }
  update((s) => {
    if (pack.org) { Object.assign(s.settings.org, pack.org); done.push('реквизиты'); }
    if (pack.lists) {
      let n = 0;
      for (const [k, arr] of Object.entries(pack.lists)) {
        if (!Array.isArray(arr)) continue;
        s.lists[k] = s.lists[k] || [];
        for (const item of arr) {
          const obj = typeof item === 'string' ? { name: item } : item;
          if (['regions', 'roles', 'cities'].includes(k)) { if (!s.lists[k].includes(obj.name || item)) s.lists[k].push(obj.name || item); continue; }
          const ex = s.lists[k].find((x) => x.name === obj.name);
          const full = { phone: '', region: '', address: '', dative: ['hr', 'accountants', 'legal'].includes(k) ? dative(obj.name) : '', ...obj };
          if (ex) Object.assign(ex, full); else s.lists[k].push(full);
          n++;
        }
      }
      done.push(`контакты (${n})`);
    }
    if (pack.shelves && pack.shelves.length) {
      s.shelves.catalog = pack.shelves.map((c) => ({ id: uid(), name: c.name, sub: c.sub || '', group: c.group, kind: c.kind, width: c.width || '', widthSelectable: !c.width, variants: c.variants, note: c.note || '', src: c.src || '', xl: c.xl || null }));
      const groups = [...new Set(pack.shelves.map((c) => c.group))];
      s.shelves.groupsOrder = [...groups, ...s.shelves.groupsOrder.filter((g) => !groups.includes(g))];
      s.shelves.current.items = {};
      done.push(`деления (${pack.shelves.length})`);
    }
    if (pack.plan && pack.plan.length) {
      s.plan.items = planTree(pack.plan);
      s.plan.done = {};
      done.push(`опорный план (${pack.plan.filter((r) => r.title).length} тем)`);
    }
    if (pack.zones && pack.zones.length) {
      s.schedule.zones = pack.zones.map((z) => ({ id: uid(), ...z }));
      s.schedule.bySession = {};
      done.push(`зоны (${pack.zones.length})`);
    }
    if (pack.schedule) Object.assign(s.schedule, pack.schedule);
    const memos = s.tabs.find((t) => t.id === 'memos');
    const secOf = (key) => memos.sections.find((x) => x.key === key) || memos.sections[memos.sections.length - 1];
    // пустые заглушки (без файла и генератора) в разделах, которые пакет заполняет сам
    for (const key of pack.cleanSections || []) {
      const sec = secOf(key);
      sec.items = sec.items.filter((id) => {
        const d = s.docs[id];
        const keep = d && (d.generator || d.file || Object.keys(d.variants || {}).length || d.key || d.drive);
        if (!keep) delete s.docs[id];
        return keep;
      });
    }
    // документ по ключу: создаём или обновляем, чтобы повторная загрузка пакета не плодила копии
    const docByKey = (spec) => {
      const sec = secOf(spec.section);
      let d = (spec.key ? Object.values(s.docs).find((x) => x.key === spec.key) : null)
        || (spec.generator ? sec.items.map((id) => s.docs[id]).find((x) => x && x.generator === spec.generator) : null);
      if (!d) { d = makeDoc('memos', spec.title); s.docs[d.id] = d; sec.items.push(d.id); }
      for (const k of ['key', 'title', 'when', 'hot', 'process', 'dependsOn', 'generator', 'drive', 'unit']) if (spec[k] !== undefined) d[k] = spec[k];
      return d;
    };
    for (const spec of pack.docs || []) docByKey(spec);
    for (const { f, meta } of files) {
      if (f.schedule) { s.schedule.templates = s.schedule.templates || {}; s.schedule.templates[f.schedule] = meta; continue; }
      if (f.shelvesTpl) { s.shelves.xlsxTpl = meta; continue; }
      if (f.doc) {
        const d = docByKey(f.doc);
        const role = f.role || 'file';
        if (role === 'file') d.file = meta;
        else if (role === 'cover') d.cover = meta;
        else if (role.startsWith('variant:')) { d.variants = d.variants || {}; d.variants[role.slice(8)] = meta; }
        else if (role.startsWith('tpl:')) { d.tplVariants = d.tplVariants || {}; d.tplVariants[role.slice(4)] = meta; }
        else if (role.startsWith('rows:')) { d.xvariants = d.xvariants || {}; d.xvariants[role.slice(5)] = meta; }
        continue;
      }
      const sec = secOf(f.section);
      if (f.generator) {
        const d = sec.items.map((id) => s.docs[id]).find((x) => x && x.generator === f.generator);
        if (d) { d.file = meta; continue; }
      }
      const d = makeDoc('memos', f.title || f.name.replace(/\.[^.]+$/, ''), { file: meta });
      s.docs[d.id] = d;
      sec.items.push(d.id);
    }
    // порядок документов в разделах
    for (const [key, order] of Object.entries(pack.order || {})) {
      const sec = secOf(key);
      const rank = (id) => { const d = s.docs[id]; const i = d ? order.indexOf(d.key || d.generator) : -1; return i < 0 ? 999 : i; };
      sec.items.sort((a, b) => rank(a) - rank(b));
    }
    if (pack.directory) { s.directory = {}; for (const [r, rows] of Object.entries(pack.directory)) s.directory[r] = rows.map((x) => ({ id: uid(), ...x })); done.push('контакты по регионам'); }
    if (pack.kic) { s.lists.kic = pack.kic; done.push(`КИЦ (${pack.kic.length})`); }
    if (pack.materials) Object.assign(s.materials, pack.materials);
    if (pack.sessionDefaults) {
      for (const [k, v] of Object.entries(pack.sessionDefaults.money || {})) if (!s.session.money[k]) s.session.money[k] = v;
      s.settings.sessionDefaults = pack.sessionDefaults;
    }
    if (files.length) done.push(`файлы (${files.length})`);
    s.selection.memos = undefined;
    s.settings.starterLoaded = true;
  });
  return done;
}
