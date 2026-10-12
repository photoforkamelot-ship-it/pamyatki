// Генерация печатных страниц (A4) из простых блоков. Рисуем на canvas — так кириллица
// всегда выглядит одинаково, без встраивания шрифтов в PDF.
const PT = 200 / 72; // 200 dpi
const A4 = { w: 595.28, h: 841.89 };
const M = 42; // поля, pt
const FONT = 'PrintSans';
const SERIF = 'PrintSerif';
let fontsReady;

export function loadPrintFonts() {
  if (fontsReady) return fontsReady;
  const base = new URL('../fonts/', import.meta.url).href;
  const faces = [
    new FontFace(FONT, `url(${base}DejaVuSans.woff)`, { weight: '400' }),
    new FontFace(FONT, `url(${base}DejaVuSans-Bold.woff)`, { weight: '700' }),
    new FontFace(SERIF, `url(${base}DejaVuSerif.woff)`, { weight: '400' }),
    new FontFace(SERIF, `url(${base}DejaVuSerif-Bold.woff)`, { weight: '700' }),
    new FontFace(SERIF, `url(${base}DejaVuSerif-Italic.woff)`, { weight: '400', style: 'italic' }),
    new FontFace(SERIF, `url(${base}DejaVuSerif-BoldItalic.woff)`, { weight: '700', style: 'italic' }),
  ];
  fontsReady = Promise.all(faces.map((f) => f.load().then((ff) => document.fonts.add(ff)))).catch((e) => console.warn('Шрифт не загрузился', e));
  return fontsReady;
}

class Pager {
  constructor({ landscape = false, footer = '' } = {}) {
    this.W = landscape ? A4.h : A4.w;
    this.H = landscape ? A4.w : A4.h;
    this.footer = footer;
    this.pages = [];
    this.newPage();
  }
  newPage() {
    const c = document.createElement('canvas');
    c.width = Math.round(this.W * PT);
    c.height = Math.round(this.H * PT);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.scale(PT, PT);
    ctx.fillStyle = '#111';
    ctx.strokeStyle = '#111';
    ctx.textBaseline = 'alphabetic';
    this.ctx = ctx;
    this.canvas = c;
    this.pages.push(c);
    this.y = M;
  }
  get bottom() { return this.H - M - (this.footer ? 16 : 0); }
  get width() { return this.W - 2 * M; }
  ensure(h) { if (this.y + h > this.bottom) { this.newPage(); return true; } return false; }
  font(size, bold, italic = false, serif = this.serif) {
    this.ctx.font = `${italic ? 'italic ' : ''}${bold ? 700 : 400} ${size}px ${serif ? SERIF + ', serif' : FONT + ', sans-serif'}`;
  }

  wrap(text, size, bold, maxW, italic = false) {
    this.font(size, bold, italic);
    const out = [];
    for (const para of String(text ?? '').split('\n')) {
      const words = para.split(/\s+/);
      let line = '';
      for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (this.ctx.measureText(test).width <= maxW || !line) {
          if (this.ctx.measureText(test).width > maxW && !line) {
            // очень длинное слово — режем
            let part = '';
            for (const ch of w) {
              if (this.ctx.measureText(part + ch).width > maxW) { out.push(part); part = ch; } else part += ch;
            }
            line = part;
          } else line = test;
        } else { out.push(line); line = w; }
      }
      out.push(line);
    }
    return out;
  }

  text(str, x, y, size, bold, color = '#111', align = 'left', italic = false, underline = false) {
    this.font(size, bold, italic);
    this.ctx.fillStyle = color;
    this.ctx.textAlign = align;
    this.ctx.fillText(str, x, y);
    if (underline && str) {
      const w = this.ctx.measureText(str).width;
      const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
      this.hline(x0, x0 + w, y + size * 0.12, Math.max(0.6, size / 16), color);
    }
    this.ctx.textAlign = 'left';
  }

  hline(x1, x2, y, w = 0.6, color = '#111') {
    const c = this.ctx;
    c.strokeStyle = color; c.lineWidth = w;
    c.beginPath(); c.moveTo(x1, y); c.lineTo(x2, y); c.stroke();
  }

  rect(x, y, w, h, lw = 0.6, dash) {
    const c = this.ctx;
    c.lineWidth = lw; c.strokeStyle = '#111';
    if (dash) c.setLineDash(dash);
    c.strokeRect(x, y, w, h);
    c.setLineDash([]);
  }

  para(text, { size = 11, bold = false, color = '#111', gapAfter = 6, indent = 0, lh = 1.35 } = {}) {
    const lines = this.wrap(text, size, bold, this.width - indent);
    for (const l of lines) {
      this.ensure(size * lh);
      this.y += size * lh;
      this.text(l, M + indent, this.y - size * 0.3, size, bold, color);
    }
    this.y += gapAfter;
  }

  finishFooters() {
    if (!this.footer) return;
    this.pages.forEach((c, i) => {
      const ctx = c.getContext('2d');
      ctx.font = `400 8px ${FONT}, sans-serif`;
      ctx.fillStyle = '#666';
      ctx.fillText(this.footer, M, this.H - M + 10);
      ctx.textAlign = 'right';
      ctx.fillText(`${i + 1} / ${this.pages.length}`, this.W - M, this.H - M + 10);
      ctx.textAlign = 'left';
    });
  }
}

