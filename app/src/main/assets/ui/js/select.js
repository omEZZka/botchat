'use strict';

/**
 * Множественный выбор чатов — как в Telegram.
 * Долгое нажатие на строку входит в режим выбора, шапка меняется на панель действий.
 */
const SelectMode = (() => {
  const ids = () => S.select.ids;

  const isActive = () => S.select.active;

  const has = (chatId) => ids().includes(chatId);

  const enter = (chatId) => {
    const current = new Set(ids());
    if (chatId) current.add(chatId);
    S.select = { active: true, ids: Array.from(current) };
    Bus.emit('select:changed', S.select);
    Bus.emit('render');
  };

  const exit = () => {
    if (!S.select.active) return false;
    S.select = { active: false, ids: [] };
    Bus.emit('select:changed', S.select);
    Bus.emit('render');
    return true;
  };

  const toggle = (chatId) => {
    const current = new Set(ids());
    if (current.has(chatId)) current.delete(chatId);
    else current.add(chatId);
    if (!current.size) {
      S.select = { active: false, ids: [] };
    } else {
      S.select = { active: true, ids: Array.from(current) };
    }
    Bus.emit('select:changed', S.select);
    Bus.emit('render');
  };

  const all = () => S.chats.filter((c) => !c.archived).map((c) => c.id);

  const selectAll = () => {
    const everything = all();
    const everySelected = everything.length > 0 && everything.every((id) => has(id));
    S.select = { active: true, ids: everySelected ? [] : everything };
    if (!S.select.ids.length) S.select = { active: false, ids: [] };
    Bus.emit('select:changed', S.select);
    Bus.emit('render');
  };

  const allSelected = () => {
    const everything = all();
    return everything.length > 0 && everything.every((id) => has(id));
  };

  /** Действия над выбранными чатами. */
  const act = async (action) => {
    const selected = ids().slice();
    if (!selected.length) return;
    if (action === 'pin') {
      const chats = selected.map((id) => Store.getChat(id)).filter(Boolean);
      const makePinned = chats.some((c) => !c.pinned);
      for (const chat of chats) {
        if (!!chat.pinned !== makePinned) {
          chat.pinned = makePinned;
          await Store.persistChat(chat);
        }
      }
      Render.toast(makePinned ? 'Закреплено: ' + selected.length : 'Откреплено: ' + selected.length);
      exit();
    } else if (action === 'archive') {
      for (const id of selected) await Store.toggleArchive(id);
      Render.toast('В архиве: ' + selected.length);
      exit();
    } else if (action === 'unread') {
      for (const id of selected) {
        const chat = Store.getChat(id);
        if (chat) {
          chat.unread = chat.unread ? 0 : 1;
          await Store.persistChat(chat);
        }
      }
      Render.toast('Отмечено: ' + selected.length);
      exit();
    } else if (action === 'delete') {
      Render.confirm({
        title: 'Удалить чаты',
        text: 'Будет удалено чатов: ' + selected.length + '. Это действие нельзя отменить.',
        okText: 'Удалить',
        danger: true,
        onOk: async () => {
          for (const id of selected) await Store.deleteChat(id);
          exit();
        },
      });
    }
  };

  /**
   * Долгое нажатие на строку чата: вход в выбор или обычное открытие,
   * если режим выбора уже активен.
   */
  const bindRow = (row, chat) => {
    const open = () => {
      if (isActive()) toggle(chat.id);
      else Actions.openChat(chat.id);
    };
    row.addEventListener('click', (ev) => {
      if (row.dataset.suppressClick === '1') {
        row.dataset.suppressClick = '0';
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      open();
    });
    let timer = null;
    let firedAt = 0;
    const fire = () => {
      const now = Date.now();
      if (now - firedAt < 700) return;
      firedAt = now;
      cancel();
      if (navigator.vibrate) navigator.vibrate(12);
      enter(chat.id);
    };
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    row.addEventListener('touchstart', () => {
      cancel();
      timer = setTimeout(fire, 480);
    }, { passive: true });
    row.addEventListener('touchmove', cancel, { passive: true });
    row.addEventListener('touchend', (ev) => {
      cancel();
      if (firedAt && Date.now() - firedAt < 600) {
        // Долгое нажатие уже сработало: не открываем чат по отпусканию.
        row.dataset.suppressClick = '1';
        ev.preventDefault();
      }
    });
    row.addEventListener('touchcancel', cancel);
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      fire();
    });
  };

  return { isActive, has, enter, exit, toggle, selectAll, allSelected, act, bindRow };
})();

window.SelectMode = SelectMode;
