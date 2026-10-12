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
    const meta = await storeAnalyzed(info, { compression: 'light', tabId: 'memos' });
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
      s.shelves.catalog = pack.shelves.map((c) => ({ id: uid(), name: c.name, sub: c.sub || '', group: c.group, kind: c.kind, width: c.width || '', widthSelectable: !c.width, variants: c.variants, note: c.note || '' }));
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
    for (const { f, meta } of files) {
      if (f.schedule) { s.schedule.templates = s.schedule.templates || {}; s.schedule.templates[f.schedule] = meta; continue; }
      const sec = memos.sections.find((x) => x.key === f.section) || memos.sections[memos.sections.length - 1];
      if (f.generator) {
        const d = sec.items.map((id) => s.docs[id]).find((x) => x && x.generator === f.generator);
        if (d) { d.file = meta; continue; }
      }
      const d = makeDoc('memos', f.title || f.name.replace(/\.[^.]+$/, ''), { file: meta });
      s.docs[d.id] = d;
      sec.items.push(d.id);
    }
    if (files.length) done.push(`файлы (${files.length})`);
    s.selection.memos = undefined;
    s.settings.starterLoaded = true;
  });
  return done;
}