// Таблица с переносом по страницам и повтором шапки
function drawTable(p, b) {
  const size = b.size || 10;
  const pad = 4;
  const total = p.width;
  const fr = b.cols.reduce((s, c) => s + (c.w || 1), 0);
  const widths = b.cols.map((c) => (total * (c.w || 1)) / fr);
  const rows = b.rows.slice();
  for (let i = 0; i < (b.emptyRows || 0); i++) rows.push(b.cols.map(() => ''));

  const rowHeight = (cells, bold) => {
    let maxLines = 1;
    cells.forEach((cell, i) => {
      const lines = p.wrap(cell ?? '', size, bold, widths[i] - pad * 2);
      maxLines = Math.max(maxLines, lines.length);
    });
    return Math.max(b.minRowH || 0, maxLines * size * 1.3 + pad * 2);
  };
  const drawRow = (cells, bold, fill) => {
    const rh = rowHeight(cells, bold);
    let x = M;
    if (fill) { p.ctx.fillStyle = fill; p.ctx.fillRect(M, p.y, total, rh); }
    cells.forEach((cell, i) => {
      p.rect(x, p.y, widths[i], rh);
      const lines = p.wrap(cell ?? '', size, bold, widths[i] - pad * 2);
      lines.forEach((l, li) => p.text(l, x + pad, p.y + pad + size * (li + 1) * 1.3 - size * 0.3, size, bold));
      x += widths[i];
    });
    p.y += rh;
  };
  const head = b.cols.map((c) => c.label);
  const hh = rowHeight(head, true);
  p.ensure(hh + rowHeight(rows[0] || head, false));
  if (!b.noHead) drawRow(head, true, '#efefef');
  for (const r of rows) {
    const rh = rowHeight(r, false);
    if (p.ensure(rh) && !b.noHead) drawRow(head, true, '#efefef');
    drawRow(r, false);
  }
  p.y += 10;
}

// Таблица со стилями ячеек: заливка, жирный, выравнивание, объединение по горизонтали
function drawXTable(p, b) {
  const size = b.size || 10, pad = b.pad ?? 4, lh = 1.28;
  const fr = b.cols.reduce((s, w) => s + w, 0);
  const widths = b.cols.map((w) => (p.width * w) / fr);
  const norm = (c) => (c === null || c === undefined ? { t: '' } : typeof c === 'object' ? c : { t: String(c) });
  const layout = (row) => {
    let col = 0; const cells = [];
    for (const raw of row) {
      const c = norm(raw); const span = c.span || 1;
      const w = widths.slice(col, col + span).reduce((a, x) => a + x, 0);
      const sz = c.size || size;
      const lines = p.wrap(c.t ?? '', sz, c.bold, w - pad * 2, c.italic);
      cells.push({ c, x: col, w, sz, lines });
      col += span;
    }
    const h = Math.max(b.minRowH || 0, ...cells.map((k) => k.lines.length * k.sz * lh + pad * 2));
    return { cells, h };
  };
  const drawRow = (row) => {
    const L = layout(row);
    const x0 = M + (b.offset || 0);
    for (const k of L.cells) {
      const x = x0 + widths.slice(0, k.x).reduce((a, w) => a + w, 0);
      if (k.c.fill) { p.ctx.fillStyle = k.c.fill; p.ctx.fillRect(x, p.y, k.w, L.h); }
      if (!b.noBorder && !k.c.noBorder) p.rect(x, p.y, k.w, L.h, k.c.lw || 0.6);
      const align = k.c.align || 'left';
      const tx = align === 'center' ? x + k.w / 2 : align === 'right' ? x + k.w - pad : x + pad;
      const blockH = k.lines.length * k.sz * lh;
      const top = k.c.valign === 'middle' ? p.y + (L.h - blockH) / 2 : p.y + pad;
      k.lines.forEach((l, i) => p.text(l, tx, top + k.sz * lh * (i + 1) - k.sz * 0.32, k.sz, k.c.bold, k.c.color || '#111', align, k.c.italic, k.c.underline));
    }
    p.y += L.h;
    return L.h;
  };
  const head = b.rows.slice(0, b.headRows || 0);
  b.rows.forEach((row, i) => {
    const h = layout(row).h;
    if (p.y + h > p.bottom) {
      p.newPage();
      if (i >= head.length) head.forEach(drawRow);
    }
    drawRow(row);
  });
  p.y += b.gap ?? 8;
}

