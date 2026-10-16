// Синхронизация с Google Диском при запуске: на новом устройстве всё постоянное подтягивается само,
// а файлы, которых ещё нет на Диске, тихо туда докладываются.
import { S, replaceState, update, tabById } from './store.js';
import { driveOn, pullState, pushState, uploadFile, syncGate } from './drive.js';
import { fileGet } from './db.js';
import { toast } from './ui.js';

// Все сохранённые файлы приложения (кроме материалов, они и так живут на Диске)
export function allMetas() {
  const out = [];
  const add = (meta, folder) => { if (meta && meta.key) out.push([meta, folder]); };
  for (const d of Object.values(S.docs)) {
    const tab = tabById(d.tabId);
    const folder = tab ? tab.title : 'Файлы';
    add(d.file, folder); add(d.cover, folder); add(d.pdfBase, folder);
    for (const v of Object.values(d.variants || {})) add(v, folder);
    for (const v of Object.values(d.tplVariants || {})) add(v, folder);
    for (const v of Object.values(d.xvariants || {})) add(v, folder);
  }
  for (const v of Object.values((S.schedule && S.schedule.templates) || {})) add(v, 'Сервисный график');
  add(S.shelves && S.shelves.xlsxTpl, 'Деления');
  return out;
}

const MIME = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

export async function uploadMissing(step) {
  let n = 0;
  const list = allMetas().filter(([m]) => !m.driveId);
  for (const [meta, folder] of list) {
    const b = await fileGet(meta.key);
    if (!b) continue;
    step && step(`На Диск: ${++n} из ${list.length}`);
    meta.driveId = await uploadFile(b, meta.name || 'file', folder, MIME[meta.kind] || 'application/pdf');
  }
  if (n) update(() => {}, { silent: true });
  return n;
}

export async function bootSync() {
  if (!driveOn()) { syncGate.ready = true; return; }
  try {
    const remote = await pullState();
    const local = S;
    const emptyLocal = !local.settings.starterLoaded && !local.session.city && !local.sessions.length;
    if (remote && ((remote.savedAt || 0) > (local.savedAt || 0) || emptyLocal)) {
      remote.settings.drive = { ...remote.settings.drive, ...local.settings.drive };
      await replaceState(remote);
      toast('Данные подтянуты с Google Диска');
    }
  } catch (e) { console.warn('Синхронизация при запуске', e); }
  syncGate.ready = true;
  try {
    const n = await uploadMissing();
    await pushState();
    if (n) console.info('На Диск дозагружено файлов:', n);
  } catch (e) { console.warn('Дозагрузка на Диск', e); }
}
