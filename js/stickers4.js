// «Наклейки 4 на листе» (PDF): основа — ваш PDF из Word, напечатанный по 4 страницы на листе,
// из которого вырезаны строки магазина. Сюда впечатываются ОСП, адрес, фамилии и рисуется тонкая рамка.
const { PDFDocument, rgb } = window.PDFLib;

const H = 841.89; // A4, пункты
// четвертинки листа (x, y снизу, ширина, высота)
export const TILES = [
  [32.26, 429.63, 261.77, 370.22], [301.24, 429.63, 261.77, 370.22],
  [32.26, 42.04, 261.77, 370.22], [301.24, 42.04, 261.77, 370.22],
];
const RIGHT = { L: 291, R: 560 };
const nameRows = (x, side, tops) => tops.map((top, i) => ({ x, top, h: 21.5, size: 17.6, x1: RIGHT[side], key: 'N' + (i + 1) }));
const NAMES = Array.from({ length: 7 }, (_, i) => 63.8 + 25.8 * i);
const NAMES_B = Array.from({ length: 7 }, (_, i) => 437.8 + 25.8 * i);
const mgr = (x, side, tops) => tops.map((top) => ({ x, top, h: 30.1, size: 24.6, x1: RIGHT[side], key: 'MGR' }));
const label = (x, side, top) => [
  { x, top, h: 19.4, size: 15.9, x1: RIGHT[side], text: (v) => `ОСП ${v.CITY} Магазин № ${v.OSP}`.replace(/\s+/g, ' ') },
  { x, top: top + 19.3, h: 16.7, size: 13.7, x1: RIGHT[side], text: (v) => `Адрес: ${v.ADDRESS}` },
];
// страница основы (с 1) -> строки
export const FIELDS = {
  5: [...label(44.8, 'L', 518.3), ...label(44.8, 'L', 690.8), ...label(313.8, 'R', 518.3), ...label(313.8, 'R', 635.9)],
  10: [...nameRows(41.7, 'L', NAMES), ...nameRows(310.7, 'R', NAMES), ...nameRows(41.7, 'L', NAMES_B),
    ...mgr(41.7, 'L', [319.8, 355.4, 693.7, 729.4]), ...mgr(310.7, 'R', [319.8, 355.4])],
};

let fontReady;
function loadFont() {
  if (!fontReady) {
    const f = new FontFace('StickerSans', `url(${new URL('../fonts/Carlito-Bold.woff', import.meta.url).href})`, { weight: '700' });
    fontReady = f.load().then((ff) => document.fonts.add(ff)).catch((e) => console.warn('Шрифт наклеек', e));
  }
  return fontReady;
}

// строка текста картинкой (кириллица без встраивания шрифта), 6× — чётко при печати
async function linePng(text, { width, height, size }) {
  const K = 6;
  const c = document.createElement('canvas');
  c.width = Math.ceil(width * K); c.height = Math.ceil(height * K);
  const ctx = c.getContext('2d');
  ctx.scale(K, K);
  let fs = size;
  const font = () => `700 ${fs}px StickerSans, Calibri, Carlito, Arial, sans-serif`;
  ctx.font = font();
  while (ctx.measureText(text).width > width && fs > 6) { fs -= 0.25; ctx.font = font(); }
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'alphabetic';
  // базовая линия Calibri: 0.952 размера от верха строки; при уменьшении — по центру строки
  const base = fs === size ? size * 0.952 : (height + fs * 0.65) / 2;
  ctx.fillText(text, 0, base);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * base — основа PDF; values — как для Word (CITY, OSP, ADDRESS, MGR, N1…N7).
 * Пустые значения не печатаются: строки остаются чистыми для записи от руки.
 */
export async function buildStickers4(base, values, { hairline = 0.25 } = {}) {
  await loadFont();
  const doc = await PDFDocument.load(base, { ignoreEncryption: true, updateMetadata: false });
  doc.setCreator('Памятки ОСП');
  const pages = doc.getPages();
  for (const [pno, fields] of Object.entries(FIELDS)) {
    const p = pages[Number(pno) - 1];
    if (!p) continue;
    for (const f of fields) {
      const text = String(f.text ? f.text(values) : values[f.key] || '').trim();
      if (!text || /^(ОСП\s+Магазин №|Адрес:)\s*$/.test(text)) continue;
      const width = f.x1 - f.x;
      const png = await doc.embedPng(await linePng(text, { width, height: f.h, size: f.size }));
      p.drawImage(png, { x: f.x, y: H - f.top - f.h, width: Math.ceil(width * 6) / 6, height: Math.ceil(f.h * 6) / 6 });
    }
  }
  for (const p of pages) {
    for (const [x, y, w, h] of TILES) p.drawRectangle({ x, y, width: w, height: h, borderColor: rgb(0, 0, 0), borderWidth: hairline });
  }
  return doc.save({ useObjectStreams: true });
}

// ---------- таблички склада «4 на листе» (возврат, ОСП + адрес) ----------
// layout: { tiles: [[x, y, w, h]…], fields: [{ key, tile, cx, y0, h, size, color }], copies, addressKey }
async function centeredPng(text, { width, height, size, cx, color }) {
  const K = 5;
  const c = document.createElement('canvas');
  c.width = Math.ceil(width * K); c.height = Math.ceil(height * K);
  const ctx = c.getContext('2d');
  ctx.scale(K, K);
  let fs = size;
  const font = () => `700 ${fs}px StickerSans, Calibri, Carlito, Arial, sans-serif`;
  ctx.font = font();
  const room = width - 8;
  while (ctx.measureText(text).width > room && fs > 6) { fs -= 0.5; ctx.font = font(); }
  ctx.fillStyle = color || '#000';
  ctx.textAlign = 'center';
  // если текст шире исходного места — держим его внутри клетки
  const w = ctx.measureText(text).width;
  const x = Math.min(Math.max(cx, 4 + w / 2), width - 4 - w / 2);
  const base = fs === size ? size * 0.952 : (height + fs * 0.65) / 2;
  ctx.fillText(text, x, base);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function buildSheet4(base, layout, values) {
  await loadFont();
  const src = await PDFDocument.load(base, { ignoreEncryption: true, updateMetadata: false });
  const page = src.getPage(0);
  const val = (k) => String((k === 'АДРЕС' ? values[layout.addressKey || 'АДРЕС_ВЕРХ'] : values[k]) || '').trim().toUpperCase();
  for (const f of layout.fields) {
    const text = val(f.key);
    if (!text) continue;
    const [tx, , tw] = layout.tiles[f.tile];
    const png = await src.embedPng(await centeredPng(text, { width: tw, height: f.h, size: f.size, cx: f.cx - tx, color: f.color }));
    page.drawImage(png, { x: tx, y: f.y0, width: tw, height: f.h });
  }
  // двусторонняя печать: оборот такой же, как лицо
  const out = await PDFDocument.create();
  out.setCreator('Памятки ОСП');
  const n = Math.max(1, layout.copies || 2);
  const pages = await out.copyPages(src, Array(n).fill(0));
  pages.forEach((p) => out.addPage(p));
  return out.save({ useObjectStreams: true });
}