// Абзац с жирными и курсивными кусками: runs = [{t, b, i}]
function drawRich(p, b) {
  const size = b.size || 11, lh = b.lh || 1.45, indent = b.indent || 0;
  const words = [];
  for (const r of b.runs) {
    const parts = String(r.t).split(/(\s+)/);
    for (const w of parts) if (w) words.push({ w, b: r.b, i: r.i, u: r.u });
  }
  const maxW = p.width - indent;
  let line = [], lineW = 0, first = true;
  const flush = () => {
    while (line.length && /^\s+$/.test(line[line.length - 1].w)) line.pop();
    p.ensure(size * lh); p.y += size * lh;
    let x = M + (first ? (b.firstIndent || 0) + indent : indent);
    for (const k of line) {
      p.font(size, k.b, k.i);
      p.text(k.w, x, p.y - size * 0.3, size, k.b, '#111', 'left', k.i, k.u && !/^\s+$/.test(k.w));
      x += p.ctx.measureText(k.w).width;
    }
    line = []; lineW = 0; first = false;
  };
  for (const k of words) {
    p.font(size, k.b, k.i);
    const w = p.ctx.measureText(k.w).width;
    const lim = maxW - (first ? (b.firstIndent || 0) : 0);
    if (lineW + w > lim && line.length && !/^\s+$/.test(k.w)) flush();
    if (!line.length && /^\s+$/.test(k.w)) continue;
    line.push(k); lineW += w;
  }
  if (line.length) flush();
  p.y += b.gap ?? 4;
}

