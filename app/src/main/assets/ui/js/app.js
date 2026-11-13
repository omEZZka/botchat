'use strict';

/**
 * Действия UI: навигация, чаты, меню сообщений, разрешения, ответы.
 * Никакой сети: делегирует Store/Agent.
 */
const Actions = (() => {
  const go = (route) => {
    if (S.route === route && S.screen !== 'chat') return;
    S.route = route;
    if (route !== 'chats' && S.screen === 'chat') {
      S.screen = 'list';
      S.chatId = null;
    }
    Store.navReset({ name: route });
    if (route === 'search') Store.search(S.search.query || '');
    Bus.emit('render');
  };

  const newChat = async () => {
    const chat = await Store.createChat({ title: 'Новый чат' });
    S.route = 'chats';
    await Store.openChat(chat.id);
    setTimeout(() => Composer.focus(), 120);
  };

  const openChat = async (chatId) => {
    S.route = 'chats';
    await Store.openChat(chatId);
  };

  const openChatAt = async (chatId, msg) => {
    await Store.openChat(chatId);
    setTimeout(() => {
      if (!msg) return;
      const node = U.$('[data-msg="' + msg.id + '"]');
      if (node) {
        node.scrollIntoView({ block: 'center', behavior: U.isReducedMotion() ? 'auto' : 'smooth' });
        node.classList.add('flash');
        setTimeout(() => node.classList.remove('flash'), 1200);
      }
    }, 160);
  };

  const back = () => {
    if (Render.hasSheet()) {
      Render.closeSheet();
      return true;
    }
    if (Store.navPop()) return true;
    if (S.screen === 'chat') {
      Store.closeChat();
      return true;
    }
    if (S.route !== 'chats') {
      go('chats');
      return true;
    }
    return false;
  };

  const togglePin = async (chatId) => {
    await Store.togglePin(chatId);
    Render.toast('Закрепление изменено');
  };

  const toggleArchive = async (chatId) => {
    await Store.toggleArchive(chatId);
    Render.toast('Архив обновлён');
  };

  const confirmDelete = (chatId) => {
    const chat = Store.getChat(chatId);
    Render.confirm({
      title: 'Удалить чат',
      text: 'Чат «' + (chat ? chat.title : '') + '» и его сообщения будут удалены без возможности восстановления.',
      okText: 'Удалить', danger: true,
      onOk: () => Store.deleteChat(chatId),
    });
  };

  const openAttachment = (att) => {
    if (!att || !att.path) {
      Render.toast('Файл недоступен');
      return;
    }
    const content = U.el('div', { class: 'attachment-view' }, [
      U.el('p', { class: 'small', text: att.name || 'файл' }),
      U.el('p', { class: 'muted small', text: U.bytes(att.size || 0) }),
      U.el('button', {
        class: 'btn primary', text: 'Показать текст',
        onclick: async () => {
          const res = await Native.fs.readText(att.path, 256 * 1024);
          if (res && res.ok) {
            content.appendChild(U.el('pre', { class: 'tool-output' }, [U.el('code', { text: res.text })]));
          } else {
            Render.toast('Не удалось прочитать файл');
          }
        },
      }),
    ]);
    Render.openSheet({ title: att.name || 'Вложение', content });
  };

  const replyTo = (msg) => {
    S.pendingReply = {
      id: msg.id,
      author: msg.role === 'user' ? 'Вы' : 'Агент',
      text: msg.text || '',
    };
    Composer.renderReply();
    Composer.focus();
  };

  const messageMenu = (msg) => {
    const items = [];
    items.push(menuItem('copy', 'Копировать', async () => {
      await U.copyToClipboard(msg.text || '');
      Render.closeSheet();
      Render.toast('Скопировано');
    }));
    items.push(menuItem('article', 'Выбрать текст', () => {
      Render.closeSheet();
      selectTextSheet(msg);
    }));
    if (msg.role !== 'system') {
      items.push(menuItem('reply', 'Ответить', () => {
        Render.closeSheet();
        replyTo(msg);
      }));
      items.push(menuItem('forward', 'Переслать', () => {
        Render.closeSheet();
        forwardMessage(msg);
      }));
    }
    if (msg.role === 'assistant') {
      items.push(menuItem('refresh', 'Перегенерировать', () => {
        Render.closeSheet();
        Agent.regenerate(S.chatId, msg.id);
      }));
      items.push(menuItem('play', 'Продолжить генерацию', () => {
        Render.closeSheet();
        Agent.continueGeneration(S.chatId);
      }));
      items.push(menuItem('newChat', 'Новый чат с этого сообщения', () => {
        Render.closeSheet();
        branchFrom(msg);
      }));
      items.push(menuItem('checkpoint', 'Откатить файлы к этому месту', () => {
        Render.closeSheet();
        rollbackTo(msg);
      }));
    }
    items.push(menuItem('article', 'Экспорт чата', () => {
      Render.closeSheet();
      Pickers.exportSheet();
    }));
    const content = U.el('div', { class: 'msg-menu' }, items);
    Render.openSheet({ title: U.truncate(msg.text || 'Сообщение', 40), content });
  };

  /** Режим выделения: обычное выделение включено только здесь. */
  const selectTextSheet = (msg) => {
    const area = U.el('textarea', {
      class: 'field textarea selectable-text',
      rows: 10,
      readonly: 'readonly',
      value: msg.text || '',
    });
    const content = U.el('div', { class: 'confirm' }, [
      U.el('p', {
        class: 'muted small',
        text: 'Выделите нужный фрагмент и скопируйте. В остальных местах выделение отключено, чтобы не мешать.',
      }),
      area,
      U.el('div', { class: 'confirm-actions' }, [
        U.el('button', {
          class: 'btn', text: 'Копировать всё',
          onclick: async () => {
            await U.copyToClipboard(msg.text || '');
            Render.toast('Скопировано');
          },
        }),
        U.el('button', {
          class: 'btn', text: 'Выделить всё',
          onclick: () => {
            area.focus();
            area.select();
          },
        }),
        U.el('button', {
          class: 'btn primary', text: 'Готово',
          onclick: () => Render.closeSheet(),
        }),
      ]),
    ]);
    Render.openSheet({ title: 'Текст сообщения', content });
    setTimeout(() => area.focus(), 120);
  };

  const menuItem = (icon, label, handler) => U.el('button', {
    class: 'menu-item', type: 'button', onclick: handler,
  }, [Icons.make(icon, 18), U.el('span', { text: label })]);

  const forwardMessage = (msg) => {
    const chats = S.chats.filter((c) => c.id !== S.chatId && !c.archived).slice(0, 12);
    const content = U.el('div', { class: 'forward-list' });
    chats.forEach((chat) => {
      content.appendChild(U.el('button', {
        class: 'forward-row', type: 'button',
        onclick: async () => {
          Render.closeSheet();
          await Store.addMessage(chat.id, {
            role: 'user', kind: 'text', text: '(переслано) ' + (msg.text || ''),
            attachments: msg.attachments || [],
          });
          await Store.touchChat(chat.id, { preview: U.truncate(msg.text || '', 80) });
          Render.toast('Переслано в «' + chat.title + '»');
        },
      }, [
        Render.avatar(chat.title, chat.color, 2, chat),
        U.el('span', { class: 'forward-name', text: chat.title }),
      ]));
    });
    if (!chats.length) content.appendChild(U.el('p', { class: 'muted small', text: 'Нет других чатов' }));
    Render.openSheet({ title: 'Переслать', content });
  };

  const branchFrom = async (msg) => {
    const chat = Store.getChat(S.chatId);
    const list = Store.messages(S.chatId);
    const idx = list.findIndex((m) => m.id === msg.id);
    const chatNew = await Store.createChat({
      title: (chat ? chat.title : 'Чат') + ' · ветка',
      mode: chat ? chat.mode : 'agent',
      model: chat ? chat.model : '',
      provider: chat ? chat.provider : '',
    });
    for (let i = 0; i <= idx; i += 1) {
      const m = list[i];
      await Store.addMessage(chatNew.id, {
        role: m.role, kind: m.kind, text: m.text,
        attachments: m.attachments || [], tools: m.tools || [],
      }, { silent: true });
    }
    Render.closeSheet();
    await Store.openChat(chatNew.id);
  };

  const rollbackTo = async (msg) => {
    const checkpoints = await Native.api('checkpoints.list', { chatId: S.chatId });
    const items = (checkpoints && checkpoints.items) || [];
    const candidate = items.filter((c) => c.ts <= msg.ts).pop();
    if (!candidate) {
      Render.toast('Чекпоинт для этого сообщения не найден');
      return;
    }
    Render.confirm({
      title: 'Откат файлов', danger: true,
      text: 'Файлы проекта вернутся к состоянию до сообщения.',
      okText: 'Откатить',
      onOk: async () => {
        const res = await Native.api('checkpoints.restore', { chatId: S.chatId, id: candidate.id });
        Render.toast(res && res.ok ? 'Файлы восстановлены' : 'Не удалось откатить');
      },
    });
  };

  const openChatMenu = () => {
    const chat = Store.getChat(S.chatId);
    if (!chat) return;
    const content = U.el('div', { class: 'chat-menu' }, [
      menuItem(chat.pinned ? 'pin' : 'pin', chat.pinned ? 'Открепить' : 'Закрепить', async () => {
        Render.closeSheet();
        await Store.togglePin(chat.id);
      }),
      menuItem('archive', chat.archived ? 'Вернуть из архива' : 'В архив', async () => {
        Render.closeSheet();
        await Store.toggleArchive(chat.id);
        Store.closeChat();
      }),
      menuItem('settings', 'Настройки чата', () => { Render.closeSheet(); Pickers.chatSettings(); }),
      menuItem('folder', 'Файлы проекта', () => { Render.closeSheet(); FilesUI.openPanel(); }),
      menuItem('checkpoint', 'Чекпоинты', () => { Render.closeSheet(); Pickers.openCheckpoints(chat); }),
      menuItem('sparkle', 'Сжать сессию', () => { Render.closeSheet(); compactSession(); }),
      menuItem('trash', 'Удалить чат', () => { Render.closeSheet(); confirmDelete(chat.id); }),
    ]);
    Render.openSheet({ title: chat.title, content });
  };

  const openChatSheet = () => {
    Pickers.openChatCard(S.chatId);
  };

  const openChatCard = (chatId) => {
    Pickers.openChatCard(chatId);
  };

  const openSettingsSection = (name) => {
    Store.navPush({ name: 'settings', section: name });
    S.route = 'settings';
    S.screen = 'list';
    Bus.emit('render');
  };

  const openAppMenu = () => {
    Pickers.appMenu();
  };

  const openModelSheet = () => {
    ProvidersUI.openModelSheet();
  };

  const compactSession = async () => {
    const chat = Store.getChat(S.chatId);
    if (!chat) return;
    const res = await Native.api('chat.compact', { chatId: chat.id });
    if (res && res.ok) {
      S.compactKeep = res.keep || 12;
      await Store.touchChat(chat.id, { preview: 'Контекст сжат' });
      Render.toast('Контекст сжат: модель получает последние ' + (res.keep || 12) + ' сообщений');
    } else {
      Render.toast('Не удалось сжать сессию');
    }
  };

  const openTaskGraph = () => {
    Pickers.taskGraph();
  };

  const resolvePermission = (decision) => {
    if (S.permissionResolver) S.permissionResolver(decision);
  };

  const handleBack = () => {
    if (SelectMode.isActive()) {
      SelectMode.exit();
      return true;
    }
    const onboarding = U.$('#sheet-host .onboarding');
    if (onboarding) {
      const skip = onboarding.querySelector('.onboarding-skip');
      if (skip) skip.click();
      return true;
    }
    return back() === true;
  };

  const handleIntent = async (action, chatId) => {
    if (action === 'new_chat') {
      await newChat();
      return;
    }
    if (chatId) await openChat(chatId);
  };

  const sendPendingReply = () => {
    const reply = S.pendingReply;
    S.pendingReply = null;
    return reply;
  };

  return {
    go, newChat, openChat, openChatAt, back, togglePin, toggleArchive, confirmDelete,
    openAttachment, replyTo, messageMenu, openChatMenu, openChatSheet, openChatCard, openAppMenu,
    openModelSheet, compactSession, openTaskGraph, resolvePermission, handleBack,
    selectTextSheet,
    handleIntent, sendPendingReply, forwardMessage, openSettingsSection,
  };
})();

/**
 * Акцентные палитры: только CSS-переменные.
 */
const Accent = (() => {
  const map = {
    blue: { acc: '#5b8cff', accSoft: '#1e2a44' },
    green: { acc: '#3fbf6f', accSoft: '#16301f' },
    violet: { acc: '#a06bff', accSoft: '#271b3f' },
  };
  const apply = () => {
    const a = map[S.settings.accent] || map.blue;
    const root = document.documentElement;
    root.style.setProperty('--acc', a.acc);
    root.style.setProperty('--acc-soft', a.accSoft);
    root.dataset.motion = S.settings.reduceMotion ? 'reduced' : '';
  };
  return { apply, map };
})();

window.Actions = Actions;
window.Accent = Accent;