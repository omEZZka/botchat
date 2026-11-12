'use strict';

/**
 * Экран настроек и экран агента. Читает S, вызывает Pickers/ProvidersUI.
 */
const Settings2 = (() => {
  const render = (view) => {
    U.clear(view);
    const section = U.el('section', { class: 'screen settings-screen' });
    section.appendChild(U.el('header', { class: 'topbar' }, [
      U.el('h1', { class: 'screen-title', text: 'Настройки' }),
    ]));

    const profile = U.el('div', { class: 'profile-card' }, [
      Render.avatar('botCHAT', 2, 2),
      U.el('div', { class: 'profile-main' }, [
        U.el('span', { class: 'profile-name', text: 'Профиль по умолчанию' }),
        U.el('span', { class: 'profile-sub', text: modelLine() }),
      ]),
    ]);
    section.appendChild(profile);

    const rows = [
      { icon: 'shield', label: 'Профили', sub: (S.env && S.env.profile) || 'изоляция рабочих папок', action: () => Pickers.profilesSheet() },
      { icon: 'key', label: 'Провайдеры', sub: connectedCount(), action: () => ProvidersUI.openProvidersScreen() },
      { icon: 'model', label: 'Модели', sub: modelLine(), action: () => ProvidersUI.openModelSheet() },
      { icon: 'sparkle', label: 'Агент', sub: 'Лимит ' + S.settings.stepLimit + ' шагов · режим ' + modeLabel(), action: () => Pickers.appSettings() },
      { icon: 'bell', label: 'Уведомления', sub: S.settings.notifications ? 'включены' : 'выключены', action: () => Pickers.appSettings() },
      { icon: 'palette', label: 'Внешний вид', sub: themeLabel() + ' · ' + accentLabel(), action: () => Pickers.appSettings() },
      { icon: 'backup', label: 'Бэкап', sub: 'экспорт и восстановление', action: () => Pickers.exportSheet() },
      { icon: 'info', label: 'О приложении', sub: (S.env && S.env.versionName) || '', action: () => Pickers.aboutSheet() },
    ];

    const list = U.el('div', { class: 'settings-list' });
    rows.forEach((row) => {
      list.appendChild(U.el('button', {
        class: 'settings-row', type: 'button', onclick: row.action,
      }, [
        U.el('span', { class: 'settings-icon' }, Icons.make(row.icon, 18)),
        U.el('span', { class: 'settings-main' }, [
          U.el('span', { class: 'settings-label', text: row.label }),
          U.el('span', { class: 'settings-sub', text: row.sub }),
        ]),
        Icons.make('back', 16),
      ]));
    });
    section.appendChild(list);

    section.appendChild(U.el('div', { class: 'settings-foot' }, [
      U.el('span', { class: 'muted small', text: 'botCHAT ' + ((S.env && S.env.versionName) || '').trim() }),
      U.el('span', { class: 'muted small', text: 'без телеметрии' }),
    ]));
    view.appendChild(section);
  };

  const connectedCount = () => {
    const n = (S.providers || []).filter((p) => p.hasKey || !p.needsKey).length;
    return n + ' ' + U.plural(n, 'подключён', 'подключено', 'подключено');
  };

  const modelLine = () => {
    const model = S.settings.activeModel;
    if (!model) return 'модель не выбрана';
    return model;
  };

  const modeLabel = () => ({ chat: 'чат', agent: 'агент', plan: 'план' }[S.settings.agentMode] || 'агент');

  const themeLabel = () => (S.settings.theme === 'light' ? 'светлая' : 'тёмная');

  const accentLabel = () => ({ blue: 'синий', green: 'зелёный', violet: 'фиолетовый' }[S.settings.accent] || 'синий');

  return { render };
})();

/**
 * Экспорт чатов: Markdown и JSON.
 */
const ChatExport = (() => {
  const markdown = (chat) => {
    const lines = ['# ' + chat.title, '', 'Создан: ' + new Date(chat.createdAt).toISOString(), ''];
    const list = Store.messages(chat.id);
    list.forEach((msg) => {
      const who = msg.role === 'user' ? 'Вы' : msg.role === 'assistant' ? 'Агент' : 'Система';
      lines.push('## ' + who + ' · ' + new Date(msg.ts).toLocaleString('ru-RU'));
      lines.push('');
      if (msg.text) lines.push(msg.text);
      (msg.tools || []).forEach((tool) => {
        lines.push('');
        lines.push('**Инструмент ' + tool.name + '** `' + ((tool.state || {}).status || '') + '`');
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(tool.input || {}, null, 2));
        lines.push('```');
        if (tool.output) {
          lines.push('');
          lines.push('```');
          lines.push(tool.output);
          lines.push('```');
        }
      });
      lines.push('');
    });
    return lines.join('\n');
  };

  const json = (chat) => ({
    format: 'botchat.chat',
    version: 1,
    chat: {
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      model: chat.model,
      provider: chat.provider,
      mode: chat.mode,
    },
    messages: Store.messages(chat.id).map((m) => ({
      role: m.role,
      ts: m.ts,
      text: m.text,
      tools: (m.tools || []).map((t) => ({
        name: t.name,
        input: t.input,
        output: t.output,
        status: (t.state || {}).status,
        metadata: t.metadata,
      })),
      attachments: (m.attachments || []).map((a) => ({ name: a.name, size: a.size, mime: a.mime })),
    })),
  });

  return { markdown, json };
})();

window.Settings2 = Settings2;
window.ChatExport = ChatExport;