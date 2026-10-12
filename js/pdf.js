// Работа с PDF: подсчёт страниц, извлечение текста, превью, сжатие, сборка общего файла.
import { canvasesToPng, renderBlocks, A4 } from './pages.js';

const { PDFDocument } = window.PDFLib;
let pdfjsP;

export function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = import('../vendor/pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
      return m;
    });
  }
  return pdfjsP;
}

async function openJs(bytes) {
  const lib = await pdfjs();
  return lib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
}

function closeJs(d) {
  try {
    if (typeof d.destroy === 'function') d.destroy();
    else if (d.loadingTask) d.loadingTask.destroy();
  } catch (e) { /* уже закрыт */ }
}

export async function pageCount(bytes) {
  try {
    const d = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return d.getPageCount();
  } catch (e) {
    const d = await openJs(bytes);
    const n = d.numPages;
    closeJs(d);
    return n;
  }
}

// Текст по строкам — для сравнения старой и новой версии
export async function extractText(bytes, maxPages = 80) {
  try {
    const d = await openJs(bytes);
    const lines = [];
    const n = Math.min(d.numPages, maxPages);
    for (let i = 1; i <= n; i++) {
      const page = await d.getPage(i);
      const tc = await page.getTextContent();
      let cur = '', lastY = null;
      for (const it of tc.items) {
        const y = it.transform ? Math.round(it.transform[5]) : lastY;
        if (lastY !== null && Math.abs(y - lastY) > 2) { if (cur.trim()) lines.push(cur.trim()); cur = ''; }
        cur += (cur && !cur.endsWith(' ') && it.str && !it.str.startsWith(' ') ? ' ' : '') + it.str;
        lastY = y;
      }
      if (cur.trim()) lines.push(cur.trim());
      page.cleanup();
    }
    closeJs(d);
    return lines.map((l) => l.replace(/\s+/g, ' ')).join('\n').slice(0, 300000);
  } catch (e) {
    console.warn('Текст не извлечён', e);
    return '';
  }
}

export function diffText(oldText, newText) {
  const norm = (t) => (t || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 2);
  const a = norm(oldText), b = norm(newText);
  const setA = new Set(a), setB = new Set(b);
  const added = [...new Set(b.filter((l) => !setA.has(l)))];
  const removed = [...new Set(a.filter((l) => !setB.has(l)))];
  const same = b.length - added.length;
  return { added, removed, same, hasText: a.length > 0 || b.length > 0 };
}

export async function renderThumbs(bytes, { count = 2, width = 220, pages: pageList } = {}) {
  const d = await openJs(bytes);
  const out = [];
  const list = pageList || Array.from({ length: Math.min(count, d.numPages) }, (_, i) => i + 1);
  for (const n of list) {
    if (n > d.numPages) continue;
    const page = await d.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (width * (window.devicePixelRatio || 1)) / vp1.width });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    c.style.width = width + 'px';
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    out.push(c);
    page.cleanup();
  }
  closeJs(d);
  return out;
}

// Перевод страниц в изображения JPEG (сильное сжатие / обход защищённых файлов)
async function rasterize(bytes, dpi = 200, quality = 0.8, onProgress) {
  const d = await openJs(bytes);
  const out = await PDFDocument.create();
  for (let i = 1; i <= d.numPages; i++) {
    onProgress && onProgress(i, d.numPages);
    const page = await d.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
    const jpg = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const p = out.addPage([vp1.width, vp1.height]);
    p.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    page.cleanup();
    c.width = c.height = 0;
  }
  closeJs(d);
  return out.save({ useObjectStreams: true });
}

// mode: none | light (без потерь) | strong (растр 200 dpi) | auto
export async function compress(bytes, mode = 'auto', onProgress) {
  const original = bytes.length;
  if (mode === 'none') return { bytes, mode: 'none', before: original, after: original };
  let light = bytes;
  try {
    const d = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const saved = await d.save({ useObjectStreams: true });
    if (saved.length < bytes.length) light = saved;
  } catch (e) { /* оставляем как есть */ }
  if (mode === 'light') return { bytes: light, mode: 'light', before: original, after: light.length };

  let pages = 1;
  try { pages = await pageCount(bytes); } catch (e) { /* */ }
  const perPage = light.length / Math.max(pages, 1);
  if (mode === 'auto' && perPage < 350 * 1024) return { bytes: light, mode: 'light', before: original, after: light.length };

  try {
    const strong = await rasterize(bytes, 200, 0.8, onProgress);
    if (mode === 'strong' || strong.length < light.length * 0.6) {
      return { bytes: strong, mode: 'strong', before: original, after: strong.length };
    }
  } catch (e) { console.warn('Растровое сжатие не удалось', e); }
  return { bytes: light, mode: 'light', before: original, after: light.length };
}