export async function renderBlocks(blocks, opts = {}) {
  await loadPrintFonts();
  const p = new Pager(opts);
  p.serif = !!opts.serif;
  for (const b of blocks) {
    switch (b.t) {
      case 'pagebreak':
        p.newPage();
        break;
      case 'h1':
        p.para(b.text, { size: b.size || 20, bold: true, gapAfter: 4 });
        if (b.sub) p.para(b.sub, { size: 11, color: '#444', gapAfter: 10 });
        else p.y += 6;
        break;
      case 'h2':
        p.ensure(40);
        p.y += 6;
        p.para(b.text, { size: b.size || 13, bold: true, gapAfter: 4 });
        break;
      case 'p':
        p.para(b.text, { size: b.size || 11, bold: b.bold, color: b.muted ? '#555' : '#111', gapAfter: b.gap ?? 6 });
        break;
      case 'gap':
        p.y += b.h || 10;
        break;
      case 'line':
        p.ensure(8); p.y += 4; p.hline(M, M + p.width, p.y); p.y += 8;
        break;
      case 'kv': {
        const size = b.size || 11;
        const kw = p.width * (b.keyFrac || 0.38);
        for (const [k, v] of b.rows) {
          const vlines = p.wrap(v || '', size, false, p.width - kw - 8);
          const klines = p.wrap(k, size, true, kw - 8);
          const n = Math.max(vlines.length, klines.length);
          const rh = n * size * 1.4 + 8;
          p.ensure(rh);
          klines.forEach((l, i) => p.text(l, M, p.y + size * 1.4 * (i + 1), size, true));
          if (v) vlines.forEach((l, i) => p.text(l, M + kw, p.y + size * 1.4 * (i + 1), size, false));
          p.hline(M + kw, M + p.width, p.y + rh - 3, 0.5, v ? '#bbb' : '#111');
          p.y += rh;
        }
        p.y += 6;
        break;
      }
      case 'table':
        drawTable(p, b);
        break;
      case 'checklist': {
        const size = b.size || 11;
        for (const it of b.items) {
          const indent = (it.level || 0) * 16;
          const lines = p.wrap(it.text, size, it.level === 0 && b.boldTop, p.width - indent - 20);
          const rh = lines.length * size * 1.4 + 4;
          p.ensure(rh);
          const bx = M + indent, by = p.y + 3;
          p.rect(bx, by, 10, 10, 0.8);
          if (it.done) {
            const c = p.ctx; c.lineWidth = 1.4; c.beginPath(); c.moveTo(bx + 2, by + 5); c.lineTo(bx + 4.5, by + 8); c.lineTo(bx + 8.5, by + 2); c.stroke();
          }
          lines.forEach((l, i) => p.text(l, bx + 18, p.y + size * 1.4 * (i + 1) - 2, size, it.level === 0 && b.boldTop));
          p.y += rh;
        }
        p.y += 6;
        break;
      }
      case 'grid': {
        // Сетка карточек (наклейки), с пунктирной линией реза
        const cols = b.cols || 3, cellH = b.cellH || 80;
        const cw = p.width / cols;
        b.cells.forEach((cell, i) => {
          const col = i % cols;
          if (col === 0) p.ensure(cellH);
          const x = M + col * cw;
          p.rect(x, p.y, cw, cellH, 0.5, [3, 3]);
          const lines = cell.lines || [];
          const big = cell.size || 15;
          const blockH = lines.reduce((s, l, li) => s + (li === 0 ? big : 10) * 1.35, 0);
          let ty = p.y + (cellH - blockH) / 2;
          lines.forEach((l, li) => {
            const sz = li === 0 ? big : 10;
            ty += sz * 1.35;
            const wrapped = p.wrap(l, sz, li === 0, cw - 10)[0];
            p.text(wrapped, x + cw / 2, ty - sz * 0.3, sz, li === 0, li === 0 ? '#111' : '#444', 'center');
          });
          if (col === cols - 1 || i === b.cells.length - 1) p.y += cellH;
        });
        p.y += 8;
        break;
      }
      case 'big': {
        const size = b.size || 40;
        const lines = p.wrap(b.text, size, true, p.width);
        const hgt = lines.length * size * 1.2 + 10;
        p.ensure(hgt);
        lines.forEach((l, i) => p.text(l, M + p.width / 2, p.y + size * 1.1 * (i + 1), size, true, '#111', 'center'));
        p.y += hgt;
        break;
      }
      case 'sign': {
        for (const label of b.items) {
          p.ensure(36);
          p.y += 26;
          p.text(label, M, p.y, 10, false, '#333');
          p.hline(M + p.width * 0.4, M + p.width, p.y + 2);
          p.y += 6;
        }
        break;
      }
      case 'contents': {
        const size = 11;
        for (const r of b.rows) {
          const indent = r.level ? 14 : 0;
          const lines = p.wrap(r.title, size, !r.level, p.width - indent - 50);
          const rh = lines.length * size * 1.45 + 2;
          p.ensure(rh);
          lines.forEach((l, i) => p.text(l, M + indent, p.y + size * 1.45 * (i + 1), size, !r.level));
          if (r.page) p.text(String(r.page), M + p.width, p.y + size * 1.45, size, false, '#111', 'right');
          p.y += rh;
        }
        break;
      }
      case 'shelfcard':
        drawShelfCard(p, b);
        break;
      case 'xtable':
        drawXTable(p, b);
        break;
      case 'rich':
        drawRich(p, b);
        break;
      case 'center': {
        const size = b.size || 14, lh = b.lh || 1.3;
        const lines = p.wrap(b.text, size, b.bold, p.width, b.italic);
        p.ensure(lines.length * size * lh);
        for (const l of lines) {
          p.y += size * lh;
          p.text(l, M + p.width / 2, p.y - size * 0.28, size, b.bold, b.color || '#111', 'center', b.italic, b.underline);
        }
        p.y += b.gap ?? 4;
        break;
      }
      case 'left': {
        const size = b.size || 11, lh = b.lh || 1.3;
        const lines = p.wrap(b.text, size, b.bold, p.width - (b.indent || 0), b.italic);
        for (const l of lines) {
          p.ensure(size * lh); p.y += size * lh;
          p.text(l, M + (b.indent || 0), p.y - size * 0.28, size, b.bold, b.color || '#111', b.align || 'left', b.italic, b.underline);
        }
        p.y += b.gap ?? 2;
        break;
      }
      case 'rule': {
        p.y += b.before ?? 4;
        p.hline(M, M + p.width, p.y, b.w || 1.2);
        p.y += b.after ?? 8;
        break;
      }
      case 'fill': {
        // растянуть до низа страницы (для крупных табличек)
        if (b.center) { /* ничего */ }
        p.y = Math.max(p.y, b.y || p.y);
        break;
      }
      default:
        break;
    }
  }
  p.finishFooters();
  return p.pages;
}

