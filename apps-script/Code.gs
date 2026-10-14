/**
 * Бэкенд «Памяток ОСП» на Google Apps Script.
 * Хранит файлы и настройки в папке на вашем Google Диске и отправляет готовые PDF в Telegram.
 *
 * Свойства скрипта (Настройки проекта → Свойства скрипта):
 *   SECRET       — любой длинный ключ; тот же ключ вводится в приложении (обязательно)
 *   BOT_TOKEN    — токен бота от @BotFather (нужен для отправки файлов в чат и входа из Telegram без ключа)
 *   ALLOWED_IDS  — Telegram ID через запятую, кому можно пользоваться без ключа (необязательно)
 *   FOLDER_ID    — ID папки на Диске (необязательно; иначе создастся папка «Памятки ОСП»)
 */

var ROOT_NAME = 'Памятки ОСП';
var CHUNK = 15 * 1024 * 1024; // большие файлы отдаём частями: лимит веб-скрипта ~50 МБ на ответ
var DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
var STATE_NAME = 'state.json';

function doGet() {
  return json_({ ok: true, app: 'pamyatki-osp', hint: 'Используйте POST из приложения' });
}

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var who = auth_(req);
    var fn = ACTIONS[req.action];
    if (!fn) throw new Error('Неизвестное действие: ' + req.action);
    var res = fn(req, who) || {};
    res.ok = true;
    return json_(res);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

var ACTIONS = {
  ping: function () {
    return { folder: root_().getName() };
  },

  putFile: function (req) {
    var folder = sub_(req.folder || 'Файлы');
    var blob = Utilities.newBlob(Utilities.base64Decode(req.base64), req.mime || 'application/pdf', req.name || 'file.pdf');
    var file = folder.createFile(blob);
    return { id: file.getId(), url: file.getUrl() };
  },

  getFile: function (req) {
    var file = DriveApp.getFileById(req.id);
    checkInside_(file);
    return { base64: Utilities.base64Encode(file.getBlob().getBytes()), name: file.getName() };
  },

  trashFile: function (req) {
    var file = DriveApp.getFileById(req.id);
    checkInside_(file);
    file.setTrashed(true);
    return {};
  },

  putState: function (req) {
    var root = root_();
    var it = root.getFilesByName(STATE_NAME);
    if (it.hasNext()) it.next().setContent(req.json);
    else root.createFile(STATE_NAME, req.json, 'application/json');
    return { savedAt: new Date().toISOString() };
  },

  getState: function () {
    var it = root_().getFilesByName(STATE_NAME);
    return { json: it.hasNext() ? it.next().getBlob().getDataAsString('UTF-8') : '' };
  },

  // ---- Материалы к открытию: чтение общей папки, к которой у вашего аккаунта есть доступ ----
  listFolder: function (req) {
    var folder = DriveApp.getFolderById(req.folderId);
    var out = [];
    walk_(folder, '', out, req.depth == null ? 3 : Number(req.depth));
    return { folder: folder.getName(), files: out };
  },

  fileInfo: function (req) {
    return { file: info_(DriveApp.getFileById(req.id), '') };
  },

  getExternal: function (req) {
    var f = DriveApp.getFileById(req.id);
    var mime = f.getMimeType();
    var auth = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
    if (mime.indexOf('application/vnd.google-apps') === 0) {
      // Google Документ / Таблица — выгружаем в Word / PDF
      var exp = req.exportMime || (mime === 'application/vnd.google-apps.document' ? DOCX_MIME : 'application/pdf');
      var r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + req.id + '/export?mimeType=' + encodeURIComponent(exp), { headers: auth, muteHttpExceptions: true });
      if (r.getResponseCode() >= 300) throw new Error('Не удалось выгрузить файл: код ' + r.getResponseCode());
      var b = r.getContent();
      return { base64: Utilities.base64Encode(b), mime: exp, size: b.length, offset: 0, done: true };
    }
    var size = f.getSize();
    var off = Number(req.offset || 0);
    var len = Math.min(Number(req.length || CHUNK), CHUNK);
    if (off === 0 && size <= len) return { base64: Utilities.base64Encode(f.getBlob().getBytes()), mime: mime, size: size, offset: 0, done: true };
    var end = Math.min(off + len, size) - 1;
    var resp = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + req.id + '?alt=media&supportsAllDrives=true', {
      headers: { Authorization: auth.Authorization, Range: 'bytes=' + off + '-' + end }, muteHttpExceptions: true,
    });
    if (resp.getResponseCode() >= 300) throw new Error('Не удалось скачать часть файла: код ' + resp.getResponseCode());
    return { base64: Utilities.base64Encode(resp.getContent()), mime: mime, size: size, offset: off, done: end + 1 >= size };
  },

  sendDocument: function (req, who) {
    var token = prop_('BOT_TOKEN');
    if (!token) throw new Error('В свойствах скрипта не задан BOT_TOKEN');
    var chatId = req.chatId || (who && who.userId);
    if (!chatId) throw new Error('Не известен чат: откройте приложение из Telegram или укажите ID чата в настройках');
    var name = req.name || 'file.pdf';
    var mime = /\.csv$/i.test(name) ? 'text/csv' : /\.docx$/i.test(name) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : /\.xlsx$/i.test(name) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : /\.zip$/i.test(name) ? 'application/zip' : 'application/pdf';
    var blob = Utilities.newBlob(Utilities.base64Decode(req.base64), mime, name);
    var resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendDocument', {
      method: 'post',
      payload: { chat_id: String(chatId), caption: (req.caption || '').slice(0, 1000), document: blob },
      muteHttpExceptions: true,
    });
    var out = JSON.parse(resp.getContentText());
    if (!out.ok) throw new Error('Telegram: ' + out.description + ' (напишите боту /start)');
    return {};
  },
};

