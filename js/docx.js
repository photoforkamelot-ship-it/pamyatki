// Заполнение Word-шаблонов: метки вида {{ОСП}} или {{OSP}} заменяются значениями из вводных.
const loadZip = () => (window.JSZip ? Promise.resolve(window.JSZip) : new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = new URL('../vendor/jszip.min.js', import.meta.url).href;
  s.onload = () => res(window.JSZip);
  s.onerror = () => rej(new Error('Не загрузилась библиотека для Word'));
  document.head.appendChild(s);
}));

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Метка, разбитая Word на несколько кусков, склеивается: убираем разметку между {{ и }}
function healTags(xml) {
  return xml.replace(/\{(?:<[^>]+>)*\{((?:[^{}<]|<[^>]+>)*?)\}(?:<[^>]+>)*\}/g, (m, inner) => '{{' + inner.replace(/<[^>]+>/g, '') + '}}');
}

// Подгонка размера: строка с меткой не должна переезжать на следующую страницу.
// fit: [{ tags: ['ADDRESS'], k: 1150, min: 18 }] — k ≈ «размер шрифта (pt) × число знаков», что влезает в строку.
function fitParagraphs(xml, values, fit) {
  for (const rule of fit || []) {
    let from = 0;
    const re = new RegExp(`\\{\\{\\s*(${rule.tags.join('|')})\\s*\\}\\}`, 'g');
    let m;
    const done = new Set();
    while ((m = re.exec(xml))) {
      const at = m.index;
      const a = Math.max(xml.lastIndexOf('<w:p ', at), xml.lastIndexOf('<w:p>', at));
      const b = xml.indexOf('</w:p>', at);
      if (a < 0 || b < 0 || done.has(a)) continue;
      done.add(a);
      const para = xml.slice(a, b);
      // строки внутри абзаца (разрыв строки Shift+Enter) подгоняются по отдельности
      const parts = para.split(/(<w:br\/>|<w:cr\/>)/);
      const tagRe = new RegExp(`\\{\\{\\s*(${rule.tags.join('|')})\\s*\\}\\}`);
      const fixedParts = parts.map((seg) => {
        if (!tagRe.test(seg)) return seg;
        const text = seg.replace(/<w:tab\/>/g, ' ').replace(/<[^>]+>/g, '').replace(/\{\{\s*([A-Za-zА-Яа-яЁё0-9_]+)\s*\}\}/g, (x, k) => values[k.toUpperCase()] ?? '').trim();
        const sizes = [...seg.matchAll(/<w:sz w:val="(\d+)"/g)].map((x) => Number(x[1]) / 2);
        if (!sizes.length || !text) return seg;
        const want = Math.min(rule.max || 999, Math.max(rule.min || 12, Math.floor(rule.k / text.length)));
        if (want >= Math.max(...sizes)) return seg;
        return seg.replace(/<w:(sz|szCs) w:val="(\d+)"\/>/g, (x, t, v) => `<w:${t} w:val="${Math.min(Number(v), want * 2)}"/>`);
      });
      const fixed = fixedParts.join('');
      xml = xml.slice(0, a) + fixed + xml.slice(b);
      re.lastIndex = a + fixed.length;
      void from;
    }
  }
  return xml;
}

export async function fillDocx(bytes, values, { fit } = {}) {
  const JSZip = await loadZip();
  const zip = await JSZip.loadAsync(bytes);
  const missing = new Set();
  const used = new Set();
  const parts = Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n));
  for (const name of parts) {
    let xml = fitParagraphs(healTags(await zip.file(name).async('string')), values, fit);
    xml = xml.replace(/\{\{\s*([A-Za-zА-Яа-яЁё0-9_]+)\s*\}\}/g, (m, key) => {
      const k = key.toUpperCase();
      if (k in values) { used.add(k); return esc(values[k]); }
      missing.add(key);
      return m;
    });
    zip.file(name, xml);
  }
  const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return { bytes: out, used: [...used], missing: [...missing] };
}

export async function docxTags(bytes) {
  const JSZip = await loadZip();
  const zip = await JSZip.loadAsync(bytes);
  const xml = healTags(await zip.file('word/document.xml').async('string'));
  return [...new Set([...xml.matchAll(/\{\{\s*([A-Za-zА-Яа-яЁё0-9_]+)\s*\}\}/g)].map((m) => m[1]))];
}

export const isDocx = (meta) => !!meta && (meta.kind === 'docx' || /\.docx$/i.test(meta.name || ''));
