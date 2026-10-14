// Точка входа: загрузка состояния, панель вкладок, переключение экранов.
import { h, icon, fmtDate } from './util.js';
import { initTelegram, haptic } from './tg.js';
import { loadState, S, update, onChange, sessionLabel } from './store.js';
import { pushBack, popBack, toast } from './ui.js';
import { renderMemos } from './views/memos.js';
import { renderDocsTab } from './views/docs.js';
import { renderSchedule } from './views/schedule.js';
import { renderPlan } from './views/plan.js';
import { renderContracts } from './views/contracts.js';
import { renderShelves } from './views/shelves.js';
import { renderPeople } from './views/people.js';
import { renderMaterials, checkDriveDocs } from './views/materials.js';
import { renderSettings, createTab } from './views/settings.js';
import { onboarding } from './views/session.js';
import './drive.js';

const VIEWS = { memos: renderMemos, docs: renderDocsTab, schedule: renderSchedule, plan: renderPlan, contracts: renderContracts, shelves: renderShelves, people: renderPeople, materials: renderMaterials };

let showSettings = false;
let reorder = false;
const scrollByTab = {};
let lastView = null;

const appbar = document.getElementById('appbar');
const main = document.getElementById('view');
const tabbar = document.getElementById('tabbar');

function closeSettings() {
  showSettings = false;
  popBack(closeSettings);
  render();
}

function openSettings() {
  if (showSettings) return;
  showSettings = true;
  pushBack(closeSettings);
  render();
}

function renderAppbar() {
  const s = S.session;
  appbar.innerHTML = '';
  appbar.append(
    h('button', { class: 'session-chip', onClick: () => { update((st) => { st.activeTab = 'memos'; }); showSettings && closeSettings(); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
      h('span', { class: 'dot' + (s.until && s.until < new Date().toISOString().slice(0, 10) ? ' warn' : '') }),
      h('span', { class: 'session-text' }, h('strong', null, sessionLabel(s)), s.until ? h('small', null, 'до ' + fmtDate(s.until)) : null),
    ),
    h('button', { class: 'icon-btn glass-btn', 'aria-label': 'Настройки приложения', onClick: openSettings }, icon('gear')),
  );
}

function renderTabbar() {
  tabbar.innerHTML = '';
  const tabs = S.tabs.filter((t) => !t.hidden);
  const scroller = h('div', { class: 'tab-scroller', role: 'tablist' });
  tabs.forEach((t) => {
    const active = !showSettings && t.id === S.activeTab;
    const btn = h('button', {
      class: 'tab-chip' + (active ? ' active' : '') + (reorder ? ' wiggle' : ''),
      role: 'tab', 'aria-selected': active ? 'true' : 'false',
      onClick: () => {
        if (reorder) return;
        haptic('light');
        if (showSettings) { showSettings = false; popBack(closeSettings); }
        update((st) => { st.activeTab = t.id; });
      },
    },
    reorder ? h('span', { class: 'mv', role: 'button', 'aria-label': 'Левее', onClick: (e) => { e.stopPropagation(); move(t, -1); } }, icon('left')) : null,
    h('span', null, t.title),
    reorder ? h('span', { class: 'mv', role: 'button', 'aria-label': 'Правее', onClick: (e) => { e.stopPropagation(); move(t, 1); } }, icon('right')) : null);

    // долгое нажатие — режим перестановки вкладок
    let timer;
    const start = () => { timer = setTimeout(() => { reorder = true; haptic('medium'); renderTabbar(); toast('Переставьте вкладки стрелками и нажмите «Готово»'); }, 550); };
    const cancel = () => clearTimeout(timer);
    btn.addEventListener('pointerdown', start);
    ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'].forEach((ev) => btn.addEventListener(ev, ev === 'pointermove' ? (e) => { if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) cancel(); } : cancel));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    scroller.appendChild(btn);
  });
  if (reorder) {
    scroller.appendChild(h('button', { class: 'tab-chip done', onClick: () => { reorder = false; renderTabbar(); } }, 'Готово'));
  } else {
    scroller.appendChild(h('button', { class: 'tab-chip add', 'aria-label': 'Новая вкладка', onClick: createTab }, icon('plus')));
  }
  tabbar.appendChild(scroller);
  const act = scroller.querySelector('.active');
  if (act) act.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function move(t, dir) {
  update((st) => {
    const visible = st.tabs.filter((x) => !x.hidden);
    const i = visible.indexOf(t), j = i + dir;
    if (j < 0 || j >= visible.length) return;
    const a = st.tabs.indexOf(visible[i]), b = st.tabs.indexOf(visible[j]);
    [st.tabs[a], st.tabs[b]] = [st.tabs[b], st.tabs[a]];
  });
}

function render() {
  document.documentElement.classList.toggle('low-glass', !!S.settings.lowGlass);
  const viewKey = showSettings ? '__settings' : S.activeTab;
  if (lastView && lastView !== viewKey) scrollByTab[lastView] = window.scrollY;
  const keep = lastView === viewKey ? window.scrollY : (scrollByTab[viewKey] || 0);

  renderAppbar();
  renderTabbar();
  main.innerHTML = '';
  const root = h('div', { class: 'view-inner' });
  main.appendChild(root);
  if (showSettings) {
    renderSettings(root, closeSettings);
  } else {
    let tab = S.tabs.find((t) => t.id === S.activeTab && !t.hidden) || S.tabs.find((t) => !t.hidden);
    if (!tab) { tab = S.tabs[0]; tab.hidden = false; }
    if (S.activeTab !== tab.id) S.activeTab = tab.id;
    const fn = VIEWS[tab.kind] || renderDocsTab;
    try { fn(tab, root); } catch (e) { console.error(e); root.append(h('div', { class: 'card glass' }, h('p', { class: 'note warn' }, 'Ошибка отображения: ' + e.message))); }
  }
  lastView = viewKey;
  window.scrollTo(0, keep);
}

async function boot() {
  initTelegram();
  try {
    await loadState();
  } catch (e) {
    main.innerHTML = '';
    main.append(h('div', { class: 'card glass' }, h('p', { class: 'note warn' }, 'Не удалось открыть хранилище браузера: ' + e.message)));
    return;
  }
  onChange(render);
  render();
  document.body.classList.add('ready');
  if (!S.session.city && !S.session.osp && !S.sessions.length) setTimeout(onboarding, 400);
  // файлы «Памяток», которые живут на Google Диске (памятка сотрудникам) — проверяем обновления
  const last = Number(localStorage.getItem('driveDocsCheck') || 0);
  if (Date.now() - last > 6 * 3600 * 1000) setTimeout(() => { try { localStorage.setItem('driveDocsCheck', String(Date.now())); } catch (e) { /* без хранилища */ } checkDriveDocs(); }, 3000);
}

boot();
