// Связь с Google Диском через собственный веб-скрипт Apps Script (см. apps-script/Code.gs).
import { S, onSaved } from './store.js';
import { tgInitData, tgUser } from './tg.js';
import { bytesToBase64, base64ToBytes, debounce } from './util.js';

export function driveOn() {
  return !!(S.settings.drive && S.settings.drive.url);
}

export async function call(action, payload = {}) {
  const d = S.settings.drive;
  if (!d.url) throw new Error('Google Диск не подключён');
  // Тип text/plain — запрос без предварительной проверки CORS, Apps Script его принимает
  const res = await fetch(d.url, {
    method: 'POST',
    body: JSON.stringify({ action, key: d.key || '', initData: tgInitData(), ...payload }),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('Диск ответил ошибкой ' + res.status);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Ошибка скрипта');
  return json;
}

export const ping = () => call('ping');

export async function uploadFile(bytes, name, folder, mime = 'application/pdf') {
  const r = await call('putFile', { name, folder, mime, base64: bytesToBase64(bytes) });
  return r.id;
}

export async function downloadFile(id) {
  const r = await call('getFile', { id });
  return base64ToBytes(r.base64);
}

export async function removeFile(id) {
  try { await call('trashFile', { id }); } catch (e) { console.warn(e); }
}

export async function saveForPrint(bytes, name, mime = 'application/pdf') {
  const r = await call('putFile', { name, folder: 'Печать', mime, base64: bytesToBase64(bytes) });
  return r.url;
}

export async function sendToChat(bytes, name, caption) {
  const user = tgUser();
  const chatId = S.settings.drive.chatId || (user ? user.id : '');
  return call('sendDocument', { name, caption, chatId, base64: bytesToBase64(bytes) });
}

export async function pushState() {
  const json = JSON.stringify(S);
  return call('putState', { json });
}

export async function pullState() {
  const r = await call('getState');
  return r.json ? JSON.parse(r.json) : null;
}

let lastSyncError = '';
export const syncStatus = { last: null, error: '' };

const autoPush = debounce(async () => {
  if (!driveOn() || !S.settings.drive.autoSync) return;
  try {
    await pushState();
    syncStatus.last = new Date();
    syncStatus.error = '';
  } catch (e) {
    syncStatus.error = e.message;
    if (e.message !== lastSyncError) console.warn('Синхронизация', e);
    lastSyncError = e.message;
  }
}, 4000);

onSaved(() => autoPush());

// ---- Материалы из общей папки (через ваш скрипт) ----
export const listFolder = (folderId, depth = 3) => call('listFolder', { folderId, depth });
export const fileInfo = (id) => call('fileInfo', { id }).then((r) => r.file);

// Большой файл скачивается частями по 15 МБ и собирается здесь
export async function fetchExternal(id, onProgress) {
  const parts = [];
  let offset = 0, size = 0, mime = '';
  for (let guard = 0; guard < 40; guard++) {
    const r = await call('getExternal', { id, offset });
    const b = base64ToBytes(r.base64);
    parts.push(b);
    size = r.size || b.length; mime = r.mime || mime;
    offset += b.length;
    onProgress && onProgress(Math.min(offset, size), size);
    if (r.done || !b.length) break;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return { bytes: out, mime };
}