async function addPngPages(out, pngs, size = [A4.w, A4.h]) {
  for (const png of pngs) {
    const img = await out.embedPng(png);
    const p = out.addPage(size);
    p.drawImage(img, { x: 0, y: 0, width: size[0], height: size[1] });
  }
}

async function appendPdf(out, bytes) {
  try {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach((p) => out.addPage(p));
    return copied.length;
  } catch (e) {
    // защищённый или нестандартный файл — переводим в изображения
    const raster = await rasterize(bytes, 200, 0.85);
    const src = await PDFDocument.load(raster);
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach((p) => out.addPage(p));
    return copied.length;
  }
}

function addBlank(out) {
  const last = out.getPage(out.getPageCount() - 1);
  const { width, height } = last ? last.getSize() : { width: A4.w, height: A4.h };
  out.addPage([width, height]);
}

/**
 * Сборка общего файла.
 * parts: [{ title, section, bytes?, pngs?, duplex }]
 * duplex у части = добивать её до чётного числа страниц.
 * cover: { title, subtitle } — титульный лист и содержание (две стороны одного листа).
 */
export async function buildPrint({ parts, cover, duplexCover = true, onProgress }) {
  const out = await PDFDocument.create();
  out.setTitle(cover ? cover.title : (parts[0] && parts[0].title) || 'Печать');
  out.setCreator('Памятки ОСП');

  // Сначала узнаём число страниц каждой части, чтобы проставить номера в содержании
  const counts = [];
  for (const part of parts) {
    const n = part.pngs ? part.pngs.length : await pageCount(part.bytes);
    counts.push(n);
  }

  let coverPngs = [];
  if (cover) {
    const coverBlocks = (startPages) => {
      const rows = [];
      let lastSection = null;
      parts.forEach((part, i) => {
        if (part.section && part.section !== lastSection) {
          rows.push({ title: part.section, level: 0 });
          lastSection = part.section;
        }
        rows.push({ title: part.title, level: part.section ? 1 : 0, page: startPages ? startPages[i] : 0 });
      });
      return [
        { t: 'gap', h: 220 },
        { t: 'big', text: cover.title, size: 34 },
        { t: 'gap', h: 14 },
        ...(cover.subtitle ? [{ t: 'p', text: cover.subtitle, size: 13, muted: true }] : []),
        { t: 'pagebreak' },
        { t: 'h1', text: 'Содержание', sub: cover.title },
        { t: 'contents', rows },
      ];
    };
    // первый проход — узнаём, сколько страниц займёт содержание
    let canv = await renderBlocks(coverBlocks(null));
    let coverCount = canv.length + (duplexCover && canv.length % 2 ? 1 : 0);
    const starts = [];
    let pg = coverCount + 1;
    parts.forEach((part, i) => {
      starts.push(pg);
      pg += counts[i] + (part.duplex && counts[i] % 2 ? 1 : 0);
    });
    canv = await renderBlocks(coverBlocks(starts));
    coverPngs = await canvasesToPng(canv);
    await addPngPages(out, coverPngs);
    if (duplexCover && coverPngs.length % 2) addBlank(out);
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    onProgress && onProgress(i + 1, parts.length, part.title);
    let n;
    if (part.pngs) { await addPngPages(out, part.pngs, part.size); n = part.pngs.length; }
    else n = await appendPdf(out, part.bytes);
    if (part.duplex && n % 2) addBlank(out);
  }
  return out.save({ useObjectStreams: true });
}

export async function addBlankPage(bytes) {
  const d = await PDFDocument.load(bytes, { ignoreEncryption: true });
  addBlank(d);
  return d.save({ useObjectStreams: true });
}

export async function blocksToPdf(blocks, opts = {}) {
  const canv = await renderBlocks(blocks, opts);
  const pngs = await canvasesToPng(canv);
  return { pngs, size: opts.landscape ? [A4.h, A4.w] : [A4.w, A4.h] };
}
