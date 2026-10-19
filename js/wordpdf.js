// PDF-версия Word-документа: основа (ваш шаблон, напечатанный заранее, без строк с данными)
// + строки с данными, впечатанные заново теми же шрифтами, размерами и выравниванием.
// Разметку и основу готовит tools/word_pdf.py при сборке стартового пакета.
const { PDFDocument } = window.PDFLib;

const FONT_FILES = {
  Carlito: ['Carlito-Regular', 'Carlito-Bold', 'Carlito-Italic', 'Carlito-BoldItalic'],
  LibSerif: ['LiberationSerif-Regular', 'LiberationSerif-Bold', 'LiberationSerif-Italic', 'LiberationSerif-BoldItalic'],
  LibSans: ['LiberationSans-Regular', 'LiberationSans-Bold'],
};
const loaded = {};
export function loadFamily(fam) {
  if (!loaded[fam]) {
    const base = new URL('../fonts/', import.meta.url).href;
    loaded[fam] = Promise.all(FONT_FILES[fam].map((f) => {
      const bold = /Bold/.test(f); const italic = /Italic/.test(f);
      const ff = new FontFace('W' + fam, `url(${base}${f}.woff)`, { weight: bold ? '700' : '400', style: italic ? 'italic' : 'normal' });
      return ff.load().then((x) => document.fonts.add(x)).catch((e) => console.warn('Шрифт', f, e));
    }));
  }
  return loaded[fam];
}

// имя шрифта из PDF -> CSS
export function cssFont(name, size) {
  const n = String(name || '');
  const fam = /Carlito|Calibri/i.test(n) ? 'Carlito' : /Sans|Arial|Helvet/i.test(n) ? 'LibSans' : 'LibSerif';
  const bold = /Bold|Black|Heavy/i.test(n);
  const italic = /Italic|Oblique/i.test(n);
  return { fam, css: `${italic ? 'italic ' : ''}${bold ? 700 : 400} ${size}px W${fam}, ${fam === 'Carlito' ? 'Calibri' : fam === 'LibSans' ? 'Arial' : '"Times New Roman"'}, sans-serif` };
}

const K = 5; // пикселей на пункт — чёткая печать

// одна строка -> PNG; возвращает { png, x, y, w, h } в пунктах (y — снизу страницы)
async function linePng(line, values, H) {
  const parts = line.tokens.map((t) => ({ text: t.k ? String(values[t.k] ?? '') : t.t, st: t.st }));
  const [l, r] = line.lim;
  const top = line.top - 4;
  const hgt = line.bottom - line.top + 8 + (line.ul ? line.ul.dy + line.ul.t : 0);
  const c = document.createElement('canvas');
  c.width = Math.ceil((r - l) * K); c.height = Math.ceil(hgt * K);
  const ctx = c.getContext('2d');
  ctx.scale(K, K);
  ctx.textBaseline = 'alphabetic';
  const measure = (k) => parts.map((p) => { ctx.font = cssFont(p.st[0], p.st[1] * k).css; return ctx.measureText(p.text).width; });
  let k = 1;
  let ws = measure(1);
  let total = ws.reduce((a, b) => a + b, 0);
  const orig = line.x1 - line.x0;
  let avail;
  if (line.align === 'center') { const cx = (line.x0 + line.x1) / 2; avail = 2 * Math.min(cx - l, r - cx); }
  else if (line.align === 'right') avail = line.x1 - l;
  else avail = r - line.x0;
  if (total > avail) { k = avail / total; ws = measure(k); total = ws.reduce((a, b) => a + b, 0); }
  let x;
  if (line.align === 'center') x = (line.x0 + line.x1) / 2 - total / 2;
  else if (line.align === 'right') x = line.x1 - total;
  else x = line.x0;
  // по ширине: растягиваем пробелы до исходной ширины строки (как Word)
  let extra = 0;
  const spaces = parts.reduce((n, p) => n + (p.text.match(/ /g) || []).length, 0);
  if (line.align === 'justify' && total < orig && spaces) extra = (orig - total) / spaces;
  const base = line.base - top;
  x -= l;
  parts.forEach((p, i) => {
    const f = cssFont(p.st[0], p.st[1] * k);
    ctx.font = f.css;
    ctx.fillStyle = p.st[2] || '#000';
    if (!extra) { ctx.fillText(p.text, x, base); x += ws[i]; return; }
    for (const piece of p.text.split(/( )/)) {
      if (!piece) continue;
      ctx.fillText(piece, x, base);
      x += ctx.measureText(piece).width + (piece === ' ' ? extra : 0);
    }
  });
  // подчёркивание строки (как в шаблоне) — под новым текстом
  if (line.ul && total > 0) {
    const x0 = (line.align === 'center' ? (line.x0 + line.x1) / 2 - total / 2 : line.align === 'right' ? line.x1 - total : line.x0) - l;
    const w = extra ? line.x1 - line.x0 : total;
    ctx.fillStyle = (parts.find((p) => p.text.trim()) || parts[0]).st[2] || '#000';
    ctx.fillRect(x0, base + line.ul.dy * k - (line.ul.t * k) / 2, w, line.ul.t * k);
  }
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  return { png: new Uint8Array(await blob.arrayBuffer()), x: l, y: H - top - hgt, w: c.width / K, h: c.height / K };
}

