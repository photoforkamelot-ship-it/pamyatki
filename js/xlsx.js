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
// Стили: перенос по словам у выбранных стилей ячеек (+ выравнивание), новый стиль красного жирного текста
async function patchStyles(zip, { wrap = [], valign = {}, red = false } = {}) {
  let st = await zip.file('xl/styles.xml').async('string');
  const xfsBlock = st.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/);
  const xfs = [...xfsBlock[2].matchAll(/<xf [^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((m) => m[0]);
  const setAlign = (xf, attrs) => {
    if (/<alignment /.test(xf)) {
      let al = xf.match(/<alignment [^>]*\/>/)[0];
      for (const [k, v] of Object.entries(attrs)) al = new RegExp(` ${k}="`).test(al) ? al.replace(new RegExp(` ${k}="[^"]*"`), ` ${k}="${v}"`) : al.replace('<alignment ', `<alignment ${k}="${v}" `);
      return xf.replace(/<alignment [^>]*\/>/, al);
    }
    const al = `<alignment ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`;
    return (xf.endsWith('/>') ? xf.replace(/\/>$/, `>${al}</xf>`) : xf.replace('</xf>', `${al}</xf>`)).replace(/ applyAlignment="0"/, '').replace('<xf ', '<xf applyAlignment="1" ');
  };
  for (const id of wrap) if (xfs[id]) xfs[id] = setAlign(xfs[id], { wrapText: '1', ...(valign[id] ? { vertical: valign[id] } : {}) });
  let redId = null;
  if (red) {
    const fm = st.match(/<fonts count="(\d+)"([^>]*)>([\s\S]*?)<\/fonts>/);
    const nf = Number(fm[1]);
    st = st.replace(fm[0], `<fonts count="${nf + 1}"${fm[2]}>${fm[3]}<font><b/><sz val="16"/><color rgb="FFE30613"/><name val="Calibri"/><family val="2"/><charset val="204"/></font></fonts>`);
    xfs.push(`<xf numFmtId="0" fontId="${nf}" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf>`);
    redId = String(xfs.length - 1);
  }
  st = st.replace(/<cellXfs count="\d+">[\s\S]*?<\/cellXfs>/, `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`);
  zip.file('xl/styles.xml', st);
  return { redId };
}

// Область печати и поля: «на весь лист, узкие поля»; ориентация — та, при которой таблица крупнее
async function fitPage(zip, sheet, { area, widthPt, heightPt }) {
  const pw = 842 - 2 * 14, ph = 595 - 2 * 14;
  const land = Math.min(pw / widthPt, ph / heightPt) >= Math.min(ph / widthPt, pw / heightPt);
  sheet = sheet.replace(/<pageMargins [^>]*\/>/, '<pageMargins left="0.2" right="0.2" top="0.2" bottom="0.2" header="0" footer="0"/>')
    .replace(/<pageSetup [^>]*\/>/, `<pageSetup paperSize="9" orientation="${land ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="1"/>`)
    .replace(/<sheetPr([^>]*)>(?![\s\S]*?<pageSetUpPr)/, '<sheetPr$1><pageSetUpPr fitToPage="1"/>');
  const wbp = 'xl/workbook.xml';
  let wb = await zip.file(wbp).async('string');
  const name = (wb.match(/<sheet [^>]*name="([^"]+)"/) || [])[1] || 'Лист1';
  wb = wb.replace(/<definedName [^>]*name="_xlnm\.Print_Area"[^>]*>[^<]*<\/definedName>/g, '');
  const dn = `<definedName name="_xlnm.Print_Area" localSheetId="0">'${name.replace(/'/g, "''")}'!${area}</definedName>`;
  wb = /<definedNames>/.test(wb) ? wb.replace('<definedNames>', `<definedNames>${dn}`) : wb.replace('</sheets>', `</sheets><definedNames>${dn}</definedNames>`);
  zip.file(wbp, wb);
  return sheet;
}

// строки текста в ячейке шириной w (единицы Excel) шрифтом size
const linesFor = (text, w, size = 16, bold = false) => Math.max(1, Math.ceil(String(text || '').length / Math.max(6, (w * 7) / (size * (bold ? 0.6 : 0.53)))));

export const TEAM_NOTE = 'ВАЖНО! НЕСМОТРЯ НА РАЗДЕЛЕНИЕ ЗОН ОТВЕТСТВЕННОСТИ — НЕ ЗАБЫВАЕМ, ЧТО МЫ ВСЕ УНИВЕРСАЛЫ И В ПЕРВУЮ ОЧЕРЕДЬ КОМАНДА: ПОМОГАЕМ ДРУГ ДРУГУ, ОБОДРЯЕМ ДРУГ ДРУГА, ВЫПОЛНЯЕМ СЛОЖНЫЕ ЗАДАЧИ ВМЕСТЕ, ЕСЛИ КОМУ-ТО В КАКОЙ-ТО МОМЕНТ НЕОБХОДИМА ПОМОЩЬ!';

export async function fillResponsibility(bytes, data) {
  const { zip, sheetPath, sheet } = await openBook(bytes);
  const R = rowsOf(sheet);
  const C = ['B', 'C', 'D'];
  const colW = Number((sheet.match(/<col min="2" max="\d+" width="([\d.]+)"/) || [])[1] || 48.8);
  const zoneStyles = ['10', '11', '12', '14', '21', '22', '23', '24', '25', '26', '27', '28', '29'];
  const { redId } = await patchStyles(zip, { wrap: zoneStyles.map(Number), red: true });
  const out = [];
  let heightPt = 0;
  const push = (xml, ht) => { out.push(xml); heightPt += ht; };
  const rowHt = (row, dflt = 21) => Number(((row || '').match(/ ht="([\d.]+)"/) || [])[1] || dflt);
  push(R.get(2) ? R.get(2).replace(/<c r="E2"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '') : '', rowHt(R.get(2), 29));
  // имена: строки 3 и 4 (без служебных колонок справа)
  for (const [r, k] of [[3, 0], [4, 1]]) {
    const row = R.get(r);
    push(`<row r="${r}" ${rowAttrs(row)}>${C.map((c, i) => str(`${c}${r}`, styleOf(row, `${c}${r}`, '0'), (data.names[i] || [])[k] || '')).join('')}</row>`, rowHt(row, 34));
  }
  // строка подстраивается под самый длинный текст (перенос по словам)
  const htFor = (texts) => { const n = Math.max(...texts.map((t) => linesFor(t, colW))); return n > 1 ? n * 21 : 0; };
  let r = 5;
  // общие строки (у всех трёх)
  const commonStyles = [['21', '27', '24'], ['22', '28', '25'], ['23', '29', '26']];
  data.common.forEach((t, i) => {
    const kind = data.common.length === 1 || i === data.common.length - 1 ? 2 : i === 0 ? 0 : 1;
    const tpl = R.get(5 + kind) || R.get(5);
    const ht = htFor([t]);
    let attrs = rowAttrs(tpl);
    if (ht) attrs = attrs.replace(/\s*ht="[\d.]+"/, '').replace(/\s*customHeight="\d"/, '') + ` ht="${ht}" customHeight="1"`;
    push(`<row r="${r}" ${attrs}>${C.map((c, k) => str(`${c}${r}`, commonStyles[kind][k], t)).join('')}</row>`, ht || rowHt(tpl));
    r++;
  });
  // индивидуальные зоны
  const n = Math.max(0, ...data.cols.map((c) => c.length));
  const ctrl = ['10', '12', '11'];
  const plain = ['14', '14', '14'];
  for (let i = 0; i < n; i++) {
    const ht = htFor(data.cols.map((col) => (col[i] ? col[i].t : '')));
    push(`<row r="${r}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${C.map((c, k) => { const z = data.cols[k][i]; return str(`${c}${r}`, z && z.control ? ctrl[k] : plain[k], z ? z.t : ''); }).join('')}</row>`, ht || 21);
    r++;
  }
  // нижняя граница и сноска
  const r23 = R.get(23), r24 = R.get(24), r25 = R.get(25);
  push(`<row r="${r}" ${rowAttrs(r23)}>${C.map((c, k) => str(`${c}${r}`, ['30', '30', '30'][k], '')).join('')}</row>`, rowHt(r23, 22));
  r++;
  const foot = r;
  const fb = cellOf(r24, 'B24');
  push(`<row r="${r}" ${rowAttrs(r24)}>${fb ? moveCell(fb, `B${r}`) : ''}${str(`C${r}`, styleOf(r24, 'C24', '33'), '')}${str(`D${r}`, styleOf(r24, 'D24', '34'), '')}</row>`, rowHt(r24));
  r++;
  push(`<row r="${r}" ${rowAttrs(r25)}>${['B', 'C', 'D'].map((c) => str(`${c}${r}`, styleOf(r25, `${c}25`, '35'), '')).join('')}</row>`, rowHt(r25, 22));
  r++;
  // красная надпись про команду — сразу под таблицей
  const note = data.note === undefined ? TEAM_NOTE : data.note;
  const merges = ['B2:D2', `B${foot}:D${foot + 1}`];
  if (note) {
    const ht = linesFor(note, colW * 3, 16, true) * 22 + 4;
    push(`<row r="${r}" ht="${ht}" customHeight="1">${C.map((c, k) => str(`${c}${r}`, redId, k ? '' : note)).join('')}</row>`, ht);
    merges.push(`B${r}:D${r}`);
    r++;
  }
  let xml = replaceSheetData(sheet, out.join(''), merges, `B2:D${r - 1}`);
  xml = await fitPage(zip, xml, { area: `$B$2:$D$${r - 1}`, widthPt: colW * 3 * 6, heightPt: heightPt * 15 / 16 });
  return closeBook(zip, sheetPath, xml);
}

/**
 * ЯЧЧП «Порядок!» — три блока времени (B–D, F–H, J–L): фамилия 1 смены, 2 смены, отдел.
 * data = { blocks: [{ label, rows: [{ s1, s2, zone, role }] }] × 3 }, role — номер функционала 0..2 (цвет).
 */
// Шрифт стиля ячейки → свойства «куска» текста (чтобы жирная приписка была тем же шрифтом)
async function runProps(zip) {
  const st = await zip.file('xl/styles.xml').async('string');
  const fonts = [...((st.match(/<fonts[^>]*>([\s\S]*?)<\/fonts>/) || [])[1] || '').matchAll(/<font>([\s\S]*?)<\/font>|<font\/>/g)].map((m) => m[1] || '');
  const xfs = [...((st.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/) || [])[1] || '').matchAll(/<xf [^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((m) => m[0]);
  return (s, bold) => {
    const xf = xfs[Number(s)] || '';
    let f = fonts[Number((xf.match(/fontId="(\d+)"/) || [])[1] || 0)] || '';
    f = f.replace(/<b\/>|<b val="[^"]*"\/>/g, '').replace(/<name /, '<rFont ');
    return `<rPr>${bold ? '<b/>' : ''}${f}</rPr>`;
  };
}

export async function fillYach(bytes, data) {
  const { zip, sheetPath, sheet } = await openBook(bytes);
  const rp = await runProps(zip);
  // вторая фамилия + жирная приписка «/УМ помогает» (зона, где помогает управляющий)
  const helped = (ref, s, name) => `<c r="${ref}" s="${s}" t="inlineStr"><is>${name ? `<r>${rp(s, false)}<t xml:space="preserve">${esc(name)}</t></r>` : ''}<r>${rp(s, true)}<t xml:space="preserve">${name ? '/' : ''}УМ помогает</t></r></is></c>`;
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
  // ровно столько строк, сколько зон: пустые строки не растягивают таблицу
  const n = Math.max(1, ...data.blocks.map((b) => b.rows.length));
  await patchStyles(zip, { wrap: [14, 16, 17, 18], valign: { 14: 'top', 16: 'center', 17: 'center', 18: 'center' } });
  let heightPt = 17.75 + 17.25 + 8.5;
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
      cells += str(`${c1}${r}`, z ? ns : '9', z ? z.s1 : '') + (z && z.dir ? helped(`${c2}${r}`, ns, z.s2) : str(`${c2}${r}`, z ? ns : '9', z ? z.s2 : '')) + str(`${c3}${r}`, z ? '14' : '9', z ? z.zone : '');
      if (bi === 0) cells += str(`E${r}`, first ? '34' : last ? '36' : '29', '');
      if (bi === 1) cells += str(`I${r}`, last ? '43' : '41', '');
    });
    // длинные названия переносятся: высота строки растёт под число строк текста
    const lines = Math.max(1, ...data.blocks.map((b) => { const z = b.rows[i]; if (!z) return 1; return Math.max(Math.ceil(String(z.zone || '').length / 30), Math.ceil(String(z.s1 || '').length / 20), Math.ceil((String(z.s2 || '') + (z.dir ? '/УМ помогает' : '')).length / 20)); }));
    let attrs = rowAttrs(rowTpl);
    if (lines > 1) attrs = attrs.replace(/ht="([\d.]+)"/, (m0, v) => `ht="${(Number(v) * lines).toFixed(1)}"`);
    heightPt += Number((attrs.match(/ht="([\d.]+)"/) || [])[1] || 8.5);
    out.push(`<row r="${r}" ${attrs}>${cells}</row>`);
  }
  const last = 3 + n;
  let xml = replaceSheetData(sheet, out.join(''), ['A1:L1', `A3:A${last}`, 'B3:D3', `E3:E${last}`, 'F3:H3', `I3:I${last}`, 'J3:L3'], `A1:L${last}`);
  const widthPt = [...xml.matchAll(/<col min="(\d+)" max="(\d+)" width="([\d.]+)"/g)].reduce((a, m) => a + (m[2] - m[1] + 1) * Number(m[3]) * 6, 0);
  xml = await fitPage(zip, xml, { area: `$A$1:$L$${last}`, widthPt, heightPt: heightPt * 15 / 16 });
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
