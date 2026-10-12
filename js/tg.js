// Интеграция с Telegram Mini App. Вне Telegram всё работает как обычный сайт.
const w = window.Telegram && window.Telegram.WebApp;
export const tg = w && w.initData ? w : null;
export const inTelegram = !!tg;

export function initTelegram() {
  if (!tg) {
    document.documentElement.classList.add('browser');
    return;
  }
  document.documentElement.classList.add('telegram');
  tg.ready();
  tg.expand();
  try { if (tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes(); } catch (e) { /* старые клиенты */ }
  const applyScheme = () => document.documentElement.dataset.scheme = tg.colorScheme || 'light';
  applyScheme();
  tg.onEvent('themeChanged', applyScheme);
}

export function haptic(kind = 'light') {
  try {
    if (!tg) return;
    if (kind === 'success' || kind === 'error' || kind === 'warning') tg.HapticFeedback.notificationOccurred(kind);
    else tg.HapticFeedback.impactOccurred(kind);
  } catch (e) { /* нет поддержки */ }
}

export function openExternal(url) {
  if (tg) tg.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

export function tgUser() {
  return tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user : null;
}

export function tgInitData() {
  return tg ? tg.initData : '';
}
