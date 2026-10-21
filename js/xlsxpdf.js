// PDF из файла Excel так, как его напечатал бы Excel: ширины столбцов, высоты строк, объединения,
// рамки, заливки, шрифты, перенос и поворот текста, масштаб/«вписать», поля, разрывы страниц.
// Формулы пересчитываются (ссылки, IF/IFS/OR/AND, SUM и др.), так как заполненный файл ещё не открыт в Excel.
import { cssFont, loadFamily } from './wordpdf.js';

const { PDFDocument } = window.PDFLib;
const DPI = 200;
const PX = DPI / 72; // пикселей холста на пункт

async function zipLib() {
  if (window.JSZip) return window.JSZip;
  await new Promise((res, rej) => { const s = document.createElement('script'); s.src = new URL('../vendor/jszip.min.js', import.meta.url).href; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  return window.JSZip;
}

// ---------- адреса ----------
export const colNum = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
export const colName = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const parseRef = (r) => { const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(r); return m ? { c: colNum(m[1]), r: Number(m[2]) } : null; };
const key = (r, c) => r * 16384 + c;

// ---------- цвета ----------
const INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333'];
function tint(hex, t) {
  if (!t) return hex;
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.substr(i, 2), 16) / 255);
  // через HSL, как в Excel
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = t < 0 ? l * (1 + t) : l * (1 - t) + t;
  const hue = (p, q, x) => { if (x < 0) x += 1; if (x > 1) x -= 1; if (x < 1 / 6) return p + (q - p) * 6 * x; if (x < 1 / 2) return q; if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6; return p; };
  if (s === 0) r = g = b = l;
  else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q; r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3); }
  return [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

// ---------- чтение книги ----------
const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const kids = (el, name) => (el ? [...el.children].filter((x) => x.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;
const attr = (el, a, d = null) => (el && el.hasAttribute(a) ? el.getAttribute(a) : d);
const num = (el, a, d) => (el && el.hasAttribute(a) ? Number(el.getAttribute(a)) : d);

async function readBook(bytes) {
  const JSZip = await zipLib();
  const zip = await JSZip.loadAsync(bytes);
  const text = async (p) => { const f = zip.file(p); return f ? f.async('string') : null; };
  const wb = xml(await text('xl/workbook.xml'));
  const rels = xml(await text('xl/_rels/workbook.xml.rels'));
  const target = {};
  for (const r of rels.getElementsByTagName('Relationship')) target[r.getAttribute('Id')] = r.getAttribute('Target');
  const sheets = [...wb.getElementsByTagName('sheet')].map((s) => {
    const t = target[s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')];
    return { name: s.getAttribute('name'), state: s.getAttribute('state') || 'visible', path: t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '') };
  });
  const names = [...wb.getElementsByTagName('definedName')].map((d) => ({ name: d.getAttribute('name'), sheet: d.hasAttribute('localSheetId') ? Number(d.getAttribute('localSheetId')) : null, ref: d.textContent }));
  // тема
  const themeColors = [];
  const th = await text('xl/theme/theme1.xml');
  if (th) {
    const cs = xml(th).getElementsByTagNameNS('*', 'clrScheme')[0];
    const order = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
    for (const n of order) {
      const el = cs && cs.getElementsByTagNameNS('*', n)[0];
      const c = el && el.firstElementChild;
      themeColors.push(c ? (c.getAttribute('lastClr') || c.getAttribute('val') || '000000') : '000000');
    }
  }
  const color = (el, def = null) => {
    if (!el) return def;
    if (el.hasAttribute('rgb')) return tint(el.getAttribute('rgb').slice(-6), num(el, 'tint', 0));
    if (el.hasAttribute('theme')) return tint(themeColors[Number(el.getAttribute('theme'))] || '000000', num(el, 'tint', 0));
    if (el.hasAttribute('indexed')) { const i = Number(el.getAttribute('indexed')); return i === 64 || i === 65 ? def : tint(INDEXED[i] || '000000', num(el, 'tint', 0)); }
    return def;
  };
  // стили
  const st = xml(await text('xl/styles.xml'));
  const numFmts = {};
  for (const n of st.getElementsByTagName('numFmt')) numFmts[n.getAttribute('numFmtId')] = n.getAttribute('formatCode');
  const fontOf = (f) => ({
    name: attr(kid(f, 'name') || kid(f, 'rFont'), 'val', 'Calibri'), size: num(kid(f, 'sz'), 'val', 11),
    b: !!kid(f, 'b') && attr(kid(f, 'b'), 'val', '1') !== '0', i: !!kid(f, 'i') && attr(kid(f, 'i'), 'val', '1') !== '0',
    u: !!kid(f, 'u') && attr(kid(f, 'u'), 'val', 'single') !== 'none', s: !!kid(f, 'strike') && attr(kid(f, 'strike'), 'val', '1') !== '0',
    color: color(kid(f, 'color'), '000000'), vert: attr(kid(f, 'vertAlign'), 'val'),
  });
  const fonts = kids(kid(st.documentElement, 'fonts'), 'font').map(fontOf);
  const fills = kids(kid(st.documentElement, 'fills'), 'fill').map((f) => {
    const p = kid(f, 'patternFill');
    if (!p || (attr(p, 'patternType', 'none') === 'none')) return null;
    return attr(p, 'patternType') === 'solid' ? color(kid(p, 'fgColor'), null) : null;
  });
  const borders = kids(kid(st.documentElement, 'borders'), 'border').map((b) => {
    const side = (n) => { const e = kid(b, n); const s = attr(e, 'style'); return s ? { style: s, color: color(kid(e, 'color'), '000000') } : null; };
    return { l: side('left') || side('start'), r: side('right') || side('end'), t: side('top'), b: side('bottom') };
  });
  const xfs = kids(kid(st.documentElement, 'cellXfs'), 'xf').map((x) => {
    const a = kid(x, 'alignment');
    return {
      font: fonts[num(x, 'fontId', 0)] || fonts[0], fill: fills[num(x, 'fillId', 0)] || null, border: borders[num(x, 'borderId', 0)] || {},
      numFmt: num(x, 'numFmtId', 0),
      h: attr(a, 'horizontal', 'general'), v: attr(a, 'vertical', 'bottom'), wrap: attr(a, 'wrapText') === '1' || attr(a, 'wrapText') === 'true',
      rot: num(a, 'textRotation', 0), indent: num(a, 'indent', 0), shrink: attr(a, 'shrinkToFit') === '1',
    };
  });
  // строки
  const sst = [];
  const ss = await text('xl/sharedStrings.xml');
  if (ss) for (const si of xml(ss).getElementsByTagName('si')) sst.push(richText(si, fontOf));
  return { zip, text, sheets, names, xfs, fonts, numFmts, sst, color, fontOf };
}

function richText(si, fontOf) {
  const rs = kids(si, 'r');
  if (!rs.length) return { text: kids(si, 't').map((t) => t.textContent).join('') };
  const runs = rs.map((r) => ({ text: kids(r, 't').map((t) => t.textContent).join(''), font: kid(r, 'rPr') ? fontOf(kid(r, 'rPr')) : null }));
  return { text: runs.map((r) => r.text).join(''), runs };
}

async function readSheet(book, sh) {
  const doc = xml(await book.text(sh.path));
  const ws = doc.documentElement;
  const cells = new Map();
  const shared = {};
  for (const row of ws.getElementsByTagName('row')) {
    for (const c of kids(row, 'c')) {
      const p = parseRef(c.getAttribute('r'));
      if (!p) continue;
      const t = c.getAttribute('t') || 'n';
      const vEl = kid(c, 'v');
      const fEl = kid(c, 'f');
      let v = null;
      if (t === 's' && vEl) v = book.sst[Number(vEl.textContent)] || { text: '' };
      else if (t === 'inlineStr') v = richText(kid(c, 'is') || c, book.fontOf);
      else if (t === 'str' || t === 'e') v = vEl ? { text: vEl.textContent } : null;
      else if (t === 'b') v = vEl ? vEl.textContent === '1' : null;
      else if (vEl && vEl.textContent !== '') v = Number(vEl.textContent);
      let f = null;
      if (fEl) {
        const si = fEl.getAttribute('si');
        if (fEl.getAttribute('t') === 'shared' && si !== null) {
          if (fEl.textContent) { shared[si] = { f: fEl.textContent, r: p.r, c: p.c }; f = fEl.textContent; }
          else if (shared[si]) f = shiftFormula(shared[si].f, p.r - shared[si].r, p.c - shared[si].c);
        } else if (fEl.textContent) f = fEl.textContent;
      }
      cells.set(key(p.r, p.c), { r: p.r, c: p.c, s: num(c, 's', 0), v, f });
    }
  }
  const rows = {};
  for (const row of ws.getElementsByTagName('row')) {
    const r = Number(row.getAttribute('r'));
    rows[r] = { ht: row.hasAttribute('ht') ? Number(row.getAttribute('ht')) : null, hidden: row.getAttribute('hidden') === '1', s: row.getAttribute('customFormat') === '1' ? num(row, 's', 0) : null };
  }
  const cols = [];
  for (const c of ws.getElementsByTagName('col')) {
    for (let i = num(c, 'min', 1); i <= num(c, 'max', 1); i++) cols[i] = { width: num(c, 'width', null), hidden: c.getAttribute('hidden') === '1', s: num(c, 'style', 0) };
  }
  const fmt = kid(ws, 'sheetFormatPr');
  const merges = [...ws.getElementsByTagName('mergeCell')].map((m) => {
    const [a, b] = m.getAttribute('ref').split(':').map(parseRef);
    return { r1: a.r, c1: a.c, r2: (b || a).r, c2: (b || a).c };
  });
  const ps = kid(ws, 'pageSetup');
  const pr = kid(ws, 'sheetPr');
  const pm = kid(ws, 'pageMargins');
  const po = kid(ws, 'printOptions');
  const brk = (n) => { const e = kid(ws, n); return e ? kids(e, 'brk').map((b) => num(b, 'id', 0)) : []; };
  return {
    cells, rows, cols, merges,
    defRowHt: num(fmt, 'defaultRowHeight', null), defColW: num(fmt, 'defaultColWidth', null), baseColW: num(fmt, 'baseColWidth', 8),
    page: {
      paper: num(ps, 'paperSize', 9), landscape: attr(ps, 'orientation') === 'landscape', scale: num(ps, 'scale', 100),
      fit: !!(pr && kid(pr, 'pageSetUpPr') && ['1', 'true'].includes(attr(kid(pr, 'pageSetUpPr'), 'fitToPage'))),
      fitW: num(ps, 'fitToWidth', 1), fitH: num(ps, 'fitToHeight', 1), order: attr(ps, 'pageOrder', 'downThenOver'),
      margins: { l: num(pm, 'left', 0.7), r: num(pm, 'right', 0.7), t: num(pm, 'top', 0.75), b: num(pm, 'bottom', 0.75) },
      hCenter: ['1', 'true'].includes(attr(po, 'horizontalCentered')), vCenter: ['1', 'true'].includes(attr(po, 'verticalCentered')),
      grid: ['1', 'true'].includes(attr(po, 'gridLines')),
      rowBreaks: brk('rowBreaks'), colBreaks: brk('colBreaks'),
    },
  };
}

// сдвиг относительных ссылок в общей формуле
function shiftFormula(f, dr, dc) {
  return f.replace(/('[^']+'|[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё.]*)?(!)?(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\w(])/g, (m, sh, bang, cd, col, rd, row, off, str) => {
    // не трогаем текст в кавычках
    const before = str.slice(0, off);
    if ((before.match(/"/g) || []).length % 2) return m;
    if (sh && !bang) return m;
    const c = cd ? col : colName(colNum(col) + dc);
    const r = rd ? row : String(Number(row) + dr);
    return `${sh || ''}${bang || ''}${cd}${c}${rd}${r}`;
  });
}

// ---------- формулы ----------
function tokenize(f) {
  const t = [];
  let i = 0;
  while (i < f.length) {
    const ch = f[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') { let j = i + 1, s = ''; while (j < f.length) { if (f[j] === '"') { if (f[j + 1] === '"') { s += '"'; j += 2; continue; } break; } s += f[j++]; } t.push({ t: 'str', v: s }); i = j + 1; continue; }
    const two = f.substr(i, 2);
    if (['<=', '>=', '<>'].includes(two)) { t.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/^&=<>%'.includes(ch)) { t.push({ t: 'op', v: ch }); i++; continue; }
    if ('(),;:'.includes(ch)) { t.push({ t: ch === ';' ? ',' : ch }); i++; continue; }
    let m = /^(?:'((?:[^']|'')+)'|([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё.]*))!(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)/.exec(f.slice(i));
    if (m) { t.push({ t: 'ref', sheet: (m[1] || m[2]).replace(/''/g, "'"), ref: m[3] }); i += m[0].length; continue; }
    m = /^\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?(?![\w(])/.exec(f.slice(i));
    if (m) { t.push({ t: 'ref', sheet: null, ref: m[0] }); i += m[0].length; continue; }
    m = /^\d+(\.\d+)?(E[+-]?\d+)?/i.exec(f.slice(i));
    if (m) { t.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
    m = /^(TRUE|FALSE)(?![\w(])/i.exec(f.slice(i));
    if (m) { t.push({ t: 'bool', v: m[1].toUpperCase() === 'TRUE' }); i += m[0].length; continue; }
    m = /^(?:_xlfn\.)?([A-Za-z][\w.]*)\s*\(/.exec(f.slice(i));
    if (m) { t.push({ t: 'fn', v: m[1].toUpperCase() }); i += m[0].length; continue; }
    throw new Error('формула: ' + f.slice(i, i + 10));
  }
  return t;
}
function parse(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const PREC = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };
  function primary() {
    const tk = tokens[i++];
    if (!tk) throw new Error('конец формулы');
    if (tk.t === 'num' || tk.t === 'str' || tk.t === 'bool') return { k: 'lit', v: tk.v };
    if (tk.t === 'ref') return { k: 'ref', sheet: tk.sheet, ref: tk.ref };
    if (tk.t === 'op' && (tk.v === '-' || tk.v === '+')) { const e = unary(); return tk.v === '-' ? { k: 'neg', e } : e; }
    if (tk.t === '(') { const e = expr(0); i++; return e; }
    if (tk.t === 'fn') {
      const args = [];
      if (peek() && peek().t === ')') { i++; return { k: 'fn', n: tk.v, args }; }
      for (;;) {
        if (peek() && (peek().t === ',' || peek().t === ')')) args.push({ k: 'lit', v: null });
        else args.push(expr(0));
        const sep = tokens[i++];
        if (!sep || sep.t === ')') break;
      }
      return { k: 'fn', n: tk.v, args };
    }
    throw new Error('формула: неожиданное ' + (tk.v || tk.t));
  }
  function unary() { let e = primary(); while (peek() && peek().t === 'op' && peek().v === '%') { i++; e = { k: 'bin', op: '/', a: e, b: { k: 'lit', v: 100 } }; } return e; }
  function expr(minP) {
    let a = unary();
    for (;;) {
      const tk = peek();
      if (!tk || tk.t !== 'op' || !(tk.v in PREC) || PREC[tk.v] < minP) break;
      i++;
      const b = expr(PREC[tk.v] + (tk.v === '^' ? 0 : 1));
      a = { k: 'bin', op: tk.v, a, b };
    }
    return a;
  }
  const e = expr(0);
  return e;
}

class Calc {
  constructor(book, sheets) { this.book = book; this.sheets = sheets; this.memo = new Map(); this.stack = new Set(); }
  sheet(name) { return this.sheets[name]; }
  cellValue(sheetName, r, c) {
    const sh = this.sheets[sheetName];
    if (!sh) return null;
    const cell = sh.cells.get(key(r, c));
    if (!cell) return null;
    if (!cell.f) return cell.v && typeof cell.v === 'object' ? cell.v.text : cell.v;
    const mk = sheetName + '!' + key(r, c);
    if (this.memo.has(mk)) return this.memo.get(mk);
    if (this.stack.has(mk)) return cell.v && typeof cell.v === 'object' ? cell.v.text : cell.v;
    this.stack.add(mk);
    let v;
    try {
      v = this.evalNode(parse(tokenize(cell.f)), sheetName);
      if (v && v.range) v = v.range[0] !== undefined ? v.range[0] : null;
      if (v === null || v === undefined) v = 0; // ссылка на пустую ячейку Excel показывает как 0
    }
    catch (e) { v = cell.v && typeof cell.v === 'object' ? cell.v.text : cell.v; }
    this.stack.delete(mk);
    this.memo.set(mk, v);
    return v;
  }
  rangeVals(sheet, ref) {
    const [a, b] = ref.split(':').map(parseRef);
    const out = [];
    for (let r = a.r; r <= (b || a).r; r++) for (let c = a.c; c <= (b || a).c; c++) out.push(this.cellValue(sheet, r, c));
    return out;
  }
  evalNode(n, sheet) {
    const ev = (x) => { const v = this.evalNode(x, sheet); return v && v.range ? v.range[0] : v; };
    switch (n.k) {
      case 'lit': return n.v;
      case 'ref': {
        const sh = n.sheet || sheet;
        if (n.ref.includes(':')) return { range: this.rangeVals(sh, n.ref.replace(/\$/g, '')) };
        const p = parseRef(n.ref.replace(/\$/g, ''));
        return this.cellValue(sh, p.r, p.c);
      }
      case 'neg': return -toNum(ev(n.e));
      case 'bin': {
        const a = ev(n.a), b = ev(n.b);
        switch (n.op) {
          case '+': return toNum(a) + toNum(b);
          case '-': return toNum(a) - toNum(b);
          case '*': return toNum(a) * toNum(b);
          case '/': return toNum(a) / toNum(b);
          case '^': return Math.pow(toNum(a), toNum(b));
          case '&': return toStr(a) + toStr(b);
          default: return compare(a, b, n.op);
        }
      }
      case 'fn': return this.fn(n, sheet, ev);
      default: return null;
    }
  }
  fn(n, sheet, ev) {
    const A = n.args;
    const flat = () => A.flatMap((x) => { const v = this.evalNode(x, sheet); return v && v.range ? v.range : [v]; });
    switch (n.n) {
      case 'IF': return truthy(ev(A[0])) ? (A[1] ? ev(A[1]) : true) : (A[2] ? ev(A[2]) : false);
      case 'IFS': for (let i = 0; i + 1 < A.length; i += 2) if (truthy(ev(A[i]))) return ev(A[i + 1]); return null;
      case 'IFERROR': { try { const v = ev(A[0]); return Number.isNaN(v) || v === Infinity ? ev(A[1]) : v; } catch (e) { return ev(A[1]); } }
      case 'OR': return flat().some(truthy);
      case 'AND': return flat().every(truthy);
      case 'NOT': return !truthy(ev(A[0]));
      case 'SUM': return flat().reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
      case 'MIN': return Math.min(...flat().filter((v) => typeof v === 'number'));
      case 'MAX': return Math.max(...flat().filter((v) => typeof v === 'number'));
      case 'COUNT': return flat().filter((v) => typeof v === 'number').length;
      case 'COUNTA': return flat().filter((v) => v !== null && v !== '').length;
      case 'COUNTIF': { const vals = this.evalNode(A[0], sheet); const crit = ev(A[1]); return (vals.range || [vals]).filter((v) => toStr(v) === toStr(crit)).length; }
      case 'CONCATENATE': case 'CONCAT': return flat().map(toStr).join('');
      case 'ROUND': { const k = Math.pow(10, toNum(ev(A[1]))); return Math.round(toNum(ev(A[0])) * k) / k; }
      case 'LEN': return toStr(ev(A[0])).length;
      case 'UPPER': return toStr(ev(A[0])).toUpperCase();
      case 'TRIM': return toStr(ev(A[0])).trim().replace(/\s+/g, ' ');
      case 'ISBLANK': return ev(A[0]) === null || ev(A[0]) === '';
      default: throw new Error('функция ' + n.n);
    }
  }
}
const toNum = (v) => (typeof v === 'number' ? v : typeof v === 'boolean' ? +v : v === null || v === '' ? 0 : Number(String(v).replace(',', '.')) || 0);
const toStr = (v) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? fmtGeneral(v) : String(v));
const truthy = (v) => (typeof v === 'string' ? v !== '' && v.toUpperCase() !== 'FALSE' : !!v);
function compare(a, b, op) {
  let x = a, y = b;
  if (x === null) x = typeof y === 'number' ? 0 : '';
  if (y === null) y = typeof x === 'number' ? 0 : '';
  if (typeof x === 'string' && typeof y === 'string') { x = x.toLowerCase(); y = y.toLowerCase(); }
  else if (typeof x !== typeof y) { x = toStr(x); y = toStr(y); }
  switch (op) { case '=': return x === y; case '<>': return x !== y; case '<': return x < y; case '>': return x > y; case '<=': return x <= y; default: return x >= y; }
}

// ---------- числа ----------
function fmtGeneral(v) {
  if (Number.isInteger(v)) return String(v);
  const s = Math.abs(v) >= 1e11 || (Math.abs(v) < 1e-9 && v !== 0) ? v.toExponential(5) : String(Number(v.toPrecision(10)));
  return s.replace('.', ',');
}
function fmtNumber(v, id, codes) {
  if (typeof v !== 'number') return toStr(v);
  const code = codes[id] || { 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 14: 'dd.mm.yyyy', 20: 'h:mm', 21: 'h:mm:ss', 49: '@' }[id];
  if (!code || code === 'General' || code === '@') return fmtGeneral(v);
  const sec = code.split(';');
  let c = v < 0 && sec[1] ? sec[1] : sec[0];
  if (v === 0 && sec[2]) c = sec[2];
  c = c.replace(/\[[^\]]*\]/g, '').replace(/"([^"]*)"/g, '$1').replace(/\\(.)/g, '$1').replace(/_.|\*./g, '');
  if (/[dmyhs]/i.test(c) && !/0/.test(c)) {
    const d = new Date(Math.round((v - 25569) * 86400000));
    const p = (x, n = 2) => String(x).padStart(n, '0');
    return c.replace(/yyyy/gi, d.getUTCFullYear()).replace(/yy/gi, String(d.getUTCFullYear()).slice(2)).replace(/dd/gi, p(d.getUTCDate())).replace(/d/gi, d.getUTCDate())
      .replace(/hh|h/gi, (m) => (m.length > 1 ? p(d.getUTCHours()) : d.getUTCHours())).replace(/ss/gi, p(d.getUTCSeconds()))
      .replace(/mm|m/gi, (m, off, s) => (/h.*$/i.test(s.slice(0, off)) || /^:?s/i.test(s.slice(off + m.length)) ? p(d.getUTCMinutes()) : m.length > 1 ? p(d.getUTCMonth() + 1) : d.getUTCMonth() + 1));
  }
  const pct = c.includes('%');
  let x = pct ? v * 100 : v;
  const dec = (/\.(0+)/.exec(c) || [, ''])[1].length;
  const group = /#,##0|0,000/.test(c);
  let s = Math.abs(x).toFixed(dec);
  let [ip, fp] = s.split('.');
  if (group) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  s = (x < 0 && !sec[1] ? '-' : '') + ip + (fp ? ',' + fp : '') + (pct ? '%' : '');
  const pre = c.slice(0, c.search(/[0#]/));
  const post = c.slice(c.search(/[0#][^0#]*$/) + 1).replace('%', '');
  return (pre.replace(/[#0,.]/g, '') + s + post.replace(/[#0,.]/g, '')).trim();
}

// ---------- геометрия ----------
function measureMdw(font) {
  const c = document.createElement('canvas').getContext('2d');
  c.font = cssFont(font.name, font.size * 96 / 72).css;
  return Math.round(Math.max(...'0123456789'.split('').map((d) => c.measureText(d).width)));
}

const PAPER = { 1: [612, 792], 5: [612, 1008], 8: [841.89, 1190.55], 9: [595.28, 841.89], 11: [419.53, 595.28] };

// Ширина столбца. Excel для Mac (на нём сделаны ваши файлы) считает её в настоящих пунктах:
// ширина × ширина цифры шрифта по умолчанию; Excel для Windows — в целых пикселях.
function digitPt(font) {
  const c = document.createElement('canvas').getContext('2d');
  c.font = cssFont(font.name, font.size).css;
  return Math.max(...'0123456789'.split('').map((d) => c.measureText(d).width));
}
export const XL = { mac: true };
function layoutSheet(book, sh) {
  const font0 = book.fonts[0] || { name: 'Calibri', size: 11 };
  const mdw = measureMdw(font0);
  const dw = digitPt(font0);
  const pxW = (w) => Math.trunc(((256 * w + Math.trunc(128 / mdw)) / 256) * mdw);
  // Mac: ширина символа — полпункта кратно (Calibri 12 → 6 пт, 11 → 5,5 пт)
  const macDw = Math.round(dw * 2) / 2;
  const wPt = (w) => (XL.mac ? w * macDw : pxW(w) * 0.75);
  const defW = sh.defColW !== null ? wPt(sh.defColW) : XL.mac ? (sh.baseColW + 0.83) * macDw : Math.ceil((sh.baseColW * mdw + 5) / 8) * 8 * 0.75;
  const colPt = (c) => { const x = sh.cols[c]; if (x && x.hidden) return 0; return x && x.width !== null ? wPt(x.width) : defW; };
  const defH = sh.defRowHt || Math.round(font0.size * 1.3 * 4) / 4 + 0.25;
  // Mac печатает строки на 1/16 ниже записанной высоты (16 пт → 15), сверено с вашей печатью «Делений»
  const rk = XL.mac ? 15 / 16 : 1;
  const rowPt = (r) => { const x = sh.rows[r]; if (x && x.hidden) return 0; return (x && x.ht !== null ? x.ht : defH) * rk; };
  return { colPt, rowPt, mdw };
}

// печатаемый диапазон: область печати или занятые ячейки
function printRange(book, sh, sheetIdx) {
  const pa = book.names.find((n) => n.name === '_xlnm.Print_Area' && n.sheet === sheetIdx);
  if (pa) {
    const m = /\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)/.exec(pa.ref);
    if (m) return { r1: Number(m[2]), c1: colNum(m[1]), r2: Number(m[4]), c2: colNum(m[3]) };
  }
  let r1 = Infinity, c1 = Infinity, r2 = 0, c2 = 0;
  const add = (r, c) => { r1 = Math.min(r1, r); c1 = Math.min(c1, c); r2 = Math.max(r2, r); c2 = Math.max(c2, c); };
  for (const cell of sh.cells.values()) {
    const xf = book.xfs[cell.s] || {};
    const b = xf.border || {};
    if ((cell.v !== null && cell.v !== '' && !(cell.v && cell.v.text === '')) || cell.f || xf.fill || b.l || b.r || b.t || b.b) add(cell.r, cell.c);
  }
  for (const m of sh.merges) { add(m.r1, m.c1); add(m.r2, m.c2); }
  if (r2 === 0) return null;
  return { r1: 1, c1: 1, r2, c2 };
}

function bands(sizes, start, end, avail, breaks) {
  const out = [];
  let a = start, acc = 0;
  for (let i = start; i <= end; i++) {
    const s = sizes(i);
    if (i > a && (acc + s > avail + 0.01 || breaks.includes(i - 1))) { out.push([a, i - 1]); a = i; acc = 0; }
    acc += s;
  }
  out.push([a, end]);
  return out;
}

// ---------- рисование ----------
const BORDER_W = { hair: 0.35, thin: 0.6, dotted: 0.6, dashed: 0.6, dashDot: 0.6, dashDotDot: 0.6, medium: 1.3, mediumDashed: 1.3, mediumDashDot: 1.3, mediumDashDotDot: 1.3, slantDashDot: 1.3, thick: 2, double: 0.5 };
const DASH = { dotted: [0.6, 1.2], dashed: [2.4, 1.2], dashDot: [3, 1, 1, 1], dashDotDot: [3, 1, 1, 1, 1, 1], mediumDashed: [4, 2], mediumDashDot: [4, 1.5, 1.5, 1.5], mediumDashDotDot: [4, 1.5, 1.5, 1.5, 1.5, 1.5], hair: [] };

/**
 * xlsx -> PDF. opts.sheet — имя листа (по умолчанию первый видимый).
 */
export async function xlsxToPdf(bytes, { sheet, onProgress, debug, scale: forceScale, keep, lastCol } = {}) {
  const book = await readBook(bytes);
  const loaded = {};
  for (const s of book.sheets) loaded[s.name] = await readSheet(book, s);
  const idx = sheet ? book.sheets.findIndex((s) => s.name === sheet) : book.sheets.findIndex((s) => s.state === 'visible');
  const sh = loaded[book.sheets[idx].name];
  const calc = new Calc(book, loaded);
  await Promise.all(['Carlito', 'LibSans', 'LibSerif'].map(loadFamily));
  await document.fonts.ready;

  const { colPt, rowPt } = layoutSheet(book, sh);
  const range = printRange(book, sh, idx);
  // печатать только до указанного столбца (служебные формулы правее бланка не нужны)
  if (range && lastCol) range.c2 = Math.min(range.c2, typeof lastCol === 'string' ? colNum(lastCol) : lastCol);
  const out = await PDFDocument.create();
  out.setCreator('Памятки ОСП');
  if (!range) { out.addPage([595.28, 841.89]); return out.save(); }
  const P = sh.page;
  let [pw, ph] = PAPER[P.paper] || PAPER[9];
  if (P.landscape) [pw, ph] = [ph, pw];
  const M = { l: P.margins.l * 72, r: P.margins.r * 72, t: P.margins.t * 72, b: P.margins.b * 72 };
  const availW = pw - M.l - M.r, availH = ph - M.t - M.b;
  let totalW = 0, totalH = 0;
  for (let c = range.c1; c <= range.c2; c++) totalW += colPt(c);
  for (let r = range.r1; r <= range.r2; r++) totalH += rowPt(r);
  let scale = P.scale / 100;
  if (P.fit) {
    const sw = P.fitW > 0 ? (availW * P.fitW) / totalW : Infinity;
    const shh = P.fitH > 0 ? (availH * P.fitH) / totalH : Infinity;
    scale = Math.max(0.1, Math.min(1, sw, shh));
    // Excel округляет масштаб до целого процента вниз
    scale = Math.round(scale * 100) / 100;
  }
  if (forceScale) scale = forceScale;
  if (debug === true) return { totalW, totalH, availW, availH, scale, stored: P.scale, fit: P.fit, fitW: P.fitW, fitH: P.fitH, range, mdw: layoutSheet(book, sh).mdw };
  // «вписать в 1 страницу» — без разрывов, даже если округление масштаба дало лишние доли пункта
  const colBands = P.fit && P.fitW === 1 && !forceScale ? [[range.c1, range.c2]] : bands(colPt, range.c1, range.c2, availW / scale, P.colBreaks);
  const rowBands = P.fit && P.fitH === 1 && !forceScale ? [[range.r1, range.r2]] : bands(rowPt, range.r1, range.r2, availH / scale, P.rowBreaks);
  const pagesList = [];
  if (P.order === 'overThenDown') { for (const rb of rowBands) for (const cb of colBands) pagesList.push([rb, cb]); }
  else for (const cb of colBands) for (const rb of rowBands) pagesList.push([rb, cb]);

  // объединения: быстрый поиск
  const mergeAt = new Map();
  for (const m of sh.merges) for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) mergeAt.set(key(r, c), m);
  const xfOf = (r, c) => {
    const cell = sh.cells.get(key(r, c));
    if (cell) return book.xfs[cell.s] || book.xfs[0];
    const row = sh.rows[r];
    if (row && row.s !== null) return book.xfs[row.s] || book.xfs[0];
    const col = sh.cols[c];
    return book.xfs[(col && col.s) || 0] || book.xfs[0];
  };
  const display = (r, c) => {
    const cell = sh.cells.get(key(r, c));
    if (!cell) return null;
    const xf = book.xfs[cell.s] || book.xfs[0];
    const v = cell.f ? calc.cellValue(book.sheets[idx].name, r, c) : cell.v;
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'object') return v.text === '' ? null : { text: v.text, runs: v.runs, isNum: false };
    if (typeof v === 'boolean') return { text: v ? 'ИСТИНА' : 'ЛОЖЬ', isNum: false, bool: true };
    if (typeof v === 'number') return { text: fmtNumber(v, xf.numFmt, book.numFmts), isNum: true };
    return { text: String(v), isNum: false };
  };

  // Excel не печатает пустые страницы
  const hasInk = ([r1, r2], [c1, c2]) => {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      const cell = sh.cells.get(key(r, c));
      const xf = cell ? book.xfs[cell.s] || {} : null;
      if (cell && (display(r, c) || (xf && (xf.fill || (xf.border && (xf.border.l || xf.border.r || xf.border.t || xf.border.b)))))) return true;
      const m = mergeAt.get(key(r, c));
      if (m && display(m.r1, m.c1)) return true;
    }
    return false;
  };
  const printable = pagesList.filter(([rb, cb]) => hasInk(rb, cb) && (!keep || keep(rb, cb)));
  if (debug === 'pages') return printable.map(([rb, cb]) => { let t = ''; for (let r = rb[0]; r <= rb[1] && !t; r++) for (let c = cb[0]; c <= cb[1] && !t; c++) { const d = display(r, c); if (d && d.text.length > 3) t = d.text; } return [rb, cb, t]; });
  let n = 0;
  for (const [[r1, r2], [c1, c2]] of printable) {
    onProgress && onProgress(++n, printable.length);
    // координаты в пунктах листа (до масштаба)
    const xs = [0]; for (let c = c1; c <= c2; c++) xs.push(xs[xs.length - 1] + colPt(c));
    const ys = [0]; for (let r = r1; r <= r2; r++) ys.push(ys[ys.length - 1] + rowPt(r));
    const X = (c) => xs[Math.min(Math.max(c - c1, 0), xs.length - 1)];
    const Y = (r) => ys[Math.min(Math.max(r - r1, 0), ys.length - 1)];
    const W = xs[xs.length - 1], Hh = ys[ys.length - 1];
    let ox = M.l, oy = M.t;
    if (P.hCenter) ox = M.l + (availW - W * scale) / 2;
    if (P.vCenter) oy = M.t + (availH - Hh * scale) / 2;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(pw * PX); canvas.height = Math.round(ph * PX);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(PX * scale, 0, 0, PX * scale, ox * PX, oy * PX);

    // прямоугольник ячейки (с учётом объединения), видимая часть на странице
    const box = (r, c) => {
      const m = mergeAt.get(key(r, c));
      if (m) return { x: X(m.c1), y: Y(m.r1), w: X(m.c2 + 1) - X(m.c1), h: Y(m.r2 + 1) - Y(m.r1), m };
      return { x: X(c), y: Y(r), w: colPt(c), h: rowPt(r), m: null };
    };
    // 1) заливки
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      const m = mergeAt.get(key(r, c));
      if (m && (m.r1 !== r || m.c1 !== c) && !(r === r1 && m.r1 < r1 && c === Math.max(c1, m.c1)) && !(c === c1 && m.c1 < c1 && r === Math.max(r1, m.r1))) continue;
      const xf = m ? xfOf(m.r1, m.c1) : xfOf(r, c);
      if (!xf.fill) continue;
      const b = box(r, c);
      ctx.fillStyle = '#' + xf.fill;
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
    if (P.grid) {
      ctx.strokeStyle = '#c0c0c0'; ctx.lineWidth = 0.3 / scale;
      ctx.beginPath();
      for (const x of xs) { ctx.moveTo(x, 0); ctx.lineTo(x, Hh); }
      for (const y of ys) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
      ctx.stroke();
    }
    // 2) рамки: собираем края; у объединённых — рамки краевых ячеек
    const drawEdge = (side, x1, y1, x2, y2) => {
      if (!side) return;
      const w = (BORDER_W[side.style] || 0.6) / scale;
      ctx.strokeStyle = '#' + (side.color || '000000');
      ctx.setLineDash((DASH[side.style] || []).map((d) => d / scale));
      if (side.style === 'double') {
        const dx = y1 === y2 ? 0 : 0.7 / scale, dy = y1 === y2 ? 0.7 / scale : 0;
        ctx.lineWidth = w;
        ctx.beginPath(); ctx.moveTo(x1 - dx, y1 - dy); ctx.lineTo(x2 - dx, y2 - dy); ctx.moveTo(x1 + dx, y1 + dy); ctx.lineTo(x2 + dx, y2 + dy); ctx.stroke();
      } else {
        ctx.lineWidth = w;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
    };
    const edgeOf = (r, c, s) => {
      const m = mergeAt.get(key(r, c));
      // у объединения рамку задаёт каждая краевая ячейка; если у неё нет — берём у главной
      const own = (sh.cells.get(key(r, c)) ? xfOf(r, c).border : null) || {};
      if (own[s]) return own[s];
      if (m) { const main = xfOf(m.r1, m.c1).border || {}; return main[s]; }
      return xfOf(r, c).border ? xfOf(r, c).border[s] : null;
    };
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      const m = mergeAt.get(key(r, c));
      const x0 = X(c), x1 = X(c + 1), y0 = Y(r), y1 = Y(r + 1);
      // внутренние края объединения не рисуем
      const inL = m && c > m.c1, inR = m && c < m.c2, inT = m && r > m.r1, inB = m && r < m.r2;
      // соседние ячейки могут задавать ту же линию — рисуем левую/верхнюю от себя, правую/нижнюю если сосед не задал
      if (!inT) { const s = edgeOf(r, c, 't') || (r > r1 ? edgeOf(r - 1, c, 'b') : null); drawEdge(s, x0, y0, x1, y0); }
      if (!inL) { const s = edgeOf(r, c, 'l') || (c > c1 ? edgeOf(r, c - 1, 'r') : null); drawEdge(s, x0, y0, x0, y1); }
      if (!inB && (r === r2 || !edgeOf(r + 1, c, 't'))) drawEdge(edgeOf(r, c, 'b'), x0, y1, x1, y1);
      if (!inR && (c === c2 || !edgeOf(r, c + 1, 'l'))) drawEdge(edgeOf(r, c, 'r'), x1, y0, x1, y1);
    }
    ctx.setLineDash([]);

    // 3) текст
    const filled = (r, c) => { const cell = sh.cells.get(key(r, c)); return !!(cell && display(r, c)) || mergeAt.has(key(r, c)); };
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      const m = mergeAt.get(key(r, c));
      if (m && (m.r1 !== r || m.c1 !== c)) {
        // главная ячейка объединения на другой странице: рисуем в первой видимой
        if (!((r === Math.max(r1, m.r1)) && (c === Math.max(c1, m.c1)) && (m.r1 < r1 || m.c1 < c1))) continue;
      }
      const rr = m ? m.r1 : r, cc = m ? m.c1 : c;
      const d = display(rr, cc);
      if (!d) continue;
      const xf = xfOf(rr, cc);
      const b = m ? { x: X(m.c1) - (m.c1 < c1 ? sumCols(colPt, m.c1, c1 - 1) : 0), y: Y(m.r1) - (m.r1 < r1 ? sumRows(rowPt, m.r1, r1 - 1) : 0), w: sumCols(colPt, m.c1, m.c2), h: sumRows(rowPt, m.r1, m.r2) } : { x: X(c), y: Y(r), w: colPt(c), h: rowPt(r) };
      drawText(ctx, d, xf, b, { r, c, merged: !!m, filled, colPt, c1, c2, X, mdw: 7 });
    }
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const img = await out.embedPng(new Uint8Array(await blob.arrayBuffer()));
    const page = out.addPage([pw, ph]);
    page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
  }
  return out.save({ useObjectStreams: true });
}
const sumCols = (f, a, b) => { let s = 0; for (let i = a; i <= b; i++) s += f(i); return s; };
const sumRows = sumCols;

function fontCss(f, k = 1) { return cssFont(`${f.name}${f.b ? '-Bold' : ''}${f.i ? '-Italic' : ''}`, f.size * k).css; }

// перенос по словам для текста с форматированием по частям: строки — списки кусков со своим шрифтом
function wrapRuns(ctx, runs, width, k = 1) {
  const toks = [];
  for (const r of runs) for (const part of String(r.text).split(/(\r?\n|\s+)/)) if (part) toks.push({ text: part, font: r.font, br: /\n/.test(part) });
  const lines = [[]]; let w = 0;
  for (const t of toks) {
    if (t.br) { lines.push([]); w = 0; continue; }
    ctx.font = fontCss(t.font, k);
    const tw = ctx.measureText(t.text).width;
    const cur = lines[lines.length - 1];
    if (cur.length && /\S/.test(t.text) && w + tw > width) { lines.push([]); w = 0; }
    const ln = lines[lines.length - 1];
    if (!ln.length && !/\S/.test(t.text)) continue;
    const last = ln[ln.length - 1];
    if (last && last.font === t.font) last.text += t.text; else ln.push({ text: t.text, font: t.font });
    w += tw;
  }
  return lines.map((ln) => { const l = ln[ln.length - 1]; if (l) l.text = l.text.trimEnd(); return ln; });
}

function wrapLines(ctx, text, width, font) {
  const out = [];
  for (const para of String(text).split(/\r?\n/)) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      ctx.font = font;
      if (line && ctx.measureText(test.trimEnd()).width > width) { out.push(line.trimEnd()); line = w.trimStart(); }
      else line = test;
      // слово длиннее ячейки — режем по буквам
      while (ctx.measureText(line).width > width && line.length > 1) {
        let k = line.length - 1;
        while (k > 1 && ctx.measureText(line.slice(0, k)).width > width) k--;
        out.push(line.slice(0, k)); line = line.slice(k);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

function drawText(ctx, d, xf, b, o) {
  const f = xf.font;
  const runs = d.runs ? d.runs.map((r) => ({ text: r.text, font: { ...f, ...(r.font || {}) } })) : [{ text: d.text, font: f }];
  const pad = 2 * 0.75; // ~2 пикселя от края, как в Excel
  let h = xf.h;
  if (h === 'general') h = d.isNum ? 'right' : d.bool ? 'center' : 'left';
  if (h === 'fill' || h === 'distributed') h = 'left';
  if (h === 'centerContinuous') h = 'center';
  const ind = xf.indent * 3 * o.mdw * 0.75;
  const maxSize = Math.max(...runs.map((r) => r.font.size));
  const lineH = maxSize * 1.22;
  ctx.save();
  const rot = xf.rot === 255 ? 90 : xf.rot;
  if (rot) {
    // поворот: 1..90 — против часовой, 91..180 — по часовой
    const ang = rot <= 90 ? -rot : rot - 90;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip();
    ctx.translate(cx, cy); ctx.rotate((ang * Math.PI) / 180);
    const len = Math.abs(ang) === 90 ? b.h : b.w;
    const thick = Math.abs(ang) === 90 ? b.w : b.h;
    // у текста с форматированием по частям берём шрифт основной части
    const rf = runs.reduce((a, r2) => (r2.text.length > a.text.length ? r2 : a), runs[0]).font;
    const rLineH = rf.size * 1.22;
    const lines = xf.wrap ? wrapLines(ctx, d.text, len - pad * 2, fontCss(rf)) : [d.text];
    ctx.font = fontCss(rf); ctx.fillStyle = '#' + (rf.color || '000000'); ctx.textBaseline = 'alphabetic';
    const lineH = rLineH;
    const tot = lines.length * lineH;
    // по «вертикали» повернутого текста — горизонталь ячейки
    let y0 = xf.v === 'top' ? -thick / 2 + lineH * 0.8 : xf.v === 'center' ? -tot / 2 + lineH * 0.8 : thick / 2 - tot + lineH * 0.8;
    if (Math.abs(ang) === 90) y0 = (xf.h === 'left' ? -thick / 2 + lineH * 0.8 : xf.h === 'right' ? thick / 2 - tot + lineH * 0.8 : -tot / 2 + lineH * 0.8);
    for (const ln of lines) {
      const w = ctx.measureText(ln).width;
      let x;
      const vh = Math.abs(ang) === 90 ? (xf.v === 'top' ? (ang < 0 ? 'right' : 'left') : xf.v === 'center' ? 'center' : (ang < 0 ? 'left' : 'right')) : h;
      if (vh === 'center') x = -w / 2; else if (vh === 'right') x = len / 2 - pad - w; else x = -len / 2 + pad;
      ctx.fillText(ln, x, y0); y0 += lineH;
    }
    ctx.restore();
    return;
  }
  // обрезка: своя ячейка, или с переливом в пустые соседние справа/слева (без переноса)
  let clipX = b.x, clipW = b.w;
  ctx.font = fontCss(f);
  const natural = runs.reduce((s, r) => { ctx.font = fontCss(r.font); return s + ctx.measureText(r.text).width; }, 0);
  if (!xf.wrap && !o.merged && !d.isNum && natural + pad * 2 > b.w) {
    let right = b.x + b.w, left = b.x;
    if (h === 'left' || h === 'center') { let c = o.c + 1; while (c <= o.c2 && !o.filled(o.r, c) && right - b.x < natural + pad * 2 + ind) { right += o.colPt(c); c++; } }
    if (h === 'right' || h === 'center') { let c = o.c - 1; while (c >= o.c1 && !o.filled(o.r, c) && b.x + b.w - left < natural + pad * 2) { left -= o.colPt(c); c--; } }
    clipX = left; clipW = right - left;
  }
  ctx.beginPath(); ctx.rect(clipX, b.y, clipW, b.h); ctx.clip();
  let k = 1;
  if (xf.shrink && natural + pad * 2 > b.w) k = (b.w - pad * 2) / natural;
  // числа, не влезающие в ячейку, Excel показывает решётками
  if (d.isNum && !xf.wrap && natural * k + pad * 2 > b.w + 0.5) { runs.splice(0, runs.length, { text: '#'.repeat(Math.max(1, Math.floor((b.w - pad * 2) / (f.size * 0.55)))), font: f }); }
  const lines = xf.wrap ? (d.runs ? wrapRuns(ctx, runs, b.w - pad * 2 - ind) : wrapLines(ctx, d.text, b.w - pad * 2 - ind, fontCss(f)).map((t) => [{ text: t, font: f }])) : [runs];
  const tot = lines.length * lineH * k;
  const asc = maxSize * k * 0.952; const desc = maxSize * k * 0.27;
  let y;
  if (xf.v === 'top') y = b.y + 1 + asc;
  else if (xf.v === 'center' || xf.v === 'justify' || xf.v === 'distributed') y = b.y + (b.h - tot) / 2 + asc + (lineH * k - (asc + desc)) / 2;
  else y = b.y + b.h - tot + asc + (lineH * k - (asc + desc)) / 2 - 0.5;
  for (const ln of lines) {
    const w = ln.reduce((s, r) => { ctx.font = fontCss(r.font, k); return s + ctx.measureText(r.text).width; }, 0);
    let x;
    if (h === 'center') x = b.x + (b.w - w) / 2;
    else if (h === 'right') x = b.x + b.w - pad - w - ind;
    else x = b.x + pad + ind;
    for (const r of ln) {
      ctx.font = fontCss(r.font, k);
      ctx.fillStyle = '#' + (r.font.color || '000000');
      ctx.fillText(r.text, x, y);
      const rw = ctx.measureText(r.text).width;
      if (r.font.u || r.font.s) {
        ctx.fillRect(x, r.font.u ? y + r.font.size * k * 0.12 : y - r.font.size * k * 0.28, rw, Math.max(0.4, r.font.size * k * 0.06));
      }
      x += rw;
    }
    y += lineH * k;
  }
  ctx.restore();
}
