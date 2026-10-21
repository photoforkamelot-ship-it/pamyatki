// Доработка готовых PDF перед печатью: строка КИЦ в памятке директору, сборка журнала из обложки и бланков.
import { loadPrintFonts } from './pages.js';

const { PDFDocument, rgb } = window.PDFLib;

// Текст в картинку (кириллица без встраивания шрифтов), 4× для чёткой печати
async function textPng(parts, { height, color = '#e30613', size = 14, bold = true, width }) {
  await loadPrintFonts();
  const K = 4;
  const c = document.createElement('canvas');
  c.width = Math.round(width * K);
  c.height = Math.round(height * K);
  const ctx = c.getContext('2d');
  ctx.scale(K, K);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  for (const p of parts) {
    let fs = size;
    ctx.font = `${bold ? 700 : 400} ${fs}px PrintSans, Arial, sans-serif`;
    // ужимаем, если не влезает в отведённую ширину
    while (p.max && ctx.measureText(p.text).width > p.max && fs > 7) { fs -= 0.5; ctx.font = `${bold ? 700 : 400} ${fs}px PrintSans, Arial, sans-serif`; }
    ctx.fillText(p.text, p.x, height / 2);
  }
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Строка КИЦ на странице «Заказ размена».
 * opt: { page (с 1), mode: 'below' | 'over', name, email }
 * Координаты — от верхнего края страницы, в пунктах, по исходному файлу (540×720).
 */
export const KIC_LAYOUT = { x0: 32, x1: 538, overTop: 518, overBottom: 538, belowTop: 541, nameX: 15, emailX: 283, size: 13 };

export async function kicOverlay(bytes, { page = 1, mode = 'below', name = '', email = '' } = {}) {
  if (!name && !email) return bytes;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const idx = Math.min(Math.max(page, 1), doc.getPageCount()) - 1;
  let p = doc.getPage(idx);
  if (mode === 'over') {
    // исходная страница может оставлять «умножение» цветов — белая плашка тогда не закрывает текст.
    // Переносим страницу как отдельный объект: её настройки не влияют на то, что рисуем поверх.
    const { width, height } = p.getSize();
    const [emb] = await doc.embedPdf(bytes, [idx]);
    const np = doc.insertPage(idx, [width, height]);
    np.drawPage(emb, { x: 0, y: 0, width, height });
    doc.removePage(idx + 1);
    p = np;
  }
  const { height: H, width: W } = p.getSize();
  // файл мог быть другого масштаба — пересчитываем от исходных 540×720
  const k = W / 540;
  const L = KIC_LAYOUT;
  const w = (L.x1 - L.x0) * k;
  const top = (mode === 'over' ? L.overTop : L.belowTop) * k;
  const hgt = (L.overBottom - L.overTop) * k;
  if (mode === 'over') p.drawRectangle({ x: L.x0 * k, y: H - top - hgt, width: w, height: hgt, color: rgb(1, 1, 1) });
  const png = await textPng([
    { text: name, x: L.nameX, max: L.emailX - L.nameX - 8 },
    { text: email, x: L.emailX, max: (L.x1 - L.x0) - L.emailX },
  ], { width: L.x1 - L.x0, height: L.overBottom - L.overTop, size: L.size });
  const img = await doc.embedPng(png);
  p.drawImage(img, { x: L.x0 * k, y: H - top - hgt, width: w, height: hgt });
  return doc.save({ useObjectStreams: true });
}

/**
 * Журнал: обложка (добивается до чётного) + бланки, повторённые до нужного числа листов.
 * Двусторонняя печать: один лист = 2 страницы бланка.
 */
export async function buildJournal(coverBytes, bodyBytes, sheets = 90) {
  const out = await PDFDocument.create();
  out.setCreator('Памятки ОСП');
  if (coverBytes) {
    const cover = await PDFDocument.load(coverBytes, { ignoreEncryption: true });
    const pages = await out.copyPages(cover, cover.getPageIndices());
    pages.forEach((p) => out.addPage(p));
    if (pages.length % 2) { const s = pages[0].getSize(); out.addPage([s.width, s.height]); }
  }
  const body = await PDFDocument.load(bodyBytes, { ignoreEncryption: true });
  const idx = body.getPageIndices();
  const embedded = await out.embedPdf(bodyBytes, idx);
  const sizes = idx.map((i) => body.getPage(i).getSize());
  const total = Math.max(1, Number(sheets) || 1) * 2;
  for (let n = 0; n < total; n++) {
    const e = embedded[n % embedded.length];
    const s = sizes[n % sizes.length];
    const p = out.addPage([s.width, s.height]);
    p.drawPage(e, { x: 0, y: 0, width: s.width, height: s.height });
  }
  return out.save({ useObjectStreams: true });
}

// ---------- страницы по регионам: метки «[УФО]», «[ЦФО, СФО]» в углу страницы ----------
// marks = { "15": { r: ["СФО"], box: [x0, top, x1, bottom] } } — номер страницы с 1, рамка метки в пунктах от верхнего левого угла.
// Страницы чужого региона выпадают, метки на оставшихся закрываются белым. Без региона в сеансе печатаются все страницы.
export async function regionPages(bytes, marks, region) {
  if (!marks || !Object.keys(marks).length) return bytes;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const n = doc.getPageCount();
  const drop = [];
  for (let i = 0; i < n; i++) {
    const m = marks[String(i + 1)];
    if (!m) continue;
    if (region && m.r && m.r.length && !m.r.includes(region)) { drop.push(i); continue; }
    if (m.box) {
      const p = doc.getPage(i);
      const { height: H } = p.getSize();
      const [x0, t, x1, b] = m.box;
      p.drawRectangle({ x: x0, y: H - b, width: Math.max(x1 - x0, 46), height: b - t, color: rgb(1, 1, 1) });
    }
  }
  for (const i of drop.reverse()) doc.removePage(i);
  return doc.save();
}

// Найти метки в тексте страниц (если шрифт читается). Возвращает marks или null.
export const REGION_RE = /\[\s*((?:[А-ЯЁ]{2,4}ФО)(?:\s*[,/;и]\s*[А-ЯЁ]{2,4}ФО)*)\s*\]/;
export async function detectMarks(bytes) {
  const { openJs, closeJs } = await import('./pdf.js');
  const d = await openJs(bytes);
  const out = {};
  for (let i = 1; i <= d.numPages; i++) {
    const page = await d.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items.filter((it) => it.str);
    const text = items.map((it) => it.str).join('');
    const m = text.match(REGION_RE);
    if (m) {
      const r = m[1].split(/\s*[,/;и]\s*/).map((x) => x.trim()).filter(Boolean);
      // рамка: элементы текста, из которых состоит метка
      const hit = items.filter((it) => /[\[\]]|[А-ЯЁ]{2,4}ФО/.test(it.str) && m[0].includes(it.str.trim().replace(/\s+/g, '')) );
      let box = null;
      if (hit.length) {
        const xs = hit.map((it) => it.transform[4]), ys = hit.map((it) => vp.height - it.transform[5]);
        const hgt = Math.max(...hit.map((it) => Math.abs(it.transform[3]) || 10));
        box = [Math.min(...xs) - 2, Math.min(...ys) - hgt - 2, Math.max(...hit.map((it) => it.transform[4] + it.width)) + 2, Math.max(...ys) + 4];
      }
      out[String(i)] = { r, box };
    }
    page.cleanup();
  }
  closeJs(d);
  return Object.keys(out).length ? out : null;
}
