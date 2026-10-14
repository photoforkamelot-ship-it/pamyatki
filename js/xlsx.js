// Заполнение Excel-шаблонов сервисного графика. Ширины колонок, стили, заливки и параметры
// печати берутся из исходного файла пользователя — меняются только строки с данными.
const loadZip = () => (window.JSZip ? Promise.resolve(window.JSZip) : new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = new URL('../vendor/jszip.min.js', import.meta.url).href;
  s.onload = () => res(window.JSZip);
  s.onerror = () => rej(new Error('Не загрузилась библиотека для Excel'));
  document.head.appendChild(s);
}));

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const str = (ref, s, text) => (text === '' || text == null ? `<c r="${ref}" s="${s}"/>` : `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`);

function rowsOf(sheet) {
  const map = new Map();
  for (const m of sheet.matchAll(/<row [^>]*?r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) map.set(Number(m[1]), m[0]);
  return map;
}
function cellOf(rowXml, ref) {
  const m = rowXml && rowXml.match(new RegExp(`<c r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`));
  return m ? m[0] : '';
}
const styleOf = (rowXml, ref, dflt) => { const c = cellOf(rowXml, ref); const m = c.match(/ s="(\d+)"/); return m ? m[1] : dflt; };
const moveCell = (cellXml, newRef) => cellXml.replace(/r="[A-Z]+\d+"/, `r="${newRef}"`);
function rowAttrs(rowXml) {
  const m = rowXml && rowXml.match(/<row ([^>]*?)\/?>/);
  return m ? m[1].replace(/\s*r="\d+"/, '').replace(/\s*spans="[^"]*"/, '') : '';
}

async function openBook(bytes) {
  const JSZip = await loadZip();
  const zip = await JSZip.loadAsync(bytes);
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const sheet = await zip.file(sheetPath).async('string');
  return { zip, sheetPath, sheet };
}

async function closeBook(zip, sheetPath, sheet) {
  zip.file(sheetPath, sheet);
  // формул больше нет — убираем цепочку вычислений, иначе Excel предложит «восстановить» файл
  if (zip.file('xl/calcChain.xml')) {
    zip.remove('xl/calcChain.xml');
    const ct = await zip.file('[Content_Types].xml').async('string');
    zip.file('[Content_Types].xml', ct.replace(/<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/, ''));
    const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    zip.file('xl/_rels/workbook.xml.rels', rels.replace(/<Relationship [^>]*Target="calcChain\.xml"[^>]*\/>/, ''));
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

function replaceSheetData(sheet, rowsXml, merges, lastRef) {
  sheet = sheet.replace(/<sheetData>[\s\S]*<\/sheetData>|<sheetData\/>/, `<sheetData>${rowsXml}</sheetData>`);
  sheet = sheet.replace(/<mergeCells[\s\S]*?<\/mergeCells>/, merges.length ? `<mergeCells count="${merges.length}">${merges.map((r) => `<mergeCell ref="${r}"/>`).join('')}</mergeCells>` : '');
  sheet = sheet.replace(/<dataValidations[\s\S]*?<\/dataValidations>/, '');
  sheet = sheet.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="${lastRef}"/>`);
  return sheet;
}

/**
 * «Распределение зон индивидуальной ответственности» — 3 колонки (B, C, D) по функционалам.
 * data = { names: [[смена1, смена2] × 3], common: [текст], cols: [[{t, control}] × 3], all: [текст] }
 */
export async function fillResponsibility(bytes, data) {
  const { zip, sheetPath, sheet } = await openBook(bytes);
  const R = rowsOf(sheet);
  const C = ['B', 'C', 'D'];
  const out = [];
  out.push(R.get(2) || '');
  // имена: строки 3 и 4
  for (const [r, k] of [[3, 0], [4, 1]]) {
    const row = R.get(r);
    out.push(`<row r="${r}" ${rowAttrs(row)}>${C.map((c, i) => str(`${c}${r}`, styleOf(row, `${c}${r}`, '0'), (data.names[i] || [])[k] || '')).join('')}${cellOf(row, `E${r}`) ? moveCell(cellOf(row, `E${r}`), `E${r}`) : ''}</row>`);
  }
  const all = data.all || [];
  let r = 5;
  const hStyle = styleOf(R.get(5), 'H5', '38');
  const hCell = (row) => (all[row - 5] !== undefined ? str(`H${row}`, hStyle, all[row - 5]) : '');
  // общие строки (у всех трёх)
  const commonStyles = [['21', '27', '24'], ['22', '28', '25'], ['23', '29', '26']];
  data.common.forEach((t, i) => {
    const kind = data.common.length === 1 || i === data.common.length - 1 ? 2 : i === 0 ? 0 : 1;
    const tpl = R.get(5 + kind) || R.get(5);
    out.push(`<row r="${r}" ${rowAttrs(tpl)}>${C.map((c, k) => str(`${c}${r}`, commonStyles[kind][k], t)).join('')}${hCell(r)}</row>`);
    r++;
  });
  // индивидуальные зоны
  const n = Math.max(0, ...data.cols.map((c) => c.length));
  const ctrl = ['10', '12', '11'];
  const plain = ['14', '14', '14'];
  for (let i = 0; i < n; i++) {
    out.push(`<row r="${r}">${C.map((c, k) => { const z = data.cols[k][i]; return str(`${c}${r}`, z && z.control ? ctrl[k] : plain[k], z ? z.t : ''); }).join('')}${hCell(r)}</row>`);
    r++;
  }
  // нижняя граница и сноска
  const r23 = R.get(23), r24 = R.get(24), r25 = R.get(25);
  out.push(`<row r="${r}" ${rowAttrs(r23)}>${C.map((c, k) => str(`${c}${r}`, ['30', '30', '30'][k], '')).join('')}${hCell(r)}</row>`);
  r++;
  const foot = r;
  const fb = cellOf(r24, 'B24');
  out.push(`<row r="${r}" ${rowAttrs(r24)}>${fb ? moveCell(fb, `B${r}`) : ''}${str(`C${r}`, styleOf(r24, 'C24', '33'), '')}${str(`D${r}`, styleOf(r24, 'D24', '34'), '')}${hCell(r)}</row>`);
  r++;
  out.push(`<row r="${r}" ${rowAttrs(r25)}>${['B', 'C', 'D'].map((c) => str(`${c}${r}`, styleOf(r25, `${c}25`, '35'), '')).join('')}${hCell(r)}</row>`);
  r++;
  while (r - 5 < all.length) { out.push(`<row r="${r}">${hCell(r)}</row>`); r++; }
  const xml = replaceSheetData(sheet, out.join(''), ['B2:D2', `B${foot}:D${foot + 1}`], `B2:H${r - 1}`);
  return closeBook(zip, sheetPath, xml);
}

/**
 * ЯЧЧП «Порядок!» — три блока времени (B–D, F–H, J–L): фамилия 1 смены, 2 смены, отдел.
 * data = { blocks: [{ label, rows: [{ s1, s2, zone, role }] }] × 3 }, role — номер функционала 0..2 (цвет).
 */
export async function fillYach(bytes, data) {
  const { zip, sheetPath, sheet } = await openBook(bytes);
  const R = rowsOf(sheet);
  const out = [R.get(1) || '', R.get(2) || ''];
  // строка 3: подписи блоков
  const r3 = R.get(3);
  const blockCols = [['B', 'C', 'D'], ['F', 'G', 'H'], ['J', 'K', 'L']];
  const sep = { A: 'A3', E: 'E3', I: 'I3' };
  let row3 = '';
  for (const col of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']) {
    const bi = blockCols.findIndex((b) => b[0] === col);
    if (bi >= 0 && data.blocks[bi]) row3 += str(`${col}3`, styleOf(r3, `${col}3`, '31'), data.blocks[bi].label);
    else { const c = cellOf(r3, `${col}3`); row3 += c || ''; }
  }
  void sep;
  out.push(`<row r="3" ${rowAttrs(r3)}>${row3}</row>`);
  const n = Math.max(46, ...data.blocks.map((b) => b.rows.length));
  const nameStyle = ['16', '17', '18'];
  const rowTpl = R.get(10) || R.get(4);
  for (let i = 0; i < n; i++) {
    const r = 4 + i;
    const first = i === 0, last = i === n - 1;
    let cells = str(`A${r}`, first ? '28' : last ? '30' : '29', '');
    data.blocks.forEach((b, bi) => {
      const z = b.rows[i];
      const [c1, c2, c3] = blockCols[bi];
      const ns = z && z.role >= 0 && z.role < 3 ? nameStyle[z.role] : '9';
      cells += str(`${c1}${r}`, z ? ns : '9', z ? z.s1 : '') + str(`${c2}${r}`, z ? ns : '9', z ? z.s2 : '') + str(`${c3}${r}`, z ? '14' : '9', z ? z.zone : '');
      if (bi === 0) cells += str(`E${r}`, first ? '34' : last ? '36' : '29', '');
      if (bi === 1) cells += str(`I${r}`, last ? '43' : '41', '');
    });
    out.push(`<row r="${r}" ${rowAttrs(rowTpl)}>${cells}</row>`);
  }
  const last = 3 + n;
  const xml = replaceSheetData(sheet, out.join(''), ['A1:L1', `A3:A${last}`, 'B3:D3', `E3:E${last}`, 'F3:H3', `I3:I${last}`, 'J3:L3'], `A1:L${last}`);
  return closeBook(zip, sheetPath, xml);
}

export const isXlsx = (meta) => !!meta && (meta.kind === 'xlsx' || /\.xlsx$/i.test(meta.name || ''));

// Простое заполнение ячеек готового бланка (табель): стиль ячейки сохраняется, формулы не трогаем.
const colNum = (c) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
export async function setCells(bytes, values) {
  const { zip, sheetPath } = await openBook(bytes);
  let sheet = await zip.file(sheetPath).async('string');
  for (const [ref, text] of Object.entries(values)) {
    const [, col, rowS] = ref.match(/^([A-Z]+)(\d+)$/);
    const rowRe = new RegExp(`<row [^>]*?r="${rowS}"[^>]*?(?:/>|>[\\s\\S]*?</row>)`);
    const rm = sheet.match(rowRe);
    if (!rm) continue; // строки нет в бланке — пропускаем
    let row = rm[0];
    if (row.endsWith('/>')) row = row.replace(/\/>$/, '></row>');
    const cell = cellOf(row, ref);
    const s = (cell.match(/ s="(\d+)"/) || [])[1] || '0';
    const nc = str(ref, s, text);
    if (cell) row = row.replace(cell, nc);
    else {
      // вставляем по порядку колонок
      const cells = [...row.matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)];
      const after = cells.filter((m) => colNum(m[1]) < colNum(col)).pop();
      row = after ? row.replace(after[0], after[0] + nc) : row.replace(/(<row [^>]*>)/, `$1${nc}`);
    }
    sheet = sheet.replace(rm[0], row);
  }
  return closeBook(zip, sheetPath, sheet);
}

// Заполнение нескольких листов по именам; формулы остаются, Excel пересчитает их при открытии.
export async function setSheetsCells(bytes, bySheet) {
  const JSZip = await loadZip();
  const zip = await JSZip.loadAsync(bytes);
  const wb = await zip.file('xl/workbook.xml').async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const unxml = (t) => t.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const [name, values] of Object.entries(bySheet)) {
    const sm = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g)].find((m) => unxml(m[1]) === name);
    if (!sm) throw new Error('В файле нет листа «' + name + '»');
    const rm = rels.match(new RegExp(`<Relationship [^>]*Id="${sm[2]}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`<Relationship [^>]*Target="([^"]+)"[^>]*Id="${sm[2]}"`));
    const path = 'xl/' + rm[1].replace(/^\/?xl\//, '').replace(/^\.\//, '');
    let sheet = await zip.file(path).async('string');
    for (const [ref, val] of Object.entries(values)) sheet = putCell(sheet, ref, val);
    zip.file(path, sheet);
  }
  // пересчёт при открытии и без устаревшей цепочки вычислений
  zip.file('xl/workbook.xml', /<calcPr/.test(wb) ? wb.replace(/<calcPr([^>]*?)\s*\/>/, (m, a) => `<calcPr${a.replace(/\s*fullCalcOnLoad="\d"/, '')} fullCalcOnLoad="1"/>`) : wb.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>'));
  if (zip.file('xl/calcChain.xml')) {
    zip.remove('xl/calcChain.xml');
    const ct = await zip.file('[Content_Types].xml').async('string');
    zip.file('[Content_Types].xml', ct.replace(/<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/, ''));
    zip.file('xl/_rels/workbook.xml.rels', rels.replace(/<Relationship [^>]*Target="calcChain\.xml"[^>]*\/>/, ''));
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

function putCell(sheet, ref, val) {
  const [, col, rowS] = ref.match(/^([A-Z]+)(\d+)$/);
  const num = typeof val === 'number' || /^\d+$/.test(String(val ?? '').trim());
  const mk = (s) => (val === '' || val == null ? `<c r="${ref}" s="${s}"/>` : num ? `<c r="${ref}" s="${s}"><v>${Number(val)}</v></c>` : str(ref, s, val));
  const rowRe = new RegExp(`<row [^>]*?r="${rowS}"[^>]*?(?:/>|>[\\s\\S]*?</row>)`);
  const rm = sheet.match(rowRe);
  if (!rm) return sheet;
  let row = rm[0];
  if (row.endsWith('/>')) row = row.replace(/\/>$/, '></row>');
  const cell = cellOf(row, ref);
  const s = (cell.match(/ s="(\d+)"/) || [])[1] || '0';
  if (cell) row = row.replace(cell, mk(s));
  else {
    const cells = [...row.matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)];
    const after = cells.filter((m) => colNum(m[1]) < colNum(col)).pop();
    row = after ? row.replace(after[0], after[0] + mk(s)) : row.replace(/(<row [^>]*>)/, `$1${mk(s)}`);
  }
  return sheet.replace(rm[0], row);
}