// Карточка делений по образцу «ПЕЧАТЬ»: название, вариант, полки сверху вниз и свободные деления между ними
function drawShelfCard(p, b) {
  const perPage = b.perPage || 1;
  const gapY = perPage > 1 ? 10 : 0;
  const cardH = (p.H - 2 * M - gapY * (perPage - 1)) / perPage;
  if (p.y > M + 1 && p.y + cardH > p.H - M + 1) p.newPage();
  const y0 = p.y, x0 = M, W = p.width;
  const k = perPage === 1 ? 1 : perPage === 2 ? 0.72 : 0.5;
  p.rect(x0, y0, W, cardH, 1.4);
  let y = y0 + 10 * k;
  if (b.top) { p.text('↓ ' + b.top, x0 + W / 2, y + 12 * k, 12 * k, true, '#333', 'center'); y += 18 * k; }
  const tSize = (perPage === 1 ? 40 : perPage === 2 ? 28 : 18);
  const lines = p.wrap(b.title, tSize, true, W - 30);
  for (const l of lines) { y += tSize * 1.08; p.text(l, x0 + W / 2, y, tSize, true, '#111', 'center'); }
  if (b.tags && b.tags.length) { y += 15 * k + 4; p.text(b.tags.join('  ·  '), x0 + W / 2, y, 11 * k + 1, false, '#333', 'center'); }
  y += 10 * k + 6;
  const rows = b.rows || [];
  if (b.blankRows && !rows.length) {
    for (let i = 0; i < b.blankRows; i++) { y += 22 * k; if (y > y0 + cardH - 14) break; p.hline(x0 + 14, x0 + W - 14, y, 0.5, '#999'); }
  } else if (rows.length) {
    p.text('примерная расстановка полок/кронштейнов по количеству делений', x0 + 14, y + 9 * k, 10 * k + 1, false, '#333');
    y += 16 * k;
    const avail = y0 + cardH - y - (b.note ? 18 : 8);
    const step = Math.min(30 * k + 4, avail / (rows.length * 2));
    const fs = Math.max(7, Math.min(13 * k + 1, step * 0.62));
    const boxW = 64 * k + 10;
    const bx = x0 + W * 0.5;
    for (const r of rows) {
      // промежуток над полкой
      y += step;
      p.rect(bx - boxW / 2, y - step * 0.78, boxW, step * 0.72, 0.8);
      p.text(String(r.gap || ''), bx, y - step * 0.25, fs + (String(r.gap || '').length > 6 ? -2 : 1), true, '#111', 'center');
      p.text('свободных делений между', bx + boxW / 2 + 6, y - step * 0.27, fs - 1, false, '#333');
      // полка
      y += step;
      p.hline(x0 + 14, x0 + W * 0.36, y - step * 0.42, 1.6);
      p.text(`${r.shelf === 1 ? 'Нижние' : r.shelf} полка + кронштейн`, x0 + 14, y - step * 0.55, fs - 1, false, '#111');
    }
  }
  if (b.note) p.text(b.note, x0 + 14, y0 + cardH - 8, 9, false, '#555');
  p.y = y0 + cardH + gapY;
}

export function canvasToPng(canvas) {
  return new Promise((resolve) => canvas.toBlob(async (blob) => resolve(new Uint8Array(await blob.arrayBuffer())), 'image/png'));
}

export async function canvasesToPng(canvases) {
  const out = [];
  for (const c of canvases) out.push(await canvasToPng(c));
  return out;
}

export { A4 };