// ---------- доступ ----------
function auth_(req) {
  var secret = prop_('SECRET');
  if (!secret) throw new Error('В свойствах скрипта не задан SECRET');
  if (req.key && req.key === secret) {
    return { userId: tgUserId_(req.initData, true) };
  }
  var uid = tgUserId_(req.initData, false);
  if (uid) {
    var allowed = (prop_('ALLOWED_IDS') || '').split(',').map(function (s) { return s.trim(); }).filter(String);
    if (allowed.indexOf(String(uid)) >= 0) return { userId: uid };
  }
  throw new Error('Нет доступа: проверьте ключ в настройках приложения');
}

// Проверка подписи Telegram Mini App (initData) токеном бота
function tgUserId_(initData, soft) {
  var token = prop_('BOT_TOKEN');
  if (!initData || !token) return null;
  var params = {};
  initData.split('&').forEach(function (pair) {
    var i = pair.indexOf('=');
    params[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
  });
  var hash = params.hash;
  delete params.hash;
  var check = Object.keys(params).sort().map(function (k) { return k + '=' + params[k]; }).join('\n');
  var secretKey = Utilities.computeHmacSha256Signature(Utilities.newBlob(token).getBytes(), Utilities.newBlob('WebAppData').getBytes());
  var sig = hex_(Utilities.computeHmacSha256Signature(Utilities.newBlob(check).getBytes(), secretKey));
  if (sig !== hash) { if (soft) return null; throw new Error('Подпись Telegram не прошла проверку'); }
  var authDate = Number(params.auth_date || 0);
  if (Date.now() / 1000 - authDate > 7 * 24 * 3600 && !soft) throw new Error('Сессия Telegram устарела, перезапустите приложение');
  try { return JSON.parse(params.user).id; } catch (e) { return null; }
}

function hex_(bytes) {
  return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length === 1 ? '0' + v : v; }).join('');
}

// ---------- папки ----------
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }

function root_() {
  var id = prop_('FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  var it = DriveApp.getRootFolder().getFoldersByName(ROOT_NAME);
  if (it.hasNext()) return it.next();
  var f = DriveApp.getRootFolder().createFolder(ROOT_NAME);
  PropertiesService.getScriptProperties().setProperty('FOLDER_ID', f.getId());
  return f;
}

function sub_(name) {
  var root = root_();
  var clean = String(name).replace(/[\\/]/g, ' ').slice(0, 100);
  var it = root.getFoldersByName(clean);
  return it.hasNext() ? it.next() : root.createFolder(clean);
}

// Файл должен лежать внутри папки приложения — чужие файлы скрипт не отдаёт
function checkInside_(file) {
  var rootId = root_().getId();
  var parents = file.getParents();
  while (parents.hasNext()) {
    var p = parents.next();
    if (p.getId() === rootId) return;
    var up = p.getParents();
    while (up.hasNext()) if (up.next().getId() === rootId) return;
  }
  throw new Error('Файл вне папки приложения');
}

function info_(f, path) {
  return { id: f.getId(), name: f.getName(), mime: f.getMimeType(), size: f.getSize(), modified: f.getLastUpdated().toISOString(), path: path, url: f.getUrl() };
}

function walk_(folder, path, out, depth) {
  var it = folder.getFiles();
  while (it.hasNext()) out.push(info_(it.next(), path));
  if (depth <= 0) return;
  var sub = folder.getFolders();
  while (sub.hasNext()) {
    var f = sub.next();
    walk_(f, path ? path + ' / ' + f.getName() : f.getName(), out, depth - 1);
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