/** base — основа PDF, layout — разметка, values — значения меток (как для Word). */
export async function buildWordPdf(base, layout, values) {
  await Promise.all([...new Set((layout.fonts || []).map((n) => cssFont(n, 10).fam))].map(loadFamily));
  await document.fonts.ready;
  const doc = await PDFDocument.load(base, { ignoreEncryption: true, updateMetadata: false });
  doc.setCreator('Памятки ОСП');
  const pages = doc.getPages();
  for (const line of layout.lines) {
    const p = pages[line.page];
    if (!p) continue;
    if (!line.tokens.some((t) => (t.k ? values[t.k] : t.t || '').toString().trim())) continue;
    const { height: H } = p.getSize();
    const img = await linePng(line, values, H);
    p.drawImage(await doc.embedPng(img.png), { x: img.x, y: img.y, width: img.w, height: img.h });
  }
  return doc.save({ useObjectStreams: true });
}

/** Несколько PDF в один (например, конверты для нескольких кадровиков). */
export async function mergePdfs(list) {
  if (list.length === 1) return list[0];
  const out = await PDFDocument.create();
  out.setCreator('Памятки ОСП');
  for (const b of list) {
    const d = await PDFDocument.load(b, { ignoreEncryption: true });
    (await out.copyPages(d, d.getPageIndices())).forEach((p) => out.addPage(p));
  }
  return out.save({ useObjectStreams: true });
}

/**
 * Печать по N страниц на листе (как «Страниц на листе» в Word): 1, 2 или 4.
 * frame — тонкая рамка вокруг каждой страницы.
 */
export async function nUp(bytes, { n = 4, frame = false } = {}) {
  if (n <= 1) return bytes;
  const { rgb } = window.PDFLib;
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  out.setCreator('Памятки ОСП');
  const idx = src.getPageIndices();
  const emb = await out.embedPdf(bytes, idx);
  const first = src.getPage(0).getSize();
  const landSrc = first.width > first.height;
  // 4 на листе: лист той же ориентации; 2 на листе: повёрнутый
  const sheet = n === 2 ? (landSrc ? [595.28, 841.89] : [841.89, 595.28]) : (landSrc ? [841.89, 595.28] : [595.28, 841.89]);
  const cols = n === 2 ? (sheet[0] > sheet[1] ? 2 : 1) : 2;
  const rows = n === 2 ? (sheet[0] > sheet[1] ? 1 : 2) : 2;
  const m = 18;
  const cw = (sheet[0] - m * 2) / cols; const ch = (sheet[1] - m * 2) / rows;
  for (let i = 0; i < emb.length; i += n) {
    const pg = out.addPage(sheet);
    for (let j = 0; j < n && i + j < emb.length; j++) {
      const e = emb[i + j];
      const sz = src.getPage(i + j).getSize();
      const s = Math.min(cw / sz.width, ch / sz.height);
      const w = sz.width * s; const h = sz.height * s;
      const col = j % cols; const row = Math.floor(j / cols);
      const x = m + col * cw + (cw - w) / 2; const y = sheet[1] - m - (row + 1) * ch + (ch - h) / 2;
      pg.drawPage(e, { x, y, width: w, height: h });
      if (frame) pg.drawRectangle({ x, y, width: w, height: h, borderColor: rgb(0, 0, 0), borderWidth: 0.25 });
    }
  }
  return out.save({ useObjectStreams: true });
}
