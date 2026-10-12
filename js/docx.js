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

export async function fillDocx(bytes, values) {
  const JSZip = await loadZip();
  const zip = await JSZip.loadAsync(bytes);
  const missing = new Set();
  const used = new Set();
  const parts = Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n));
  for (const name of parts) {
    let xml = healTags(await zip.file(name).async('string'));
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
