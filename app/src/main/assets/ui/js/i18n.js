'use strict';

/**
 * Локализация RU/EN. Ключи плоские, значения — только строки.
 * Язык берётся из настроек; переключение мгновенное, без перезагрузки.
 */
const I18n = (() => {
  const dict = {
    ru: {
      'tab.chats': 'Чаты',
      'tab.search': 'Поиск',
      'tab.settings': 'Настройки',
      'common.ok': 'Готово',
      'common.cancel': 'Отмена',
      'common.save': 'Сохранить',
      'common.delete': 'Удалить',
      'common.close': 'Закрыть',
      'common.retry': 'Повторить',
      'common.more': 'Ещё',
      'common.back': 'Назад',
      'chats.new': 'Новый чат',
      'chats.empty.title': 'Пока нет чатов',
      'chats.empty.action': 'Создать чат',
      'chats.noMessages': 'Нет сообщений',
      'chats.draft': 'Черновик',
      'chats.agentWorking': 'Агент работает…',
      'chats.group.today': 'Сегодня',
      'chats.group.yesterday': 'Вчера',
      'chats.group.week': 'На этой неделе',
      'chats.group.month': 'В этом месяце',
      'chats.group.earlier': 'Раньше',
      'chat.placeholder': 'Сообщение',
      'chat.send': 'Отправить',
      'chat.stop': 'Стоп',
      'chat.typing': 'Агент печатает',
      'chat.scrollDown': 'Вниз',
      'search.title': 'Поиск',
      'search.placeholder': 'По чатам и сообщениям',
      'search.empty': 'Начните вводить запрос',
      'search.nothing': 'Ничего не найдено',
      'search.matches.one': 'совпадение',
      'search.matches.few': 'совпадения',
      'search.matches.many': 'совпадений',
      'settings.title': 'Настройки',
      'settings.profile': 'Профиль по умолчанию',
      'settings.profiles': 'Профили',
      'settings.providers': 'Провайдеры',
      'settings.models': 'Модели',
      'settings.agent': 'Агент',
      'settings.notifications': 'Уведомления',
      'settings.appearance': 'Внешний вид',
      'settings.backup': 'Бэкап',
      'settings.about': 'О приложении',
      'settings.telemetry': 'без телеметрии',
      'agent.grant': 'Разрешить раз',
      'agent.always': 'Всегда',
      'agent.deny': 'Отклонить',
      'agent.permission': 'Нужно разрешение',
      'agent.plan': 'План',
      'chat.settings': 'Настройки чата',
      'agent.graph': 'Граф задач',
      'agent.pause': 'Пауза',
      'agent.resume': 'Продолжить',
      'offline.banner': 'Нет сети. История доступна, новые ответы — после подключения.',
      'offline.queued': 'Нет сети: сообщение в очереди',
    },
    en: {
      'tab.chats': 'Chats',
      'tab.search': 'Search',
      'tab.settings': 'Settings',
      'common.ok': 'Done',
      'common.cancel': 'Cancel',
      'common.save': 'Save',
      'common.delete': 'Delete',
      'common.close': 'Close',
      'common.retry': 'Retry',
      'common.more': 'More',
      'common.back': 'Back',
      'chats.new': 'New chat',
      'chats.empty.title': 'No chats yet',
      'chats.empty.action': 'Create chat',
      'chats.noMessages': 'No messages',
      'chats.draft': 'Draft',
      'chats.agentWorking': 'Agent is working…',
      'chats.group.today': 'Today',
      'chats.group.yesterday': 'Yesterday',
      'chats.group.week': 'This week',
      'chats.group.month': 'This month',
      'chats.group.earlier': 'Earlier',
      'chat.placeholder': 'Message',
      'chat.send': 'Send',
      'chat.stop': 'Stop',
      'chat.typing': 'Agent is typing',
      'chat.scrollDown': 'Down',
      'search.title': 'Search',
      'search.placeholder': 'Chats and messages',
      'search.empty': 'Start typing',
      'search.nothing': 'Nothing found',
      'search.matches.one': 'match',
      'search.matches.few': 'matches',
      'search.matches.many': 'matches',
      'settings.title': 'Settings',
      'settings.profile': 'Default profile',
      'settings.profiles': 'Profiles',
      'settings.providers': 'Providers',
      'settings.models': 'Models',
      'settings.agent': 'Agent',
      'settings.notifications': 'Notifications',
      'settings.appearance': 'Appearance',
      'settings.backup': 'Backup',
      'settings.about': 'About',
      'settings.telemetry': 'no telemetry',
      'agent.grant': 'Allow once',
      'agent.always': 'Always',
      'agent.deny': 'Deny',
      'agent.permission': 'Permission required',
      'agent.plan': 'Plan',
      'chat.settings': 'Chat settings',
      'agent.graph': 'Task graph',
      'agent.pause': 'Pause',
      'agent.resume': 'Resume',
      'offline.banner': 'No network. History is available; new replies will arrive once connected.',
      'offline.queued': 'No network: message queued',
    },
  };

  const locale = () => (S && S.settings && S.settings.language === 'en' ? 'en' : 'ru');

  const t = (key, fallback) => {
    const lang = locale();
    const table = dict[lang] || dict.ru;
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    if (Object.prototype.hasOwnProperty.call(dict.ru, key)) return dict.ru[key];
    return fallback == null ? key : fallback;
  };

  const plural = (n, keyBase) => {
    const lang = locale();
    if (lang === 'en') return t(keyBase + (n === 1 ? '.one' : '.many'));
    const abs = Math.abs(n) % 100;
    const last = abs % 10;
    if (abs > 10 && abs < 20) return t(keyBase + '.many');
    if (last > 1 && last < 5) return t(keyBase + '.few');
    if (last === 1) return t(keyBase + '.one');
    return t(keyBase + '.many');
  };

  const apply = (root) => {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach((node) => {
      node.textContent = t(node.dataset.i18n);
    });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
      node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
    });
    scope.querySelectorAll('[data-i18n-title]').forEach((node) => {
      node.setAttribute('title', t(node.dataset.i18nTitle));
      node.setAttribute('aria-label', t(node.dataset.i18nTitle));
    });
  };

  return { t, plural, apply, locale };
})();

window.I18n = I18n;
window.t = I18n.t;