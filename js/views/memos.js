// Памятки / Бланки: вводные сеанса сверху и список памяток ниже.
import { h } from '../util.js';
import { S } from '../store.js';
import { renderDocsTab } from './docs.js';
import { renderSessionCard } from './session.js';
import { importStarter } from './settings.js';

export function renderMemos(tab, root) {
  const top = h('div', { class: 'view-inner' },
    !S.settings.starterLoaded ? h('div', { class: 'banner' },
      h('strong', null, 'Загрузите стартовый пакет'),
      h('span', null, 'В нём ваши контакты, реквизиты, деления, опорный план, зоны и шаблоны. Обычно он подтягивается сам при входе через бота; если нет — загрузите файл.'),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn primary sm', onClick: importStarter }, 'Выбрать файл'))) : null,
    renderSessionCard(),
  );
  renderDocsTab(tab, root, { top });
}
